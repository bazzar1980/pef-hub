//! Stateful core of the hub: CRM sessions, interaction ownership, routing,
//! offline queue with TTL, contact-search fan-out. Adapters stay stateless.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::UnboundedSender;

use crate::{
    config::HubConfig,
    protocol::{Envelope, PROTOCOL_VERSION},
};

/// An outbound call started from CRM X within this window belongs to CRM X.
const DIAL_OWNERSHIP_WINDOW: Duration = Duration::from_secs(30);
const INTERACTION_MAX_AGE: Duration = Duration::from_secs(12 * 3600);

struct Session {
    crm_id: String,
    tx: UnboundedSender<String>,
    tabs: Value,
    last_focus_at: u64,
    connected_at: u64,
    sdk_version: String,
}

struct Tracked {
    owner: Option<String>,
    interaction: Value,
    updated: Instant,
}

struct Queued {
    crm_id: String,
    env: Envelope,
    expires: Instant,
}

struct PendingSearch {
    waiting: HashSet<String>,
    results: Vec<Value>,
}

#[derive(Default, Clone)]
struct ListenerStatus {
    listening: bool,
    error: Option<String>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    interactions: HashMap<String, Tracked>,
    queue: Vec<Queued>,
    searches: HashMap<String, PendingSearch>,
    pef_state: Value,
    listeners: HashMap<String, ListenerStatus>,
    pending_dial: Option<(String, Instant)>,
}

