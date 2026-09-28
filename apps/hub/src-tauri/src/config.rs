//! hub.config.json loading. Lookup order (first found wins):
//!   1. %PEF_HUB_CONFIG%
//!   2. <app config dir>/hub.config.json   (%APPDATA%\com.genesys.ps.pefhub\ - customer override)
//!   3. <resources>/config/hub.config.json (bundled test config)
//!   4. <repo>/config/hub.config.json      (debug builds only)
//! Relative certificate paths are resolved against the config file's folder.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubConfig {
    #[serde(default = "d_bind")]
    pub bind_address: String,
    pub tls: TlsConfig,
    pub pairing_token: String,
    #[serde(default = "d_hb")]
    pub heartbeat_timeout_secs: u64,
    #[serde(default = "d_ttl")]
    pub queue_ttl_secs: u64,
    #[serde(default = "d_search")]
    pub search_timeout_ms: u64,
    #[serde(default)]
    pub routing: RoutingConfig,
    pub pef: PefConfig,
    pub listeners: Vec<ListenerConfig>,
    #[serde(skip)]
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PefConfig {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingConfig {
    /// Interaction attribute (participant data) naming the target crmId.
    #[serde(default = "d_attr")]
    pub attribute_key: String,
    /// queueName -> crmId
    #[serde(default)]
    pub queue_rules: HashMap<String, String>,
    /// "focused" (last focused CRM tab) or "broadcast" (all connected CRMs)
    #[serde(default = "d_fallback")]
    pub fallback: String,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self { attribute_key: d_attr(), queue_rules: HashMap::new(), fallback: d_fallback() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerConfig {
    pub crm_id: String,
    pub port: u16,
    /// Exact origins or prefix patterns ending with '*'. Production: exact chrome-extension://<id>.
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Overrides the global pairing token for this CRM.
    #[serde(default)]
    pub pairing_token: Option<String>,
}

impl ListenerConfig {
    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.allowed_origins.iter().any(|p| match p.strip_suffix('*') {
            Some(prefix) => origin.starts_with(prefix),
            None => p == origin,
        })
    }
}

fn d_bind() -> String { "127.0.0.1".into() }
fn d_hb() -> u64 { 45 }
fn d_ttl() -> u64 { 60 }
fn d_search() -> u64 { 2500 }
fn d_attr() -> String { "crmTarget".into() }
fn d_fallback() -> String { "focused".into() }

pub fn load(app: &AppHandle) -> anyhow::Result<HubConfig> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("PEF_HUB_CONFIG") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(dir) = app.path().app_config_dir() {
        candidates.push(dir.join("hub.config.json"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("config").join("hub.config.json"));
    }
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../config/hub.config.json"));

    let path = candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| anyhow!("hub.config.json not found. Looked in: {candidates:?}"))?;

    let raw = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let mut cfg: HubConfig = serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;

    let base = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    cfg.tls.cert_path = resolve(&base, &cfg.tls.cert_path);
    cfg.tls.key_path = resolve(&base, &cfg.tls.key_path);
    cfg.source = path.display().to_string();

    validate(&cfg)?;
    log::info!("config loaded from {}", cfg.source);
    Ok(cfg)
}

fn resolve(base: &Path, p: &str) -> String {
    let pb = PathBuf::from(p);
    if pb.is_absolute() { p.to_string() } else { base.join(pb).to_string_lossy().into_owned() }
}

fn validate(cfg: &HubConfig) -> anyhow::Result<()> {
    if cfg.listeners.is_empty() {
        bail!("no listeners configured");
    }
    let mut ports = HashSet::new();
    let mut ids = HashSet::new();
    for l in &cfg.listeners {
        if !ports.insert(l.port) {
            bail!("port {} is used by more than one listener", l.port);
        }
        if !ids.insert(l.crm_id.as_str()) {
            bail!("crmId '{}' is declared more than once", l.crm_id);
        }
        if l.allowed_origins.is_empty() {
            bail!("listener '{}' has no allowedOrigins", l.crm_id);
        }
    }
    for (queue, crm) in &cfg.routing.queue_rules {
        if !ids.contains(crm.as_str()) {
            bail!("routing.queueRules['{queue}'] points to unknown crmId '{crm}'");
        }
    }
    Ok(())
}
