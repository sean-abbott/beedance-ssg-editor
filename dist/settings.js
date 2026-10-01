// Settings page: author display name, image size presets, R2 (site config
// + personal credentials), and GitHub sync (remote URL, personal access
// token, GitHub username). See editor-core.js for currentAuthorName/
// currentGithubUsername themselves - this module only loads/saves them.
//
// A full app-main page (see menus.js's showAppMainPage), not a modal -
// "This installation" and "This site" are two stacked, visually distinct
// zones (see their .settings-zone/.zone-installation/.zone-site CSS)
// rather than tabs, since both matter enough to want visible at once
// rather than picking one to hide.

import { setCurrentAuthorName, setCurrentGithubUsername, showError } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const authorDisplayNameInput = document.getElementById("author-display-name");
const authorSettingsStatus = document.getElementById("author-settings-status");

const tierWebCap = document.getElementById("tier-web-cap");
const tierWebQuality = document.getElementById("tier-web-quality");
const tierHighCap = document.getElementById("tier-high-cap");
const tierHighQuality = document.getElementById("tier-high-quality");
const tierPostInternalCap = document.getElementById("tier-post-internal-cap");
const tierPostInternalQuality = document.getElementById("tier-post-internal-quality");
const tierSettingsStatus = document.getElementById("tier-settings-status");

const r2Bucket = document.getElementById("r2-bucket");
const r2PublicUrlBase = document.getElementById("r2-public-url-base");
const r2SiteSettingsStatus = document.getElementById("r2-site-settings-status");

const r2Enabled = document.getElementById("r2-enabled");
const r2AccountId = document.getElementById("r2-account-id");
const r2AccessKeyId = document.getElementById("r2-access-key-id");
const r2SecretAccessKey = document.getElementById("r2-secret-access-key");
const r2PersonalSettingsStatus = document.getElementById("r2-personal-settings-status");

const gitRemoteUrlInput = document.getElementById("git-remote-url");
const gitTokenInput = document.getElementById("git-token");
const gitUsernameInput = document.getElementById("git-username");
const gitAuthSettingsStatus = document.getElementById("git-auth-settings-status");

// Dirty/saved visual feedback, one instance per card: amber "Unsaved
// changes" the moment any of that card's own fields change, replaced by a
// green "Saved" once its own Save click succeeds - and back to dirty again
// on the very next edit, rather than a stale "Saved." sitting there
// forever regardless of what's since changed (the previous behavior).
// Sean: "we need a bit more visual feedback in settings when we need to
// save and when we have saved."
const wireDirtyTracking = (statusEl, inputs) => {
  // kind: "dirty" | "success" | "error" | null - a plain status-line reuses
  // the same 3 semantic colors already established elsewhere (site-menu.js's
  // own setSiteMenuStatus), rather than inventing a second convention.
  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.classList.remove("status-dirty", "status-success", "status-error");
    if (kind) statusEl.classList.add(`status-${kind}`);
  };
  const markDirty = () => setStatus("Unsaved changes", "dirty");
  const markSaved = () => setStatus("✓ Saved", "success");
  const clear = () => setStatus("", null);
  for (const input of inputs) {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  }
  return { markDirty, markSaved, clear, setStatus };
};

const authorDirty = wireDirtyTracking(authorSettingsStatus, [authorDisplayNameInput]);
const tierDirty = wireDirtyTracking(tierSettingsStatus, [
  tierWebCap,
  tierWebQuality,
  tierHighCap,
  tierHighQuality,
  tierPostInternalCap,
  tierPostInternalQuality,
]);
const r2SiteDirty = wireDirtyTracking(r2SiteSettingsStatus, [r2Bucket, r2PublicUrlBase]);
const r2PersonalDirty = wireDirtyTracking(r2PersonalSettingsStatus, [
  r2Enabled,
  r2AccountId,
  r2AccessKeyId,
  r2SecretAccessKey,
]);
const gitAuthDirty = wireDirtyTracking(gitAuthSettingsStatus, [gitRemoteUrlInput, gitTokenInput, gitUsernameInput]);

