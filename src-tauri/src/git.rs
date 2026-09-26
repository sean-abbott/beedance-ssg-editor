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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    // "modified" | "added" | "deleted" | "renamed" | "untracked"
    status: String,
}

/// Parses `git status --porcelain` (a stable, script-friendly two-letter
/// status code per line) into a real list a UI can render - replacing the
/// raw status text a non-technical author has no reason to understand the
/// syntax of.
#[tauri::command]
pub fn git_changed_files() -> Result<Vec<ChangedFile>, String> {
    ensure_site_repo()?;
    let raw = run_git(&site_dir(), &["status", "--porcelain"])?;
    let mut files = Vec::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let rest = &line[3..];
        // A rename's path field is "old -> new", not a plain path - the new
        // path is what subsequent operations (git diff, reading the file)
        // need, since the old one no longer exists. Doesn't handle a
        // git-quoted path (one containing a literal quote/backslash/
        // non-ASCII byte under core.quotePath) - content_slug-generated
        // filenames never produce one, so this is a real but low-priority
        // gap for a file added to the site from outside this app.
        let path = if code.contains('R') {
            rest.rsplit(" -> ").next().unwrap_or(rest).to_string()
        } else {
            rest.to_string()
        };
        let status = if code == "??" {
            "untracked"
        } else if code.contains('D') {
            "deleted"
        } else if code.contains('A') {
            "added"
        } else if code.contains('R') {
            "renamed"
        } else {
            "modified"
        };
        files.push(ChangedFile { path, status: status.to_string() });
    }
    Ok(files)
}

/// A real unified diff for one changed file. An untracked (brand new) file
/// has nothing to diff against, so this just returns its raw content with a
/// note instead of reaching for a platform-specific "diff against /dev/null"
/// trick that wouldn't work on Windows.
#[tauri::command]
pub fn git_diff_for_file(path: String) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let status = run_git(&dir, &["status", "--porcelain", "--", &path])?;
    if status.trim_start().starts_with("??") {
        return std::fs::read_to_string(dir.join(&path))
            .map(|content| format!("(new file)\n\n{content}"))
            .map_err(|e| e.to_string());
    }
    run_git(&dir, &["diff", "--", &path])
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
