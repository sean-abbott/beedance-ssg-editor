#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const PREVIEW_LABEL: &str = "preview";
// "idiomatic average web page" desktop viewport, and a common phone reference size.
const DESKTOP_PREVIEW_SIZE: (f64, f64) = (1280.0, 800.0);
const PHONE_PREVIEW_SIZE: (f64, f64) = (390.0, 844.0);

/// Tracks when this app last wrote each path itself, per-path (not a single
/// global timestamp - with multiple tabs open, saving one file must not
/// suppress a genuine external-edit notification for a different one), so the
/// file watcher can tell "the user's own save" apart from a real external edit.
struct SelfWriteTracker(Mutex<HashMap<PathBuf, Instant>>);

/// Every file currently open in a tab, so the watcher (which covers the whole
/// site, not just content/) knows which changed paths are worth telling the
/// frontend about - anything not open in some tab is irrelevant to it.
struct OpenFiles(Mutex<HashSet<PathBuf>>);

struct ServeState(Mutex<Option<CommandChild>>);

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(750);

/// Resolves which site this app edits: $BEEDANCE_SITE_DIR env var if set (quick
/// override for testing), else the path recorded by `just set-site` /
/// scripts/set-site.sh at ~/.config/beedance-ssg-editor/site_dir, else the
/// bundled sample-site/ so the existing dev/spike workflow keeps working with
/// no setup.
fn site_dir() -> PathBuf {
    if let Ok(path) = std::env::var("BEEDANCE_SITE_DIR") {
        return PathBuf::from(path);
    }

    if let Ok(home) = std::env::var("HOME") {
        let config_path = PathBuf::from(home).join(".config/beedance-ssg-editor/site_dir");
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sample-site")
}

#[tauri::command]
fn get_site_dir() -> String {
    site_dir().to_string_lossy().to_string()
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = StdCommand::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// The site being edited is its own independent git repo, separate from this
/// app's repo - a "draft" is a branch on that repo, so cutting one must never
/// touch (or be confused with) beedance-ssg-editor's own source-controlled
/// branch. Also inits a fresh repo here if the site doesn't have one yet
/// (e.g. a brand-new site directory), so this is safe to call for either.
fn ensure_site_repo() -> Result<(), String> {
    let dir = site_dir();
    if dir.join(".git").exists() {
        return Ok(());
    }
    run_git(&dir, &["init"])?;
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", "Initial content"])?;
    Ok(())
}

/// Resolves a site-relative path (e.g. "content/_index.md",
/// "templates/index.html") to a real path under the current site directory,
/// rejecting anything absolute or containing ".." components. Lexical only
/// (not canonicalize-based symlink-proof) - adequate for a local single-user
/// spike, not a hardening guarantee.
fn resolve_site_path(relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("invalid path: {}", relative));
    }
    Ok(site_dir().join(rel))
}

fn collect_files_with_ext(dir: &Path, root: &Path, ext: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_with_ext(&path, root, ext, out);
        } else if path.extension().is_some_and(|e| e == ext) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Lists every .md file under content/ (every page/post in the site, however
/// many there are), plus every .html template under the site's own templates/
/// (if any) and any vendored theme's templates/ (themes/*/templates/), so the
/// editor's file switcher covers a real multi-page site, not just one file.
#[tauri::command]
fn list_editable_files() -> Vec<String> {
    let dir = site_dir();
    let mut files = Vec::new();

    collect_files_with_ext(&dir.join("content"), &dir, "md", &mut files);
    collect_files_with_ext(&dir.join("templates"), &dir, "html", &mut files);

    if let Ok(entries) = std::fs::read_dir(dir.join("themes")) {
        for entry in entries.flatten() {
            collect_files_with_ext(&entry.path().join("templates"), &dir, "html", &mut files);
        }
    }

    files.sort();
    files
}

#[tauri::command]
fn read_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    open_files.0.lock().unwrap().insert(full);
    Ok(content)
}

/// Called when a tab closes, so the watcher stops caring about that path -
/// otherwise an external edit to a file with no open tab would still (and
/// shouldn't) trigger a change notification.
#[tauri::command]
fn close_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    open_files.0.lock().unwrap().remove(&full);
    Ok(())
}

#[tauri::command]
fn write_file(path: String, content: String, tracker: tauri::State<SelfWriteTracker>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    // Mark the self-write window for THIS path BEFORE writing, not after: the
    // watcher thread runs concurrently and must never be able to observe the
    // resulting fs event before this timestamp is in place, or it reads as
    // external. Keyed per-path so saving one open tab never suppresses a
    // genuine external-edit notification for a different one.
    tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
    std::fs::write(full, content).map_err(|e| e.to_string())
}