pub struct Hub {
    app: AppHandle,
    pub cfg: HubConfig,
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_outbound(ix: &Value) -> bool {
    ix.get("direction").and_then(Value::as_str).is_some_and(|d| d.eq_ignore_ascii_case("outbound"))
}

fn tag_source(result: &mut Value, crm_id: &str) {
    if let Some(obj) = result.as_object_mut() {
        let attrs = obj.entry("attributes").or_insert_with(|| json!({}));
        if let Some(a) = attrs.as_object_mut() {
            a.insert("pefHubCrm".into(), json!(crm_id));
        }
    }
}

impl Hub {
    pub fn new(app: AppHandle, cfg: HubConfig) -> Self {
        let inner = Inner { pef_state: json!({ "loggedIn": false }), ..Default::default() };
        Self { app, cfg, inner: Mutex::new(inner) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn token_for(&self, crm_id: &str) -> String {
        self.cfg
            .listeners
            .iter()
            .find(|l| l.crm_id == crm_id)
            .and_then(|l| l.pairing_token.clone())
            .unwrap_or_else(|| self.cfg.pairing_token.clone())
    }

    pub fn set_listener(&self, crm_id: &str, listening: bool, error: Option<String>) {
        self.lock().listeners.insert(crm_id.to_string(), ListenerStatus { listening, error });
        self.emit_status();
    }

    // ---------------------------------------------------------------- sessions

    pub fn register(&self, session_id: &str, crm_id: &str, sdk_version: String, tx: UnboundedSender<String>) {
        let (welcome, flush) = {
            let mut g = self.lock();
            g.sessions.insert(
                session_id.to_string(),
                Session {
                    crm_id: crm_id.to_string(),
                    tx: tx.clone(),
                    tabs: json!([]),
                    last_focus_at: 0,
                    connected_at: now_ms(),
                    sdk_version,
                },
            );
            let snapshot = Self::snapshot_for(&g, crm_id);
            let now = Instant::now();
            let mut flush = Vec::new();
            g.queue.retain(|q| {
                if q.expires <= now {
                    false
                } else if q.crm_id == crm_id {
                    flush.push(q.env.clone());
                    false
                } else {
                    true
                }
            });
            let welcome = Envelope::new(
                "welcome",
                json!({
                    "sessionId": session_id,
                    "protocolVersion": PROTOCOL_VERSION,
                    "pefState": g.pef_state.clone(),
                    "snapshot": snapshot
                }),
            );
            (welcome, flush)
        };
        let _ = tx.send(welcome.to_json());
        if !flush.is_empty() {
            log::info!("[{crm_id}] delivering {} queued event(s)", flush.len());
        }
        for env in flush {
            let _ = tx.send(env.to_json());
        }
        log::info!("[{crm_id}] session {session_id} registered");
        self.emit_status();
    }

    pub fn unregister(self: &Arc<Self>, session_id: &str) {
        let finished: Vec<String> = {
            let mut g = self.lock();
            let inner = &mut *g;
            if let Some(s) = inner.sessions.remove(session_id) {
                log::info!("[{}] session {session_id} closed", s.crm_id);
            }
            inner
                .searches
                .iter_mut()
                .filter_map(|(rid, s)| (s.waiting.remove(session_id) && s.waiting.is_empty()).then(|| rid.clone()))
                .collect()
        };
        for rid in finished {
            self.finish_search(&rid);
        }
        self.emit_status();
    }

    fn snapshot_for(g: &Inner, crm_id: &str) -> Value {
        let list: Vec<Value> = g
            .interactions
            .iter()
            .filter(|(_, t)| t.owner.as_deref().map_or(true, |o| o == crm_id))
            .map(|(id, t)| json!({ "id": id, "ownerCrm": t.owner, "interaction": t.interaction }))
            .collect();
        json!({ "interactions": list })
    }

    /// Most recently focused (then most recent) session for each CRM.
    fn best_per_crm(g: &Inner) -> Vec<(String, String, UnboundedSender<String>)> {
        let mut best: HashMap<&str, (&String, &Session)> = HashMap::new();
        for (sid, s) in &g.sessions {
            let replace = match best.get(s.crm_id.as_str()) {
                Some((_, b)) => (s.last_focus_at, s.connected_at) > (b.last_focus_at, b.connected_at),
                None => true,
            };
            if replace {
                best.insert(s.crm_id.as_str(), (sid, s));
            }
        }
        best.into_values().map(|(sid, s)| (sid.clone(), s.crm_id.clone(), s.tx.clone())).collect()
    }

    fn focused_crm(&self) -> Option<String> {
        let g = self.lock();
        g.sessions.values().filter(|s| s.last_focus_at > 0).max_by_key(|s| s.last_focus_at).map(|s| s.crm_id.clone())
    }

    // ---------------------------------------------------------------- CRM -> hub

    pub fn on_crm_message(self: &Arc<Self>, crm_id: &str, session_id: &str, env: Envelope) {
        match env.kind.as_str() {
            "heartbeat" => {
                let (tx, pef) = {
                    let mut g = self.lock();
                    let pef = g.pef_state.clone();
                    let tx = g.sessions.get_mut(session_id).map(|s| {
                        if let Some(tabs) = env.payload.get("tabs") {
                            s.last_focus_at = tabs
                                .as_array()
                                .and_then(|a| a.iter().filter_map(|t| t.get("lastFocusAt").and_then(Value::as_u64)).max())
                                .unwrap_or(0);
                            s.tabs = tabs.clone();
                        }
                        s.tx.clone()
                    });
                    (tx, pef)
                };
                if let Some(tx) = tx {
                    let _ = tx.send(Envelope::new("heartbeatAck", json!({ "pefState": pef })).to_json());
                }
                self.emit_status();
            }
            "snapshotRequest" => {
                let (tx, snapshot) = {
                    let g = self.lock();
                    (g.sessions.get(session_id).map(|s| s.tx.clone()), Self::snapshot_for(&g, crm_id))
                };
                if let Some(tx) = tx {
                    let _ = tx.send(Envelope::new("snapshot", snapshot).tab(env.tab_id.clone()).to_json());
                }
            }
            "clickToDial" => {
                self.lock().pending_dial = Some((crm_id.to_string(), Instant::now()));
                self.log_event(&format!("{crm_id} -> PEF clickToDial"));
                self.to_pef(json!({ "type": "clickToDial", "data": env.payload }));
            }
            "contactSearchResult" => {
                let Some(rid) = env.correlation_id.clone() else { return };
                let finished = {
                    let mut g = self.lock();
                    match g.searches.get_mut(&rid) {
                        Some(s) => {
                            if !s.waiting.remove(session_id) {
                                false
                            } else {
                                if let Some(arr) = env.payload.get("results").and_then(Value::as_array) {
                                    for r in arr {
                                        let mut r = r.clone();
                                        tag_source(&mut r, crm_id);
                                        s.results.push(r);
                                    }
                                }
                                s.waiting.is_empty()
                            }
                        }
                        None => false,
                    }
                };
                if finished {
                    self.finish_search(&rid);
                }
            }
            "callLogResult" | "focusRecord" => log::debug!("[{crm_id}] {}: {}", env.kind, env.payload),
            other => log::warn!("[{crm_id}] unknown message type '{other}'"),
        }
    }

    // ---------------------------------------------------------------- PEF -> hub

    pub fn on_pef_message(self: &Arc<Self>, msg: Value) {
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let data = msg.get("data").cloned().unwrap_or(Value::Null);

        match kind.as_str() {
            "screenPop" => {
                let ix = data.get("interaction").cloned().unwrap_or(Value::Null);
                let target = self.resolve_target(&ix);
                if let (Some(id), Some(crm)) = (ix.get("id").and_then(Value::as_str), target.as_deref()) {
                    self.set_owner(id, crm, &ix);
                }
                self.log_event(&format!("PEF screenPop -> {}", target.as_deref().unwrap_or("all CRMs")));
                self.route(target, Envelope::new("screenPop", data), true);
            }
            "processCallLog" | "openCallLog" => {
                let owner = data
                    .pointer("/interaction/id")
                    .and_then(Value::as_str)
                    .and_then(|id| self.lock().interactions.get(id).and_then(|t| t.owner.clone()));
                let target = owner.or_else(|| self.focused_crm());
                self.log_event(&format!("PEF {kind} -> {}", target.as_deref().unwrap_or("all CRMs")));
                self.route(target, Envelope::new(&kind, data), true);
            }
            "interactionSubscription" => {
                let category = data.get("category").and_then(Value::as_str).unwrap_or("").to_string();
                let ix = data.get("interaction").cloned().unwrap_or(Value::Null);
                let Some(id) = ix.get("id").and_then(Value::as_str).map(str::to_string) else { return };
                let owner = {
                    let mut g = self.lock();
                    let inner = &mut *g;
                    let t = inner
                        .interactions
                        .entry(id.clone())
                        .or_insert_with(|| Tracked { owner: None, interaction: Value::Null, updated: Instant::now() });
                    t.interaction = ix.clone();
                    t.updated = Instant::now();
                    if t.owner.is_none() && is_outbound(&ix) {
                        if let Some((crm, at)) = inner.pending_dial.take() {
                            if at.elapsed() < DIAL_OWNERSHIP_WINDOW {
                                t.owner = Some(crm);
                            }
                        }
                    }
                    let owner = t.owner.clone();
                    if category == "deallocate" {
                        inner.interactions.remove(&id);
                    }
                    owner
                };
                self.route(owner, Envelope::new("interactionUpdate", json!({ "category": category, "interaction": ix })), false);
                self.emit_status();
            }
            "contactSearch" => {
                let rid = data
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let search = data.get("searchString").cloned().unwrap_or(Value::Null);
                let targets = Self::best_per_crm(&self.lock());
                if targets.is_empty() {
                    self.to_pef(json!({ "type": "contactSearchResult", "data": { "requestId": rid, "results": [] } }));
                    return;
                }
                self.lock().searches.insert(
                    rid.clone(),
                    PendingSearch { waiting: targets.iter().map(|(sid, _, _)| sid.clone()).collect(), results: Vec::new() },
                );
                self.log_event(&format!("PEF contactSearch -> {} CRM(s)", targets.len()));
                for (_, _, tx) in &targets {
                    let env = Envelope::new("contactSearch", json!({ "searchString": search })).correlation(Some(rid.clone()));
                    let _ = tx.send(env.to_json());
                }
                let hub = Arc::clone(self);
                let timeout = Duration::from_millis(self.cfg.search_timeout_ms);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(timeout).await;
                    hub.finish_search(&rid);
                });
            }
            "pefState" => {
                let txs: Vec<UnboundedSender<String>> = {
                    let mut g = self.lock();
                    g.pef_state = data.clone();
                    g.sessions.values().map(|s| s.tx.clone()).collect()
                };
                for tx in txs {
                    let _ = tx.send(Envelope::new("heartbeatAck", json!({ "pefState": data })).to_json());
                }
                self.emit_status();
            }
            other => log::debug!("PEF message '{other}' not routed"),
        }
    }