// A masked password field gives no way to actually see what you just typed
// or pasted - Sean: "need to be able to unmask the PAT so you can see if
// it's changed." Toggles the field itself between password/text rather
// than showing a copy elsewhere, so there's only ever one value to look at.
const wireUnmaskToggle = (input, button) => {
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("active", show);
  });
};
wireUnmaskToggle(gitTokenInput, document.getElementById("git-token-toggle"));
wireUnmaskToggle(r2SecretAccessKey, document.getElementById("r2-secret-access-key-toggle"));

document.getElementById("open-settings").addEventListener("click", async () => {
  authorDirty.clear();
  try {
    const author = await invoke("get_author_settings");
    authorDisplayNameInput.value = author.displayName;
    setCurrentAuthorName(author.displayName);
  } catch (err) {
    authorSettingsStatus.textContent = "Couldn't load author settings: " + err;
  }

  tierDirty.clear();
  try {
    const tiers = await invoke("get_tier_settings");
    tierWebCap.value = tiers.webCap;
    tierWebQuality.value = tiers.webQuality;
    tierHighCap.value = tiers.highCap;
    tierHighQuality.value = tiers.highQuality;
    tierPostInternalCap.value = tiers.postInternalCap;
    tierPostInternalQuality.value = tiers.postInternalQuality;
  } catch (err) {
    tierSettingsStatus.textContent = "Couldn't load image size settings: " + err;
  }

  r2SiteDirty.clear();
  try {
    const r2Site = await invoke("get_r2_site_config");
    r2Bucket.value = r2Site.bucket;
    r2PublicUrlBase.value = r2Site.publicUrlBase;
  } catch (err) {
    r2SiteSettingsStatus.textContent = "Couldn't load bucket settings: " + err;
  }

  r2PersonalDirty.clear();
  try {
    const r2Personal = await invoke("get_r2_personal_config");
    r2Enabled.checked = r2Personal.enabled;
    r2AccountId.value = r2Personal.accountId;
    r2AccessKeyId.value = r2Personal.accessKeyId;
    r2SecretAccessKey.value = r2Personal.secretAccessKey;
  } catch (err) {
    r2PersonalSettingsStatus.textContent = "Couldn't load R2 credentials: " + err;
  }

  gitAuthDirty.clear();
  try {
    const [remoteUrl, gitAuth] = await Promise.all([
      invoke("git_get_remote_url"),
      invoke("get_git_auth_config"),
    ]);
    gitRemoteUrlInput.value = remoteUrl;
    gitTokenInput.value = gitAuth.token;
    gitUsernameInput.value = gitAuth.githubUsername;
    setCurrentGithubUsername(gitAuth.githubUsername);
  } catch (err) {
    gitAuthSettingsStatus.textContent = "Couldn't load GitHub sync settings: " + err;
  }
});

document.getElementById("save-author-settings").addEventListener("click", async () => {
  try {
    const displayName = authorDisplayNameInput.value.trim();
    await invoke("set_author_settings", { settings: { displayName } });
    setCurrentAuthorName(displayName);
    authorDirty.markSaved();
  } catch (err) {
    authorDirty.markDirty();
    showError(err);
  }
});

document.getElementById("save-tier-settings").addEventListener("click", async () => {
  try {
    await invoke("set_tier_settings", {
      settings: {
        webCap: Number(tierWebCap.value),
        webQuality: Number(tierWebQuality.value),
        highCap: Number(tierHighCap.value),
        highQuality: Number(tierHighQuality.value),
        postInternalCap: Number(tierPostInternalCap.value),
        postInternalQuality: Number(tierPostInternalQuality.value),
      },
    });
    tierDirty.markSaved();
  } catch (err) {
    tierDirty.markDirty();
    showError(err);
  }
});

