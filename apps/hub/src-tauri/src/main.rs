#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod protocol;
mod router;
mod tls;
mod ws;

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use router::Hub;

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Genesys Cloud region domain derived from the PEF URL: apps.mypurecloud.ie -> mypurecloud.ie.
fn region_domain(pef_url: &str) -> Option<String> {
    let host = Url::parse(pef_url).ok()?.host_str()?.to_owned();
    host.split_once('.').map(|(_, domain)| domain.to_owned())
}

/// Main window. Built in code (not tauri.conf.json) to install a new-window handler: without one,
/// WebView2 drops every window.open, including the PEF login popup (dedicatedLoginWindow).
fn build_main_window(app: &tauri::App, pef_url: &str) -> tauri::Result<()> {
    let domain = region_domain(pef_url);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("PEF Hub")
        .inner_size(780.0, 860.0)
        .min_inner_size(700.0, 600.0)
        .use_https_scheme(true)
        .on_new_window(move |url, _features| {
            let host = url.host_str().unwrap_or_default();
            let allowed = domain.as_deref().is_some_and(|d| url.scheme() == "https" && (host == d || host.ends_with(&format!(".{d}"))));
            if allowed {
                log::info!("popup allowed: {url}");
                NewWindowResponse::Allow
            } else {
                log::warn!("popup denied: {url}");
                NewWindowResponse::Deny
            }
        })
        .build()?;
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show PEF Hub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new().tooltip("PEF Hub").menu(&menu).on_menu_event(|app, event| match event.id.as_ref() {
        "show" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        // Second launch = focus the running hub (ports can only be bound once).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .setup(|app| {
            let cfg = config::load(app.handle()).map_err(|e| format!("{e:#}"))?;
            let acceptor = tls::load_acceptor(&cfg.tls.cert_path, &cfg.tls.key_path).map_err(|e| format!("{e:#}"))?;

            let hub = Arc::new(Hub::new(app.handle().clone(), cfg.clone()));
            app.manage(hub.clone());

            for listener in cfg.listeners.clone() {
                tauri::async_runtime::spawn(ws::serve(listener, acceptor.clone(), hub.clone()));
            }
            hub.spawn_housekeeping();
            build_main_window(app, &cfg.pef.url)?;
            build_tray(app)?;
            Ok(())
        })
        // Closing the window keeps the hub running in the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![router::from_pef, router::hub_status, router::get_ui_config])
        .run(tauri::generate_context!())
        .expect("error while running PEF Hub");
}
