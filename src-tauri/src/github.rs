//! GitHub's REST API (as opposed to git.rs's local git subprocess plumbing) -
//! pull request listing, creation, and approval, for the draft/review/publish
//! flow (pws-y8t, pws-9lj5). Reuses git.rs's GitAuthConfig token as a Bearer
//! credential for GitHub's API - a different header shape than the HTTP
//! Basic header git.rs injects for git-over-HTTPS, since these are different
//! protocols that happen to accept the same underlying token. Listing works
//! unauthenticated too, subject to GitHub's low per-IP rate limit for
//! anonymous requests; creating a PR or submitting a review is always a
//! write and always requires a token - there's no anonymous fallback for
//! those. Deliberately no merge action anywhere here - see
//! github_approve_pull_request's own doc comment.

use tauri::State;

use crate::git::{git_get_remote_url, guess_live_branch, GitAuthConfigState};
use crate::site::site_dir;

/// Pulls `owner`/`repo` out of a GitHub remote URL, whichever form it's in
/// (SSH, HTTPS, or explicit ssh://) - needed to build GitHub API URLs, which
/// address a repo by those two path segments rather than by remote URL.
fn parse_owner_repo(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim().trim_end_matches(".git").trim_end_matches('/');
    let after_host = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
        .or_else(|| trimmed.strip_prefix("https://github.com/"))
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;

    let mut parts = after_host.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

#[derive(serde::Deserialize)]
struct RawUser {
    login: String,
}

#[derive(serde::Deserialize)]
struct RawRepoRef {
    full_name: String,
}

#[derive(serde::Deserialize)]
struct RawHead {
    #[serde(rename = "ref")]
    ref_name: String,
    repo: Option<RawRepoRef>,
}

#[derive(serde::Deserialize)]
struct RawPullRequest {
    number: u32,
    title: String,
    html_url: String,
    user: RawUser,
    head: RawHead,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    number: u32,
    title: String,
    author_login: String,
    // The branch name to fetch/check out to actually look at this PR's
    // content (see git_checkout_remote_branch).
    branch: String,
    url: String,
    // False when the PR comes from a fork (head.repo differs from this
    // repo) - reviewing a forked PR needs fetching from that fork's own
    // remote, which this app doesn't set up. Surfaced so the UI can say so
    // rather than silently checking out the wrong thing.
    same_repo: bool,
}

fn raw_pr_to_info(pr: RawPullRequest, this_repo: &str) -> PullRequestInfo {
    let same_repo = pr.head.repo.as_ref().is_some_and(|r| r.full_name == this_repo);
    PullRequestInfo {
        number: pr.number,
        title: pr.title,
        author_login: pr.user.login,
        branch: pr.head.ref_name,
        url: pr.html_url,
        same_repo,
    }
}

/// Resolves the current remote into `(owner, repo)`, with the same "no
/// remote configured yet" / "doesn't look like github.com" error messages
/// every command that talks to GitHub's API needs.
fn owner_repo_for_current_remote() -> Result<(String, String), String> {
    let remote = git_get_remote_url()?;
    if remote.is_empty() {
        return Err("No remote repository is set up yet (Settings \u{2192} GitHub sync).".to_string());
    }
    parse_owner_repo(&remote).ok_or_else(|| format!("Don't recognize \"{remote}\" as a github.com repository."))
}

/// GitHub's API 404s an unauthenticated (or wrongly-authenticated) request
/// for a PRIVATE repo rather than 403ing it - it doesn't reveal whether a
/// private repo exists at all to a caller that can't prove access. Bundling
/// `gh` instead of asking for a pasted token wouldn't remove this
/// requirement - `gh` itself authenticates its own API calls with a token
/// (obtained via an OAuth device-code flow instead of a pasted PAT, but a
/// token regardless), since SSH auth has no equivalent for GitHub's web API
/// at all. So this stays a plain, clear error rather than new tooling.
fn github_api_request(url: &str, token: &str) -> Result<String, String> {
    let mut req = ureq::get(url)
        .header("User-Agent", "beedance-ssg-editor")
        .header("Accept", "application/vnd.github+json");
    if !token.is_empty() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    match req.call() {
        Ok(mut response) => response.body_mut().read_to_string().map_err(|e| e.to_string()),
        Err(ureq::Error::StatusCode(404)) if token.is_empty() => Err(
            "GitHub can't find this repository without logging in - it's probably private. \
             Add a personal access token in Settings \u{2192} GitHub sync to list pull requests here, \
             even if you use SSH for everyday syncing (GitHub's web API has no SSH equivalent)."
                .to_string(),
        ),
        Err(ureq::Error::StatusCode(401 | 403)) => Err(
            "GitHub rejected the configured personal access token - check it's still valid \
             and has access to this repository (Settings \u{2192} GitHub sync)."
                .to_string(),
        ),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn github_list_open_prs(auth: State<GitAuthConfigState>) -> Result<Vec<PullRequestInfo>, String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let token = auth.0.lock().unwrap().token.clone();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=open&per_page=100");
    let text = github_api_request(&url, &token)?;
    let raw: Vec<RawPullRequest> = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let this_repo = format!("{owner}/{repo}");
    Ok(raw.into_iter().map(|pr| raw_pr_to_info(pr, &this_repo)).collect())
}

/// A write (create PR, submit a review) is always a POST with a JSON body,
/// and always needs real auth - unlike listing, there's no anonymous write
/// access to fall back to. `http_status_as_error(false)` keeps the response
/// body available even on a 4xx/5xx so callers that care about the specific
/// status (a 422 "PR already exists", a self-approval rejection) can inspect
/// it themselves instead of getting a bare status code with the body thrown
/// away.
fn github_api_post(url: &str, token: &str, body: &impl serde::Serialize) -> Result<(u16, String), String> {
    if token.is_empty() {
        return Err(
            "This needs a personal access token configured (Settings \u{2192} GitHub sync) - \
             GitHub's API has no anonymous write access, even if you use SSH for everyday syncing."
                .to_string(),
        );
    }
    let mut response = ureq::post(url)
        .header("User-Agent", "beedance-ssg-editor")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .http_status_as_error(false)
        .build()
        .send_json(body)
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok((status, text))
}

#[derive(serde::Serialize)]
struct CreatePullRequestBody<'a> {
    title: &'a str,
    head: &'a str,
    base: &'a str,
    body: &'a str,
}

/// Creates a pull request from the current branch, called right after
/// "Submit for review" pushes it (git-workflow.js). GitHub 422s a create
/// call when a PR already exists for this head/base pair - the natural
/// caller flow is "send, then make sure a PR exists", so re-submitting to a
/// branch that already has one open should hand back that existing PR
/// rather than error.
#[tauri::command]
pub fn github_create_pull_request(
    title: String,
    body: String,
    auth: State<GitAuthConfigState>,
) -> Result<PullRequestInfo, String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let head = crate::git::current_branch()?;
    let base = guess_live_branch(&site_dir()).ok_or_else(|| {
        "Can't tell which branch is the live site (expected a local \"main\" or \"master\") - \
         open a pull request directly on GitHub instead."
            .to_string()
    })?;
    if head == base {
        return Err(format!(
            "You're on \"{base}\" itself - switch to a draft first (the branch menu \u{2192} \
             Switch or start a draft) before submitting for review."
        ));
    }

    let token = auth.0.lock().unwrap().token.clone();
    let this_repo = format!("{owner}/{repo}");
    let create_url = format!("https://api.github.com/repos/{this_repo}/pulls");
    let (status, text) = github_api_post(
        &create_url,
        &token,
        &CreatePullRequestBody { title: &title, head: &head, base: &base, body: &body },
    )?;

    if status == 201 {
        let raw: RawPullRequest = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        return Ok(raw_pr_to_info(raw, &this_repo));
    }
    if status == 422 && text.contains("A pull request already exists") {
        let list_url = format!("https://api.github.com/repos/{this_repo}/pulls?state=open&head={owner}:{head}");
        let list_text = github_api_request(&list_url, &token)?;
        let existing: Vec<RawPullRequest> = serde_json::from_str(&list_text).map_err(|e| e.to_string())?;
        if let Some(pr) = existing.into_iter().next() {
            return Ok(raw_pr_to_info(pr, &this_repo));
        }
    }
    if status == 401 || status == 403 {
        return Err(
            "GitHub rejected the configured personal access token - check it's still valid \
             and has \"Pull requests\" write access to this repository (Settings \u{2192} GitHub sync)."
                .to_string(),
        );
    }
    Err(format!("GitHub couldn't create the pull request ({status}): {text}"))
}