    fn resolve_target(&self, ix: &Value) -> Option<String> {
        let r = &self.cfg.routing;
        let known = |c: &str| self.cfg.listeners.iter().any(|l| l.crm_id == c);
        let key = r.attribute_key.to_ascii_lowercase();
        if let Some(attrs) = ix.get("attributes").and_then(Value::as_object) {
            for (k, v) in attrs {
                let k = k.to_ascii_lowercase();
                if k == key || k.ends_with(&format!(".{key}")) {
                    if let Some(c) = v.as_str().filter(|c| known(c)) {
                        return Some(c.to_string());
                    }
                }
            }
        }
        if let Some(c) = ix.get("queueName").and_then(Value::as_str).and_then(|q| r.queue_rules.get(q)) {
            return Some(c.clone());
        }
        match r.fallback.as_str() {
            "broadcast" => None,
            _ => self.focused_crm(),
        }
    }

    fn set_owner(&self, id: &str, crm: &str, ix: &Value) {
        let mut g = self.lock();
        let t = g
            .interactions
            .entry(id.to_string())
            .or_insert_with(|| Tracked { owner: None, interaction: ix.clone(), updated: Instant::now() });
        if t.owner.is_none() {
            t.owner = Some(crm.to_string());
        }
    }

    /// Some(crm): deliver to that CRM's best session, queue (TTL) if offline and allowed.
    /// None: deliver to every connected CRM.
    fn route(&self, target: Option<String>, env: Envelope, queue_if_offline: bool) {
        let mut g = self.lock();
        match target {
            Some(crm) => {
                let best = g
                    .sessions
                    .values()
                    .filter(|s| s.crm_id == crm)
                    .max_by_key(|s| (s.last_focus_at, s.connected_at))
                    .map(|s| s.tx.clone());
                match best {
                    Some(tx) => {
                        let _ = tx.send(env.to_json());
                    }
                    None if queue_if_offline => {
                        log::info!("[{crm}] offline, queueing {} for {}s", env.kind, self.cfg.queue_ttl_secs);
                        let expires = Instant::now() + Duration::from_secs(self.cfg.queue_ttl_secs);
                        g.queue.push(Queued { crm_id: crm, env, expires });
                    }
                    None => {}
                }
            }
            None => {
                for (_, _, tx) in Self::best_per_crm(&g) {
                    let _ = tx.send(env.to_json());
                }
            }
        }
    }

