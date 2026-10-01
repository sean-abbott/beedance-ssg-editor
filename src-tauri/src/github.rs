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

/// The GitHub login the configured token actually authenticates as - the
/// reliable way to know "which PRs are mine" for self-review blocking,
/// rather than trusting the separately hand-typed username in Settings
/// (which can be blank, stale, or simply mistyped - exactly what let
/// Sean's own PRs show up as reviewable: "review doesn't properly block
/// my own PRs"). None when no token is configured - nothing to derive an
/// identity from (listing still works unauthenticated, but "who am I" has
/// no answer there, same as it never did before this).
#[tauri::command]
pub fn github_current_username(auth: State<GitAuthConfigState>) -> Result<Option<String>, String> {
    let token = auth.0.lock().unwrap().token.clone();
    if token.is_empty() {
        return Ok(None);
    }
    let body = github_api_request("https://api.github.com/user", &token)?;
    let user: RawUser = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(Some(user.login))
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

#[derive(serde::Serialize)]
struct CreateCommentBody<'a> {
    body: &'a str,
}

/// Posts a plain conversation comment on a pull request (GitHub treats a PR
/// as an "issue" for commenting purposes, sharing that endpoint) - NOT a
/// file/line-anchored "review comment", which needs a diff position rather
/// than just a line number and can fail outright if that position isn't
/// part of the diff. The file this feedback is about is folded into the
/// comment body as plain text instead - works uniformly for every kind of
/// change (a renamed file, an image, a deletion - not just line-addressable
/// text), and reads naturally in GitHub's own PR conversation view.
#[tauri::command]
pub fn github_create_pr_comment(pr_number: u32, body: String, auth: State<GitAuthConfigState>) -> Result<(), String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let token = auth.0.lock().unwrap().token.clone();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{pr_number}/comments");
    let (status, text) = github_api_post(&url, &token, &CreateCommentBody { body: &body })?;

    if status == 201 {
        return Ok(());
    }
    if status == 401 || status == 403 {
        return Err(
            "GitHub rejected the configured personal access token - check it's still valid \
             and has \"Pull requests\" write access to this repository (Settings \u{2192} GitHub sync)."
                .to_string(),
        );
    }
    Err(format!("GitHub couldn't post the comment ({status}): {text}"))
}

#[derive(serde::Deserialize)]
struct RawPullRequestState {
    number: u32,
    html_url: String,
    state: String,
    // Only ever set once a PR has actually been merged - the one reliable
    // signal that distinguishes "closed because it was published" from
    // "closed without merging" (state alone can't tell those apart).
    merged_at: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPrState {
    // "none" | "open" | "published" | "closed" (closed without merging -
    // rare, but a real possibility, and reporting it as "none" would read
    // as "nothing was ever sent" when something was, then got closed).
    status: String,
    number: Option<u32>,
    url: Option<String>,
}

/// The current draft's own PR state, independent of whatever the last
/// Send-changes click happened to show - pws-662d.2's "persistent, not a
/// one-time toast" requirement, and the same open-PR-for-this-branch
/// lookup pws-662d.6 needs for detecting an external publish. Picks the
/// most recently created PR for this exact branch if more than one exists
/// (rare - a branch normally only ever has one, across this app's own
/// reuse-by-name-via--B checkout pattern).
#[tauri::command]
pub fn github_current_draft_pr_state(auth: State<GitAuthConfigState>) -> Result<DraftPrState, String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let branch = crate::git::current_branch()?;
    let token = auth.0.lock().unwrap().token.clone();

    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/pulls?state=all&head={owner}:{branch}&sort=created&direction=desc"
    );
    let text = github_api_request(&url, &token)?;
    let prs: Vec<RawPullRequestState> = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let Some(pr) = prs.into_iter().next() else {
        return Ok(DraftPrState { status: "none".to_string(), number: None, url: None });
    };
    let status = if pr.merged_at.is_some() {
        "published"
    } else if pr.state == "open" {
        "open"
    } else {
        "closed"
    };
    Ok(DraftPrState { status: status.to_string(), number: Some(pr.number), url: Some(pr.html_url) })
}

