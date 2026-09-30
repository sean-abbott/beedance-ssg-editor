//! The zola serve sidecar process, its preview window (an iframe pointed at
//! the running server), and the separate log window showing its stdout/
//! stderr.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::content::resolve_preview_path;
use crate::site::site_dir;

pub const PREVIEW_LABEL: &str = "preview";
// "idiomatic average web page" desktop viewport, and a common phone reference size.
const DESKTOP_PREVIEW_SIZE: (f64, f64) = (1280.0, 800.0);
const PHONE_PREVIEW_SIZE: (f64, f64) = (390.0, 844.0);

pub const LOG_LABEL: &str = "log";
const LOG_WINDOW_SIZE: (f64, f64) = (640.0, 480.0);

pub struct ServeState(pub Mutex<Option<CommandChild>>);

/// The port the CURRENT (or most recent) zola_serve run picked - a fresh
/// free port every time (see pick_free_port), not a fixed one. Needed so a
/// reused preview window (open_or_focus_preview_window) and the frontend's
/// LAN-address display know what port actually applies right now.
pub struct PreviewPortState(pub Mutex<Option<u16>>);

/// Asks the OS for a free port instead of assuming a fixed one is available -
/// found the hard way testing on a real Mac that a stale zola process (or,
/// in principle, anything else) already holding a fixed port could make a
/// fresh serve attempt silently bind nothing new, while wait_for_port below
/// still saw *something* listening and reported success. A small TOCTOU race
/// exists between closing this probe listener and zola binding the same
/// port, same as any tool using this pattern - acceptable for a local
/// desktop app talking to its own sidecar process.
fn pick_free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())
}

/// Backlog of the current zola serve run's log lines, so the log window
/// shows what already happened when opened after the fact - "zola-log" is a
/// plain event with no history, so a window that starts listening late would
/// otherwise see nothing until the next line comes in (which may be never,
/// if the server started cleanly and nothing has triggered a rebuild since).
/// Bounded so a long-running preview session doesn't grow this forever.
const LOG_BACKLOG_LIMIT: usize = 500;
pub struct LogBacklog(pub Mutex<Vec<String>>);