    fn finish_search(&self, rid: &str) {
        let Some(s) = self.lock().searches.remove(rid) else { return };
        self.to_pef(json!({ "type": "contactSearchResult", "data": { "requestId": rid, "results": s.results } }));
    }

    // ---------------------------------------------------------------- UI

    fn to_pef(&self, payload: Value) {
        let _ = self.app.emit("to-pef", payload);
    }

    fn log_event(&self, text: &str) {
        log::info!("{text}");
        let _ = self.app.emit("hub-log", json!({ "at": now_ms(), "text": text }));
    }

    pub fn emit_status(&self) {
        let _ = self.app.emit("hub-status", self.status());
    }

    pub fn status(&self) -> Value {
        let g = self.lock();
        let listeners: Vec<Value> = self
            .cfg
            .listeners
            .iter()
            .map(|l| {
                let st = g.listeners.get(&l.crm_id).cloned().unwrap_or_default();
                let sessions: Vec<Value> = g
                    .sessions
                    .iter()
                    .filter(|(_, s)| s.crm_id == l.crm_id)
                    .map(|(sid, s)| {
                        json!({
                            "sessionId": sid,
                            "sdkVersion": s.sdk_version,
                            "connectedAt": s.connected_at,
                            "lastFocusAt": s.last_focus_at,
                            "tabs": s.tabs
                        })
                    })
                    .collect();
                json!({ "crmId": l.crm_id, "port": l.port, "listening": st.listening, "error": st.error, "sessions": sessions })
            })
            .collect();
        json!({
            "listeners": listeners,
            "pefState": g.pef_state,
            "interactions": g.interactions.len(),
            "queued": g.queue.len(),
            "bindAddress": self.cfg.bind_address,
            "configSource": self.cfg.source
        })
    }

    pub fn spawn_housekeeping(self: &Arc<Self>) {
        let hub = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                let changed = {
                    let mut g = hub.lock();
                    let before = (g.queue.len(), g.interactions.len());
                    let now = Instant::now();
                    g.queue.retain(|q| q.expires > now);
                    g.interactions.retain(|_, t| t.updated.elapsed() < INTERACTION_MAX_AGE);
                    before != (g.queue.len(), g.interactions.len())
                };
                if changed {
                    hub.emit_status();
                }
            }
        });
    }
}

// -------------------------------------------------------------------- commands

#[tauri::command]
pub fn from_pef(hub: State<'_, Arc<Hub>>, msg: Value) {
    hub.on_pef_message(msg);
}

#[tauri::command]
pub fn hub_status(hub: State<'_, Arc<Hub>>) -> Value {
    hub.status()
}

#[tauri::command]
pub fn get_ui_config(hub: State<'_, Arc<Hub>>) -> Value {
    json!({ "pefUrl": hub.cfg.pef.url })
}