// A pasted domain with no scheme (e.g. copied straight out of the
// Cloudflare custom-domain UI, which doesn't show one) would otherwise
// silently produce broken image references - default it to https://
// rather than rejecting the save.
const normalizeUrlBase = (value) => {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || /^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
};

document.getElementById("save-r2-site-settings").addEventListener("click", async () => {
  try {
    r2PublicUrlBase.value = normalizeUrlBase(r2PublicUrlBase.value);
    await invoke("set_r2_site_config", {
      settings: {
        bucket: r2Bucket.value,
        publicUrlBase: r2PublicUrlBase.value,
      },
    });
    r2SiteDirty.markSaved();
  } catch (err) {
    r2SiteDirty.markDirty();
    showError(err);
  }
});

document.getElementById("save-r2-personal-settings").addEventListener("click", async () => {
  try {
    await invoke("set_r2_personal_config", {
      settings: {
        enabled: r2Enabled.checked,
        accountId: r2AccountId.value,
        accessKeyId: r2AccessKeyId.value,
        secretAccessKey: r2SecretAccessKey.value,
      },
    });
    r2PersonalDirty.markSaved();
  } catch (err) {
    r2PersonalDirty.markDirty();
    showError(err);
  }
});

// Summarizes github_validate_token's result as one line. GitHub has no way
// to introspect a fine-grained token's own granted permissions (confirmed:
// unlike a classic token's X-OAuth-Scopes response header, fine-grained
// tokens expose nothing to inspect) - this only reports what it could
// actually test, by calling the lightest real endpoint each READ
// permission gates. Write access (Contents/Pull requests) isn't claimed
// either way - there's no safe way to check that without performing a real
// write just to find out.
const renderGithubTokenCheck = (token, check) => {
  if (!token) {
    gitAuthDirty.markSaved();
    return;
  }
  if (!check.valid) {
    gitAuthDirty.setStatus("Saved, but " + (check.error || "the token looks invalid"), "error");
    return;
  }
  const who = check.username ? ` as ${check.username}` : "";
  if (check.canReadContents == null) {
    gitAuthDirty.setStatus(`✓ Saved. Token valid${who}. Set a repository URL to check repo access too.`, "success");
    return;
  }
  const parts = [
    `Contents: read ${check.canReadContents ? "✓" : "✗"}`,
    `Pull requests: read ${check.canReadPullRequests ? "✓" : "✗"}`,
  ];
  const allGood = check.canReadContents && check.canReadPullRequests;
  gitAuthDirty.setStatus(
    `✓ Saved. Token valid${who}. ${parts.join(" · ")}` +
      (allGood ? "" : " - write access isn't checked here, but a missing read above means matching features won't work."),
    allGood ? "success" : "error"
  );
};

document.getElementById("save-git-auth-settings").addEventListener("click", async () => {
  try {
    const url = gitRemoteUrlInput.value.trim();
    if (url) {
      await invoke("git_set_remote_url", { url });
    }
    const githubUsername = gitUsernameInput.value.trim();
    const token = gitTokenInput.value;
    await invoke("set_git_auth_config", { token, githubUsername });
    setCurrentGithubUsername(githubUsername);

    if (!token) {
      gitAuthDirty.markSaved();
      return;
    }
    gitAuthDirty.setStatus("Saved. Checking the token against GitHub...", null);
    const check = await invoke("github_validate_token", { token });
    renderGithubTokenCheck(token, check);
  } catch (err) {
    gitAuthDirty.markDirty();
    showError(err);
  }
});

// A plain <a target="_blank"> doesn't reliably open the system's default
// browser from inside this app's webview - found the hard way testing this
// link. shell:allow-open (capabilities/default.json) lets this app hand the
// URL to the OS instead.
document.getElementById("github-token-help-link").addEventListener("click", (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open(e.currentTarget.href);
});
