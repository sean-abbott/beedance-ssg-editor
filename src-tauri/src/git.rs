//! Git operations against the site's own repo - separate from this app's own
//! source-controlled repo, see ensure_site_repo's doc comment.
//!
//! Sync auth is GitHub-specific by design, not host-agnostic - matches the
//! "one real provider, named boundary" pattern already used for the SSG
//! (zola.rs) and image storage (r2.rs). Two paths, chosen per push/pull call:
//! no token configured -> run plain git with no auth override, so whatever's
//! already set up on this machine (an SSH key + agent, a credential manager)
//! works exactly as it would outside this app; a configured fine-grained
//! GitHub personal access token (scoped to one repo, Contents read/write) ->
//! inject it as an HTTP Basic auth header for just that one subprocess call.
//! The header is inert for an SSH-form remote, so no URL-scheme branching is
//! needed. Unlike R2 credentials, a GitHub PAT can't be minted by one person
//! for someone else - each collaborator creates their own via GitHub's own
//! UI; this app links out to GitHub's own docs for that rather than
//! reproducing them (see pws-y8t's design notes).

use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tauri::State;

use crate::site::{config_dir, site_dir, SelfWriteTracker};

/// Records that THIS app is about to change which branch is checked out, so
/// the content watcher (site.rs) can tell that apart from someone switching
/// branches from a terminal - reuses the exact same self-write-window
/// mechanism already used for file saves, keyed on .git/HEAD instead of a
/// content path.
fn mark_head_self_write(tracker: &State<SelfWriteTracker>) {
    let head_path = site_dir().join(".git").join("HEAD");
    tracker.0.lock().unwrap().insert(head_path, Instant::now());
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

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthConfig {
    // A fine-grained GitHub personal access token, scoped to this one repo
    // with Contents read/write. Empty means "no override" - push/pull run
    // with no auth flags at all, relying on whatever this machine already
    // has configured (SSH key + agent, a credential manager, etc).
    pub(crate) token: String,
    // Entered manually rather than derived from the token (via GitHub's
    // /user API) or from git commit authorship - a token isn't always
    // configured (SSH-only setups), and commit authorship is explicitly not
    // trusted as a real identity elsewhere in this app (extra.authors is).
    // Used only to tell "my" open pull requests apart from everyone else's
    // in the review flow (github.rs) - never sent anywhere itself.
    pub(crate) github_username: String,
}

const GIT_AUTH_CONFIG_FILE: &str = "git-auth.json";

pub struct GitAuthConfigState(pub Mutex<GitAuthConfig>);

pub fn load_git_auth_config() -> GitAuthConfig {
    config_dir()
        .and_then(|dir| fs::read_to_string(dir.join(GIT_AUTH_CONFIG_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_git_auth_config(state: State<GitAuthConfigState>) -> GitAuthConfig {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_git_auth_config(
    token: String,
    github_username: String,
    state: State<GitAuthConfigState>,
) -> Result<(), String> {
    let settings = GitAuthConfig { token, github_username };
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(dir.join(GIT_AUTH_CONFIG_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Runs git with a token's Basic-auth header injected ahead of `args` when
/// one is configured, otherwise identical to a plain `run_git`. `-c
/// http.extraHeader=...` only affects this one invocation, never touching
/// the repo's committed or global git config.
fn run_git_authed(dir: &Path, args: &[&str], auth: &GitAuthConfig) -> Result<String, String> {
    if auth.token.is_empty() {
        return run_git(dir, args);
    }
    let encoded = STANDARD.encode(format!("x-access-token:{}", auth.token));
    let header_arg = format!("http.extraHeader=Authorization: Basic {encoded}");
    let mut full_args = vec!["-c", &header_arg];
    full_args.extend_from_slice(args);
    run_git(dir, &full_args)
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
pub fn start_draft(name: String, tracker: State<SelfWriteTracker>) -> Result<String, String> {
    ensure_site_repo()?;
    let branch = format!("draft/{}", slugify(&name));
    mark_head_self_write(&tracker);
    run_git(&site_dir(), &["checkout", "-b", &branch])?;
    Ok(format!("Switched to new branch '{}'", branch))
}

fn local_branch_names(dir: &Path) -> Result<Vec<String>, String> {
    let raw = run_git(dir, &["branch", "--format=%(refname:short)"])?;
    Ok(raw.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// Which local branch is "the live site" - the one a push eventually reaches
/// the real deployed site from. Doesn't ask the remote (that needs a network
/// round trip - see git_check_main_drift for that): "main"/"master" is the
/// overwhelming real-world convention, and a brand new site with only one
/// branch has nothing else it could mean. Anything more ambiguous than that
/// (multiple branches, neither named main/master) returns None rather than
/// guessing wrong - the UI just shows no branch as "live" in that case.
fn guess_live_branch(dir: &Path) -> Option<String> {
    let branches = local_branch_names(dir).ok()?;
    for candidate in ["main", "master"] {
        if branches.iter().any(|b| b == candidate) {
            return Some(candidate.to_string());
        }
    }
    if branches.len() == 1 {
        return Some(branches[0].clone());
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    name: String,
    is_current: bool,
    is_live: bool,
}

#[tauri::command]
pub fn git_list_local_branches() -> Result<Vec<LocalBranch>, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let current = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let live = guess_live_branch(&dir);
    let names = local_branch_names(&dir)?;
    Ok(names
        .into_iter()
        .map(|name| {
            let is_current = name == current;
            let is_live = live.as_deref() == Some(name.as_str());
            LocalBranch { name, is_current, is_live }
        })
        .collect())
}

#[tauri::command]
pub fn git_checkout_branch(branch: String, tracker: State<SelfWriteTracker>) -> Result<String, String> {
    ensure_site_repo()?;
    mark_head_self_write(&tracker);
    run_git(&site_dir(), &["checkout", &branch])
}

/// Fetches a branch that only exists on the remote so far and checks it out
/// locally, (re)creating a local branch of the same name pointed at the
/// remote's current tip - used for the "review someone else's pull request"
/// flow (github.rs lists the PRs; this is what actually gets onto one's
/// disk), and reusable later for browsing/checking out remote branches in
/// general. Resetting with -B rather than a plain -b means reviewing the
/// same PR again after it's been pushed to always picks up its latest tip,
/// rather than erroring that the branch already exists.
#[tauri::command]
pub fn git_checkout_remote_branch(
    branch: String,
    tracker: State<SelfWriteTracker>,
    auth: State<GitAuthConfigState>,
) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let cfg = auth.0.lock().unwrap().clone();
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    run_git_authed(&dir, &["fetch", "origin", &refspec], &cfg)?;
    mark_head_self_write(&tracker);
    let remote_ref = format!("origin/{branch}");
    run_git(&dir, &["checkout", "-B", &branch, &remote_ref])
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainDriftStatus {
    // None when there's no live branch to compare (no remote configured
    // yet, or which branch is "live" is genuinely ambiguous - see
    // guess_live_branch). Not an error: a brand new, not-yet-connected site
    // is a normal state.
    live_branch: Option<String>,
    has_remote: bool,
    // Only meaningful when live_branch AND has_remote are both set - counts
    // of commits your local copy of that branch has that the remote doesn't
    // (ahead) and vice versa (behind).
    ahead: u32,
    behind: u32,
}

/// Checks whether the local copy of the live/main branch has drifted from
/// its remote counterpart - run at startup and whenever the drafts dialog
/// opens, per pws-y8t's design. Deliberately doesn't attempt to resolve a
/// real divergence itself (no merge/rebase UI, no conflict resolution) -
/// that's an explicit, discussed non-goal for the foreseeable future;
/// surfacing that drift exists is enough for someone who knows git to take
/// it from there.
#[tauri::command]
pub fn git_check_main_drift(auth: State<GitAuthConfigState>) -> Result<MainDriftStatus, String> {
    ensure_site_repo()?;
    let dir = site_dir();

    let has_remote = !run_git(&dir, &["remote", "get-url", "origin"]).unwrap_or_default().trim().is_empty();
    let Some(live) = guess_live_branch(&dir) else {
        return Ok(MainDriftStatus { live_branch: None, has_remote, ahead: 0, behind: 0 });
    };
    if !has_remote {
        return Ok(MainDriftStatus { live_branch: Some(live), has_remote, ahead: 0, behind: 0 });
    }

    let branches = local_branch_names(&dir)?;
    if !branches.iter().any(|b| b == &live) {
        // Remote presumably has it, but nothing to diff it against locally.
        return Ok(MainDriftStatus { live_branch: Some(live), has_remote, ahead: 0, behind: 0 });
    }

    let cfg = auth.0.lock().unwrap().clone();
    let refspec = format!("+refs/heads/{live}:refs/remotes/origin/{live}");
    run_git_authed(&dir, &["fetch", "origin", &refspec], &cfg)?;

    let range = format!("{live}...origin/{live}");
    let counts = run_git(&dir, &["rev-list", "--left-right", "--count", &range])?;
    let mut parts = counts.split_whitespace();
    let ahead: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(MainDriftStatus { live_branch: Some(live), has_remote, ahead, behind })
}

/// Empty string (not an error) means no remote is configured yet - a brand
/// new site directory that was never cloned from anywhere, which is a normal
/// state, not a failure.
#[tauri::command]
pub fn git_get_remote_url() -> Result<String, String> {
    ensure_site_repo()?;
    match run_git(&site_dir(), &["remote", "get-url", "origin"]) {
        Ok(url) => Ok(url.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
pub fn git_set_remote_url(url: String) -> Result<(), String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let has_remote = !run_git(&dir, &["remote", "get-url", "origin"])
        .unwrap_or_default()
        .trim()
        .is_empty();
    if has_remote {
        run_git(&dir, &["remote", "set-url", "origin", &url])?;
    } else {
        run_git(&dir, &["remote", "add", "origin", &url])?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_push(auth: State<GitAuthConfigState>) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let cfg = auth.0.lock().unwrap().clone();
    run_git_authed(&dir, &["push", "-u", "origin", &branch], &cfg)
}

#[tauri::command]
pub fn git_pull(auth: State<GitAuthConfigState>) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    let cfg = auth.0.lock().unwrap().clone();
    run_git_authed(&dir, &["pull", "origin", &branch], &cfg)
}

/// Clones a GitHub repo to `destination` (an absolute path - the frontend
/// gets one from its own directory picker, same as "Change site...") - used
/// by the first-run "start fresh or clone a site" onboarding flow. Not
/// scoped to the CURRENTLY edited site at all (doesn't call ensure_site_repo
/// or use site_dir()) since the whole point is picking a NEW site directory
/// that doesn't exist as a git repo, or even as a directory, yet.
#[tauri::command]
pub fn git_clone_repo(url: String, destination: String, auth: State<GitAuthConfigState>) -> Result<String, String> {
    let cfg = auth.0.lock().unwrap().clone();
    run_git_authed(Path::new("."), &["clone", &url, &destination], &cfg)
}