#[derive(serde::Deserialize)]
struct RawComment {
    body: String,
    user: RawUser,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackComment {
    author: String,
    // None when the comment wasn't posted through this app's own "Leave
    // feedback" flow (github_create_pr_comment) - e.g. someone commented
    // directly on GitHub's own PR page instead. Parsed back out of that
    // flow's own "On `path`: ..." body prefix rather than tracked
    // separately server-side, since a plain issue comment has no field of
    // its own for "which file this is about."
    file: Option<String>,
    body: String,
}

// Mirrors exactly the prefix github_create_pr_comment writes - kept as the
// one place that format is assumed, so the two stay in sync if it ever
// changes.
fn split_feedback_body(raw: &str) -> (Option<String>, String) {
    if let Some(rest) = raw.strip_prefix("On `") {
        if let Some(end) = rest.find('`') {
            let file = &rest[..end];
            if let Some(body) = rest[end + 1..].strip_prefix(":\n\n") {
                return (Some(file.to_string()), body.to_string());
            }
        }
    }
    (None, raw.to_string())
}

/// Every comment on the current draft's own open pull request, for the
/// author to read without leaving the app - pws-662d.4. Not an error when
/// there's no open PR yet (nothing published for review yet is a normal,
/// common state, not a failure) or no comments on it yet - both just
/// return an empty list.
#[tauri::command]
pub fn github_list_feedback_for_current_draft(auth: State<GitAuthConfigState>) -> Result<Vec<FeedbackComment>, String> {
    let (owner, repo) = owner_repo_for_current_remote()?;
    let branch = crate::git::current_branch()?;
    let token = auth.0.lock().unwrap().token.clone();

    let pr_url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}");
    let pr_text = github_api_request(&pr_url, &token)?;
    let prs: Vec<RawPullRequest> = serde_json::from_str(&pr_text).map_err(|e| e.to_string())?;
    let Some(pr) = prs.into_iter().next() else {
        return Ok(Vec::new()); // No open PR for this draft yet.
    };

    let comments_url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{}/comments", pr.number);
    let comments_text = github_api_request(&comments_url, &token)?;
    let raw: Vec<RawComment> = serde_json::from_str(&comments_text).map_err(|e| e.to_string())?;

    Ok(raw
        .into_iter()
        .map(|c| {
            let (file, body) = split_feedback_body(&c.body);
            FeedbackComment { author: c.user.login, file, body }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_feedback_body_extracts_the_file_prefix_github_create_pr_comment_writes() {
        let (file, body) = split_feedback_body("On `content/about.md`:\n\nCan we mention the new time?");
        assert_eq!(file, Some("content/about.md".to_string()));
        assert_eq!(body, "Can we mention the new time?");
    }

    #[test]
    fn split_feedback_body_passes_through_a_comment_with_no_recognized_prefix() {
        // e.g. posted directly on GitHub's own PR page, not through this
        // app's "Leave feedback" flow.
        let (file, body) = split_feedback_body("Looks good otherwise!");
        assert_eq!(file, None);
        assert_eq!(body, "Looks good otherwise!");
    }

    #[test]
    fn split_feedback_body_does_not_misparse_a_backtick_elsewhere_in_the_body() {
        let (file, body) = split_feedback_body("On `a.md`:\n\nUse `inline code` here too");
        assert_eq!(file, Some("a.md".to_string()));
        assert_eq!(body, "Use `inline code` here too");
    }
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCheckResult {
    valid: bool,
    username: Option<String>,
    // None (not Some(false)) when there's no repository configured yet to
    // check against - "couldn't check" and "checked and it failed" are
    // different situations, and collapsing them into one false would read
    // as a failure that was never actually tested.
    can_read_contents: Option<bool>,
    can_read_pull_requests: Option<bool>,
    error: Option<String>,
}

/// Best-effort verification that a just-entered token actually works -
/// never blocks the save itself (the token is persisted regardless, by the
/// caller, before this even runs), just reports what it found. GitHub has
/// no endpoint to introspect a fine-grained token's own granted
/// permissions - unlike a classic token's X-OAuth-Scopes response header,
/// fine-grained tokens return nothing to inspect (confirmed against
/// GitHub's own docs/community discussions, not assumed). The only real way
/// to check is the one GitHub itself documents: call the lightest real
/// endpoint each permission actually gates, and read the status code - a
/// 401 means the token itself is bad, a 403 means it's valid but missing
/// that specific permission. Only checks READ access (Contents, Pull
/// requests) - there's no safe way to verify WRITE access without
/// performing a real write (create/modify a file, open a PR, post a
/// comment), which this deliberately doesn't do just to tick a box.
#[tauri::command]
pub fn github_validate_token(token: String) -> TokenCheckResult {
    if token.is_empty() {
        return TokenCheckResult::default();
    }

    let mut result = TokenCheckResult::default();
    match github_api_request("https://api.github.com/user", &token) {
        Ok(body) => {
            result.valid = true;
            if let Ok(user) = serde_json::from_str::<RawUser>(&body) {
                result.username = Some(user.login);
            }
        }
        Err(err) => {
            result.error = Some(err);
            return result;
        }
    }

    let Ok((owner, repo)) = owner_repo_for_current_remote() else {
        return result; // No repository configured yet - nothing more to check.
    };

    let contents_url = format!("https://api.github.com/repos/{owner}/{repo}/contents");
    result.can_read_contents = Some(github_api_request(&contents_url, &token).is_ok());

    let pulls_url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?per_page=1");
    result.can_read_pull_requests = Some(github_api_request(&pulls_url, &token).is_ok());

    result
}
