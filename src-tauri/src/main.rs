#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

struct ServeState(Mutex<Option<CommandChild>>);

/// Tracks when this app last wrote the open file itself, so the file watcher
/// can tell "the user clicked Save" apart from a genuine external edit and
/// only surface the external-change banner for the latter.
struct SelfWriteTracker(Mutex<Instant>);

/// The site-relative path of whatever file is currently open in the editor,
/// so the watcher (which now covers the whole site, not just content/) knows
/// which changed file is worth telling the frontend about.
struct OpenFile(Mutex<Option<PathBuf>>);

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(750);

fn sample_site_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sample-site")
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

/// sample-site/ is its own independent git repo, separate from this app's repo -
/// a "draft" is a branch on that repo, so cutting one must never touch (or be
/// confused with) beedance-ssg-editor's own source-controlled branch.
fn ensure_site_repo() -> Result<(), String> {
    let dir = sample_site_dir();
    if dir.join(".git").exists() {
        return Ok(());
    }
    run_git(&dir, &["init"])?;
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", "Initial content"])?;
    Ok(())
}

/// Resolves a site-relative path (e.g. "content/_index.md",
/// "templates/index.html") to a real path under sample-site/, rejecting
/// anything absolute or containing ".." components. Lexical only (not
/// canonicalize-based symlink-proof) - adequate for a local single-user spike,
/// not a hardening guarantee.
fn resolve_site_path(relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("invalid path: {}", relative));
    }
    Ok(sample_site_dir().join(rel))
}

fn collect_html_templates(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_html_templates(&path, root, out);
        } else if path.extension().is_some_and(|e| e == "html") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Lists content/_index.md plus every .html template under the site's own
/// templates/ (if any) and any vendored theme's templates/ (themes/*/templates/),
/// so the editor's file switcher covers real themes, not just a hardcoded pair.
#[tauri::command]
fn list_editable_files() -> Vec<String> {
    let dir = sample_site_dir();
    let mut files = vec!["content/_index.md".to_string()];

    collect_html_templates(&dir.join("templates"), &dir, &mut files);

    if let Ok(entries) = std::fs::read_dir(dir.join("themes")) {
        for entry in entries.flatten() {
            collect_html_templates(&entry.path().join("templates"), &dir, &mut files);
        }
    }

    files.sort();
    files
}

#[tauri::command]
fn read_file(path: String, open_file: tauri::State<OpenFile>) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    *open_file.0.lock().unwrap() = Some(full);
    Ok(content)
}

#[tauri::command]
fn write_file(path: String, content: String, tracker: tauri::State<SelfWriteTracker>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    // Mark the self-write window BEFORE writing, not after: the watcher thread
    // runs concurrently and must never be able to observe the resulting fs
    // event before this timestamp is in place, or it reads as external.
    *tracker.0.lock().unwrap() = Instant::now();
    std::fs::write(full, content).map_err(|e| e.to_string())
}

/// Watches the whole site tree and emits "content-file-changed" when whatever
/// file is currently open (per OpenFile) is touched from outside the app
/// (e.g. an agent editing in the background, or another editor). Detection
/// only for this spike - no auto-reload or merge, that's future work.
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

        if watcher.watch(&sample_site_dir(), RecursiveMode::Recursive).is_err() {
            return;
        }

        for res in rx {
            if let Ok(event) = res {
                let open_path = app.state::<OpenFile>().0.lock().unwrap().clone();
                let Some(open_path) = open_path else { continue };
                if event.paths.iter().any(|p| p == &open_path) {
                    let tracker = app.state::<SelfWriteTracker>();
                    let is_self_write = tracker.0.lock().unwrap().elapsed() < SELF_WRITE_WINDOW;
                    if !is_self_write {
                        let _ = app.emit("content-file-changed", ());
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
    let text = run_git(&sample_site_dir(), &["status", "--short", "."])?;
    Ok(if text.trim().is_empty() { "(clean)".to_string() } else { text })
}

#[tauri::command]
fn git_commit(message: String) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = sample_site_dir();
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", &message])
}

#[tauri::command]
fn current_branch() -> Result<String, String> {
    ensure_site_repo()?;
    let branch = run_git(&sample_site_dir(), &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(branch.trim().to_string())
}

#[tauri::command]
fn start_draft(name: String) -> Result<String, String> {
    ensure_site_repo()?;
    let branch = format!("draft/{}", slugify(&name));
    run_git(&sample_site_dir(), &["checkout", "-b", &branch])?;
    Ok(format!("Switched to new branch '{}'", branch))
}

fn open_or_focus_preview_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        PREVIEW_LABEL,
        WebviewUrl::External("http://127.0.0.1:1111".parse().unwrap()),
    )
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
        .current_dir(sample_site_dir())
        .args(["serve"])
        .spawn()
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(child);

    // Drain output so the child's stdout/stderr pipe never fills up and blocks it;
    // ignored for the spike, would surface to the UI in the real app.
    tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

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
        .manage(SelfWriteTracker(Mutex::new(
            Instant::now() - Duration::from_secs(3600),
        )))
        .manage(OpenFile(Mutex::new(None)))
        .setup(|app| {
            spawn_content_watcher(app.handle().clone());
            Ok(())
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
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
