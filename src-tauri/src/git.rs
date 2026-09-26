//! Git operations against the site's own repo - separate from this app's own
//! source-controlled repo, see ensure_site_repo's doc comment.

use std::path::Path;
use std::process::Command as StdCommand;

use crate::site::site_dir;

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

fn slugify(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

#[tauri::command]
pub fn git_status() -> Result<String, String> {
    ensure_site_repo()?;
    let text = run_git(&site_dir(), &["status", "--short", "."])?;
    Ok(if text.trim().is_empty() { "(clean)".to_string() } else { text })
}

#[tauri::command]
pub fn git_commit(message: String) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", &message])
}

#[tauri::command]
pub fn current_branch() -> Result<String, String> {
    ensure_site_repo()?;
    let branch = run_git(&site_dir(), &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(branch.trim().to_string())
}

#[tauri::command]
pub fn start_draft(name: String) -> Result<String, String> {
    ensure_site_repo()?;
    let branch = format!("draft/{}", slugify(&name));
    run_git(&site_dir(), &["checkout", "-b", &branch])?;
    Ok(format!("Switched to new branch '{}'", branch))
}
