#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command as StdCommand;

use tauri_plugin_shell::ShellExt;

fn sample_site_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sample-site")
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
    let output = StdCommand::new("git")
        .current_dir(sample_site_dir())
        .args(["status", "--short", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(if text.trim().is_empty() { "(clean)".to_string() } else { text })
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_commit(message: String) -> Result<String, String> {
    let dir = sample_site_dir();

    let add = StdCommand::new("git")
        .current_dir(&dir)
        .args(["add", "."])
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).to_string());
    }

    let commit = StdCommand::new("git")
        .current_dir(&dir)
        .args(["commit", "-m", &message])
        .output()
        .map_err(|e| e.to_string())?;

    if commit.status.success() {
        Ok(String::from_utf8_lossy(&commit.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&commit.stderr).to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            zola_version,
            git_status,
            git_commit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