/// Watches the whole site tree and emits "content-file-changed" (with the
/// changed path as payload) whenever a file that's open in some tab (per
/// OpenFiles) is touched from outside the app (e.g. an agent editing in the
/// background, or another editor). Detection only for this spike - no
/// auto-reload or merge, that's future work.
fn spawn_content_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecommendedWatcher, RecursiveMode, Watcher};

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

        if watcher.watch(&site_dir(), RecursiveMode::Recursive).is_err() {
            return;
        }

        for res in rx {
            let Ok(event) = res else { continue };
            let open_files = app.state::<OpenFiles>();
            let changed_open_paths: Vec<PathBuf> = {
                let open = open_files.0.lock().unwrap();
                event.paths.iter().filter(|p| open.contains(*p)).cloned().collect()
            };

            for path in changed_open_paths {
                let tracker = app.state::<SelfWriteTracker>();
                let is_self_write = tracker
                    .0
                    .lock()
                    .unwrap()
                    .get(&path)
                    .is_some_and(|t| t.elapsed() < SELF_WRITE_WINDOW);
                if !is_self_write {
                    if let Ok(rel) = path.strip_prefix(site_dir()) {
                        let _ = app.emit("content-file-changed", rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
    });
}

fn slugify(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

#[tauri::command]
async fn zola_version(app: tauri::AppHandle) -> Result<String, String> {
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

#[tauri::command]
fn git_status() -> Result<String, String> {
    ensure_site_repo()?;
    let text = run_git(&site_dir(), &["status", "--short", "."])?;
    Ok(if text.trim().is_empty() { "(clean)".to_string() } else { text })
}

#[tauri::command]
fn git_commit(message: String) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", &message])
}

#[tauri::command]
fn current_branch() -> Result<String, String> {
    ensure_site_repo()?;
    let branch = run_git(&site_dir(), &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(branch.trim().to_string())
}

#[tauri::command]
fn start_draft(name: String) -> Result<String, String> {
    ensure_site_repo()?;
    let branch = format!("draft/{}", slugify(&name));
    run_git(&site_dir(), &["checkout", "-b", &branch])?;
    Ok(format!("Switched to new branch '{}'", branch))
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

fn open_or_focus_preview_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App("preview.html".into()))
    .title("Preview")
    .inner_size(DESKTOP_PREVIEW_SIZE.0, DESKTOP_PREVIEW_SIZE.1)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn zola_serve(app: tauri::AppHandle, state: tauri::State<ServeState>) -> Result<String, String> {
    // Stop any previous instance first so repeated clicks don't fight over the port.
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }

    let sidecar = app.shell().sidecar("zola").map_err(|e| e.to_string())?;
    let (mut rx, child) = sidecar
        .current_dir(site_dir())
        .args(["serve"])
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
                let _ = log_app.emit("zola-log", line);
            }
        }
    });

    if !wait_for_port(1111, Duration::from_secs(5)) {
        return Err(
            "zola serve did not start listening on 127.0.0.1:1111 within 5s - check the log panel below for the actual error".to_string(),
        );
    }
    open_or_focus_preview_window(&app)?;

    Ok("zola serve started on http://127.0.0.1:1111".to_string())
}

#[tauri::command]
fn zola_stop(app: tauri::AppHandle, state: tauri::State<ServeState>) -> Result<String, String> {
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
fn set_preview_phone_mode(app: tauri::AppHandle, phone: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(PREVIEW_LABEL)
        .ok_or_else(|| "preview window is not open".to_string())?;
    let (w, h) = if phone { PHONE_PREVIEW_SIZE } else { DESKTOP_PREVIEW_SIZE };
    win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServeState(Mutex::new(None)))
        .manage(SelfWriteTracker(Mutex::new(HashMap::new())))
        .manage(OpenFiles(Mutex::new(HashSet::new())))
        .setup(|app| {
            spawn_content_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window should take the preview (window + zola
            // serve process) down with it, not leave it orphaned.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<ServeState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                if let Some(preview) = app.get_webview_window(PREVIEW_LABEL) {
                    let _ = preview.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            zola_version,
            git_status,
            git_commit,
            current_branch,
            start_draft,
            zola_serve,
            zola_stop,
            set_preview_phone_mode,
            list_editable_files,
            get_site_dir,
            read_file,
            close_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
