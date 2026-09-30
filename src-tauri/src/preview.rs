//! The zola serve sidecar process, its preview window (navigated directly at
//! the running server - see open_or_focus_preview_window's own comment for
//! why this isn't an iframe), and the separate log window showing its
//! stdout/stderr.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder};
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

// A floating, self-contained toolbar (Back/Forward/Reload) injected directly
// into whatever page the preview window is showing - inline styles only, no
// dependency on this app's own styles.css (not loaded here at all) or any
// asset that might not resolve against an arbitrary site's own base URL.
// Deferred to DOMContentLoaded since initialization_script runs before the
// document is parsed, well before `document.body` exists.
const PREVIEW_TOOLBAR_SCRIPT: &str = r#"
(function () {
  function init() {
    var bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;top:8px;left:8px;z-index:2147483647;display:flex;" +
      "gap:2px;background:rgba(30,30,32,0.85);border-radius:8px;padding:4px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;";
    var mkButton = function (label, title, onClick) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText =
        "all:unset;cursor:pointer;color:#fff;font-size:15px;line-height:1;" +
        "padding:5px 9px;border-radius:6px;transition:background-color 0.15s ease;";
      btn.addEventListener("mouseenter", function () {
        btn.style.backgroundColor = "rgba(255,255,255,0.18)";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.backgroundColor = "transparent";
      });
      btn.addEventListener("click", onClick);
      return btn;
    };
    var reloadBtn = mkButton("↻", "Reload", function () {
      // A brief visible flash before actually reloading - clicking Reload
      // tore down this whole toolbar with no feedback otherwise (the new
      // page's own redraw was the only signal, easy to miss/attribute to
      // something else) - Sean/Dave: "reload might or might not work, no
      // visual indicator". The flash itself doesn't need to survive the
      // reload; it only has to be visible for the brief moment before it.
      reloadBtn.style.backgroundColor = "rgba(255,255,255,0.35)";
      setTimeout(function () {
        window.location.reload();
      }, 120);
    });
    bar.appendChild(mkButton("←", "Back", function () {
      window.history.back();
    }));
    bar.appendChild(mkButton("→", "Forward", function () {
      window.history.forward();
    }));
    bar.appendChild(reloadBtn);
    document.documentElement.appendChild(bar);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
"#;

/// Points the preview window straight at zola's own served URL - NOT an
/// iframe inside a wrapper page (the original design, kept until 2026-09-30).
/// That wrapper's Back/Forward/Reload had to operate on frame.contentWindow
/// across a real origin boundary (the wrapper is this app's own tauri://
/// origin; the iframe is http://127.0.0.1:<port>) - history.back()/forward()
/// are spec-legal cross-origin, but confirmed broken in practice by two
/// separate real users, and Reload couldn't know the iframe's actual current
/// path at all (cross-origin location reads are blocked), so it kept
/// reloading wherever the app last explicitly pointed it rather than
/// wherever the user had since clicked to. Navigating the WINDOW itself
/// removes the origin boundary entirely - the toolbar (PREVIEW_TOOLBAR_SCRIPT,
/// re-injected fresh via initialization_script on every top-level navigation
/// in this window, including ones from clicking a link inside the site, not
/// just app-driven ones) calls plain same-origin history/location APIs, no
/// different from any ordinary browser tab.
fn open_or_focus_preview_window(app: &tauri::AppHandle, target_path: Option<&str>, port: u16) -> Result<(), String> {
    let target = target_path.unwrap_or("/");
    let separator = if target.contains('?') { "&" } else { "?" };
    // Cache-busting query param, same reasoning as this file's previous
    // iframe-based approach: the embedded webview's HTTP cache (WKWebView on
    // macOS in particular) persists across app restarts, so a fresh preview
    // window can still serve a stale cached response left over from an
    // earlier session even though zola itself is serving fresh content.
    let url_string = format!("http://127.0.0.1:{port}{target}{separator}_t={}", now_millis());
    let url = Url::parse(&url_string).map_err(|e| e.to_string())?;

    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        win.set_focus().map_err(|e| e.to_string())?;
        // Window's already open (e.g. hitting "Start preview" again after
        // switching tabs, or after a site switch, which always means a
        // fresh port) - navigate it directly rather than needing it
        // reopened. No event round-trip needed (the old emit("preview-
        // navigate", ...) this replaced existed only because the previous
        // iframe design had no other way to tell an already-loaded page to
        // go somewhere else).
        win.navigate(url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::External(url))
        .title("Preview")
        .inner_size(DESKTOP_PREVIEW_SIZE.0, DESKTOP_PREVIEW_SIZE.1)
        .initialization_script(PREVIEW_TOOLBAR_SCRIPT)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
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
