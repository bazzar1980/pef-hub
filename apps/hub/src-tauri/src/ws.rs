//! One WSS listener per CRM (multi-port). Each port only accepts its own crmId,
//! from loopback, from allowed origins, with a valid pairing token.
use std::{sync::Arc, time::Duration};

use anyhow::bail;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    Message,
};

use crate::{
    config::ListenerConfig,
    protocol::{Envelope, PROTOCOL_VERSION},
    router::Hub,
};

pub async fn serve(listener_cfg: ListenerConfig, tls: TlsAcceptor, hub: Arc<Hub>) {
    let addr = format!("{}:{}", hub.cfg.bind_address, listener_cfg.port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[{}] cannot bind {addr}: {e}", listener_cfg.crm_id);
            hub.set_listener(&listener_cfg.crm_id, false, Some(format!("cannot bind {addr}: {e}")));
            return;
        }
    };
    log::info!("[{}] listening on wss://{addr}", listener_cfg.crm_id);
    hub.set_listener(&listener_cfg.crm_id, true, None);

    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[{}] accept failed: {e}", listener_cfg.crm_id);
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            log::warn!("[{}] rejected non-loopback peer {peer}", listener_cfg.crm_id);
            continue;
        }
        let (tls, hub, cfg) = (tls.clone(), Arc::clone(&hub), listener_cfg.clone());
        tokio::spawn(async move {
            let crm_id = cfg.crm_id.clone();
            if let Err(e) = handle(tcp, tls, hub, cfg).await {
                log::warn!("[{crm_id}] connection ended: {e:#}");
            }
        });
    }
}

async fn handle(tcp: TcpStream, tls: TlsAcceptor, hub: Arc<Hub>, cfg: ListenerConfig) -> anyhow::Result<()> {
    let stream = tls.accept(tcp).await?;

    let origin_check = cfg.clone();
    let ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        if origin_check.origin_allowed(origin) {
            Ok(resp)
        } else {
            log::warn!("[{}] origin '{origin}' not allowed", origin_check.crm_id);
            let mut r = ErrorResponse::new(Some("origin not allowed".into()));
            *r.status_mut() = StatusCode::FORBIDDEN;
            Err(r)
        }
    })
    .await?;

    let (mut sink, mut stream) = ws.split();

    // 1) hello within 5s
    let hello: Envelope = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str(&t)?,
        _ => bail!("hello not received"),
    };
    if let Err(reason) = validate_hello(&hello, &cfg, &hub) {
        let err = Envelope::new("error", json!({ "code": "hello_rejected", "reason": reason }));
        let _ = sink.send(Message::Text(err.to_json())).await;
        let _ = sink.close().await;
        bail!("hello rejected: {reason}");
    }

    // 2) register session, writer task drains the outbound channel
    let session_id = uuid::Uuid::new_v4().to_string();
    let sdk = hello.payload.get("sdkVersion").and_then(|v| v.as_str()).unwrap_or("?").to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    hub.register(&session_id, &cfg.crm_id, sdk, tx);

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(Message::Text(m)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 3) read loop, heartbeat timeout detects dead extensions
    let timeout = Duration::from_secs(hub.cfg.heartbeat_timeout_secs);
    loop {
        match tokio::time::timeout(timeout, stream.next()).await {
            Err(_) => {
                log::warn!("[{}] heartbeat timeout", cfg.crm_id);
                break;
            }
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<Envelope>(&t) {
                Ok(env) => hub.on_crm_message(&cfg.crm_id, &session_id, env),
                Err(e) => log::warn!("[{}] invalid message: {e}", cfg.crm_id),
            },
            Ok(Some(Ok(_))) => {}
        }
    }

    hub.unregister(&session_id);
    writer.abort();
    Ok(())
}

fn validate_hello(h: &Envelope, cfg: &ListenerConfig, hub: &Hub) -> Result<(), String> {
    if h.kind != "hello" {
        return Err("first message must be hello".into());
    }
    if h.v != PROTOCOL_VERSION {
        return Err(format!("unsupported protocol v{} (hub speaks v{PROTOCOL_VERSION})", h.v));
    }
    let crm = h.payload.get("crmId").and_then(|v| v.as_str()).unwrap_or("");
    if crm != cfg.crm_id {
        return Err(format!("crmId '{crm}' is not allowed on port {} (expected '{}')", cfg.port, cfg.crm_id));
    }
    let token = h.payload.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if token != hub.token_for(&cfg.crm_id) {
        return Err("invalid pairing token".into());
    }
    Ok(())
}
