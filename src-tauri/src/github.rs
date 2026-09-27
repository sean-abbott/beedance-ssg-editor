//! GitHub's REST API (as opposed to git.rs's local git subprocess plumbing) -
//! currently just pull request listing, for the "review someone else's work"
//! flow (pws-y8t). Reuses git.rs's GitAuthConfig token as a Bearer credential
//! for GitHub's API - a different header shape than the HTTP Basic header
//! git.rs injects for git-over-HTTPS, since these are different protocols
//! that happen to accept the same underlying token. Works unauthenticated
//! too, subject to GitHub's low per-IP rate limit for anonymous requests -
//! fine for a small private team's own repo once a token is configured, but
//! kept as a fallback rather than a hard requirement.

use tauri::State;

use crate::git::{git_get_remote_url, GitAuthConfigState};

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
    let remote = git_get_remote_url()?;
    if remote.is_empty() {
        return Err("No remote repository is set up yet (Settings \u{2192} GitHub sync).".to_string());
    }
    let (owner, repo) =
        parse_owner_repo(&remote).ok_or_else(|| format!("Don't recognize \"{remote}\" as a github.com repository."))?;

    let token = auth.0.lock().unwrap().token.clone();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls?state=open&per_page=100");
    let text = github_api_request(&url, &token)?;
    let raw: Vec<RawPullRequest> = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let this_repo = format!("{owner}/{repo}");
    Ok(raw
        .into_iter()
        .map(|pr| {
            let same_repo = pr.head.repo.as_ref().is_some_and(|r| r.full_name == this_repo);
            PullRequestInfo {
                number: pr.number,
                title: pr.title,
                author_login: pr.user.login,
                branch: pr.head.ref_name,
                url: pr.html_url,
                same_repo,
            }
        })
        .collect())
}