#[tauri::command]
pub async fn zola_version(app: tauri::AppHandle) -> Result<String, String> {
    let sidecar = app.shell().sidecar("zola").map_err(|e| e.to_string())?;
    let output = sidecar
        .args(["--version"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Polls the port zola serve binds to rather than guessing a fixed delay -
/// spawn() returns as soon as the process starts, well before it's actually
/// listening, which is what caused the "Connection refused" race.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[derive(serde::Serialize, Clone, Copy)]
struct PreviewNavigatePayload<'a> {
    path: &'a str,
    port: u16,
}

fn open_or_focus_preview_window(app: &tauri::AppHandle, target_path: Option<&str>, port: u16) -> Result<(), String> {
    let target = target_path.unwrap_or("/");

    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        win.set_focus().map_err(|e| e.to_string())?;
        // Window's already open (e.g. hitting "Start preview" again after
        // switching tabs, or after a site switch, which always picks a
        // fresh port) - navigate its iframe rather than needing it
        // reopened, since the initial nav script below only runs on
        // creation. Always sends the CURRENT port - the window may have
        // been created for an earlier, now-dead port.
        let _ = win.emit("preview-navigate", PreviewNavigatePayload { path: target, port });
        return Ok(());
    }

    let target_json = serde_json::to_string(target).map_err(|e| e.to_string())?;
    let builder = WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App("preview.html".into()))
        .title("Preview")
        .inner_size(DESKTOP_PREVIEW_SIZE.0, DESKTOP_PREVIEW_SIZE.1)
        .initialization_script(&format!(
            "window.__BEEDANCE_PREVIEW_TARGET__ = {target_json}; window.__BEEDANCE_PREVIEW_PORT__ = {port};"
        ));

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

/// Opens the log window if it isn't already, or just focuses the existing
/// one. Live updates come from log.html's own listener on the "zola-log"
/// event this app already emits - the backlog replay here only covers lines
/// that arrived before this window existed to hear them (e.g. preview was
/// already running when this button was clicked).
#[tauri::command]
pub fn open_log_window(app: tauri::AppHandle, backlog: tauri::State<LogBacklog>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LOG_LABEL) {
        return win.set_focus().map_err(|e| e.to_string());
    }

    let backlog_json = serde_json::to_string(&*backlog.0.lock().unwrap()).map_err(|e| e.to_string())?;

    WebviewWindowBuilder::new(&app, LOG_LABEL, WebviewUrl::App("log.html".into()))
        .title("Preview log")
        .inner_size(LOG_WINDOW_SIZE.0, LOG_WINDOW_SIZE.1)
        .initialization_script(&format!("window.__BEEDANCE_LOG_BACKLOG__ = {backlog_json};"))
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn zola_serve(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServeState>,
    port_state: tauri::State<'_, PreviewPortState>,
    backlog: tauri::State<'_, LogBacklog>,
    network: bool,
    current_content_path: Option<String>,
) -> Result<String, String> {
    // Stop any previous instance first so repeated clicks don't fight over the port.
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }

    backlog.0.lock().unwrap().clear();
    let _ = app.emit("zola-log-reset", ());

    // A fresh free port every run, not a fixed one - see pick_free_port.
    let port = pick_free_port()?;
    *port_state.0.lock().unwrap() = Some(port);

    let mut args = vec!["serve".to_string(), "--port".to_string(), port.to_string()];
    if network {
        // Binding 0.0.0.0 still answers on 127.0.0.1 too, so wait_for_port
        // below needs no change. base-url also needs to follow, or asset/
        // live-reload URLs Zola injects stay pinned to 127.0.0.1 and silently
        // fail to load from another device on the LAN (per Zola's own docs).
        let lan_ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;
        args.push("--interface".to_string());
        args.push("0.0.0.0".to_string());
        args.push("--base-url".to_string());
        args.push(format!("http://{lan_ip}:{port}"));
    }

    let sidecar = app.shell().sidecar("zola").map_err(|e| e.to_string())?;
    let (mut rx, child) = sidecar
        .current_dir(site_dir())
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(child);

    // Forward zola's own stdout/stderr to the frontend instead of discarding
    // it - a failed start (e.g. a configured theme that was never vendored)
    // otherwise just looks like an unexplained connection-refused later.
    let log_app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    Some(String::from_utf8_lossy(&bytes).to_string())
                }
                CommandEvent::Error(err) => Some(format!("error: {err}")),
                CommandEvent::Terminated(payload) => Some(format!("zola serve exited: {payload:?}")),
                _ => None,
            };
            if let Some(line) = line {
                if let Some(backlog) = log_app.try_state::<LogBacklog>() {
                    let mut lines = backlog.0.lock().unwrap();
                    lines.push(line.clone());
                    if lines.len() > LOG_BACKLOG_LIMIT {
                        let excess = lines.len() - LOG_BACKLOG_LIMIT;
                        lines.drain(..excess);
                    }
                }
                let _ = log_app.emit("zola-log", line);
            }
        }
    });

    // wait_for_port's polling loop uses a blocking std::thread::sleep - this
    // command runs on the main thread by default (it wasn't `async fn`
    // before), so that loop used to freeze the whole app's UI for up to 5s
    // every time preview started. spawn_blocking moves it off the main
    // thread; the command staying `async fn` is what makes that possible.
    let port_ready = tauri::async_runtime::spawn_blocking(move || wait_for_port(port, Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?;
    if !port_ready {
        return Err(format!(
            "zola serve did not start listening on 127.0.0.1:{port} within 5s - open Preview log for the actual error"
        ));
    }
    let target_path = current_content_path.and_then(resolve_preview_path);
    open_or_focus_preview_window(&app, target_path.as_deref(), port)?;

    if network {
        let lan_ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;
        Ok(format!(
            "zola serve started on http://127.0.0.1:{port} (also reachable on your network at http://{lan_ip}:{port})"
        ))
    } else {
        Ok(format!("zola serve started on http://127.0.0.1:{port}"))
    }
}

/// Best-guess LAN IP for this machine, so the Settings panel can show a
/// clickable-looking address before the user even starts the preview server.
#[tauri::command]
pub fn get_lan_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zola_stop(app: tauri::AppHandle, state: tauri::State<ServeState>) -> Result<String, String> {
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = win.close();
    }

    match state.0.lock().unwrap().take() {
        Some(child) => {
            child.kill().map_err(|e| e.to_string())?;
            Ok("stopped".to_string())
        }
        None => Ok("nothing running".to_string()),
    }
}

#[tauri::command]
pub fn set_preview_phone_mode(app: tauri::AppHandle, phone: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(PREVIEW_LABEL)
        .ok_or_else(|| "preview window is not open".to_string())?;
    let (w, h) = if phone { PHONE_PREVIEW_SIZE } else { DESKTOP_PREVIEW_SIZE };
    win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())
}
