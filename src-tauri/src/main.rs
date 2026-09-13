#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Mutex;

use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct ServeState(Mutex<Option<CommandChild>>);

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

    Ok("zola serve started on http://127.0.0.1:1111".to_string())
}

#[tauri::command]
fn zola_stop(state: tauri::State<ServeState>) -> Result<String, String> {
    match state.0.lock().unwrap().take() {
        Some(child) => {
            child.kill().map_err(|e| e.to_string())?;
            Ok("stopped".to_string())
        }
        None => Ok("nothing running".to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServeState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            zola_version,
            git_status,
            git_commit,
            current_branch,
            start_draft,
            zola_serve,
            zola_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