#[derive(serde::Serialize)]
struct SubmitReviewBody<'a> {
    event: &'a str,
}

/// Submits an "approve" review on an existing pull request. Deliberately no
/// merge action anywhere in this app - actually merging is a materially
/// bigger, harder-to-undo step than opening or approving a PR, and leaving
/// the final merge click on GitHub's own web UI is an intentional safety
/// boundary, not a missing feature.
#[tauri::command]
pub fn github_approve_pull_request(pr_number: u32, auth: State<GitAuthConfigState>) -> Result<(), String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let token = auth.0.lock().unwrap().token.clone();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/reviews");
    let (status, text) = github_api_post(&url, &token, &SubmitReviewBody { event: "APPROVE" })?;

    if status == 200 {
        return Ok(());
    }
    if status == 401 || status == 403 {
        return Err(
            "GitHub rejected the configured personal access token - check it's still valid \
             and has \"Pull requests\" write access to this repository (Settings \u{2192} GitHub sync)."
                .to_string(),
        );
    }
    if status == 422 && text.contains("Can not approve your own pull request") {
        return Err(
            "GitHub won't let you approve your own pull request - someone else who has \
             access to this repository needs to review it instead."
                .to_string(),
        );
    }
    Err(format!("GitHub couldn't submit the approval ({status}): {text}"))
}
