// Local drafts (branch switching/creation), Review Changes (diff + commit +
// push/pull), and reviewing someone else's open pull request read-only -
// the git-facing UI built for pws-y8t, kept together since they share the
// review-mode state and the "flush the active tab, then do a git operation,
// then reload" pattern. Deliberately no merge/conflict-resolution UI
// anywhere here - Sean's call, for the foreseeable future a real divergence
// is handled by someone who knows git well enough to do it directly.

import {
  editorEl,
  fileSelect,
  activeTab,
  closeAllTabsQuietly,
  cancelTabAutosave,
  openTab,
  refreshFileList,
  askConfirm,
  wirePanelKeys,
  nowForZola,
  currentAuthorName,
  currentGithubUsername,
  banner,
  bannerMessage,
  reviewModeActive,
  setReviewModeActive,
} from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const localDraftsPanel = document.getElementById("local-drafts-panel");
const localDraftsList = document.getElementById("local-drafts-list");
const localDraftsDriftStatus = document.getElementById("local-drafts-drift-status");
const localDraftsNewName = document.getElementById("local-drafts-new-name");
const localDraftsStatus = document.getElementById("local-drafts-status");
const localDraftsButton = document.getElementById("local-drafts-button");
const localDraftsNormal = document.getElementById("local-drafts-normal");
const localDraftsReviewActive = document.getElementById("local-drafts-review-active");
const localDraftsReviewActiveMessage = document.getElementById("local-drafts-review-active-message");

// A top-level dialog of its own (beside "Branch: …" and "Review changes…"),
// not nested inside Local Drafts - found the hard way that nesting it two
// levels deep made it hard to discover at all.
const reviewPrPanel = document.getElementById("review-pr-panel");
const reviewPrNormal = document.getElementById("review-pr-normal");
const reviewPrReviewActive = document.getElementById("review-pr-review-active");
const reviewPrReviewActiveMessage = document.getElementById("review-pr-review-active-message");
const reviewPrList = document.getElementById("review-pr-list");
const reviewPrStatus = document.getElementById("review-pr-status");

const reviewModeBanner = document.getElementById("review-mode-banner");
const reviewModeHeaderBadge = document.getElementById("review-mode-header-badge");
const reviewModeMessage = document.getElementById("review-mode-message");
const reviewModeLink = document.getElementById("review-mode-link");
// Same reasoning as settings.js's help link - target="_blank" doesn't
// reliably open the system browser from inside this app's webview.
reviewModeLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (reviewModeLink.href && reviewModeLink.href !== "#" && !reviewModeLink.href.endsWith("/#")) {
    window.__TAURI__.shell.open(reviewModeLink.href);
  }
});

// reviewModeActive itself lives in editor-core.js (see its own comment for
// why) - Sean's call: reviewing someone else's work should never risk
// accidentally editing it, so this disables every content-mutating control
// in the app, not just the editor textarea itself. fmt-date/fmt-tags are
// deliberately NOT in this list - content-editing.js's own
// updateSectionAwareToolbar composes reviewModeActive with its section
// check for those two, so this list doesn't fight it over the same buttons.
const REVIEW_MODE_DISABLED_IDS = [
  "save",
  "rename-content",
  "delete-content",
  "new-post",
  "new-page",
  "review-changes-commit",
  "review-changes-push",
  "local-drafts-new-confirm",
  "fmt-bold",
  "fmt-italic",
  "fmt-code",
  "fmt-link",
  "fmt-h2",
  "fmt-h3",
  "fmt-quote",
  "fmt-ul",
  "fmt-ol",
  "fmt-image",
  "fmt-image-url",
];

const applyReviewModeUI = () => {
  const active = !!reviewModeActive;
  editorEl.readOnly = active;
  for (const id of REVIEW_MODE_DISABLED_IDS) {
    const el = document.getElementById(id);
    if (el) el.disabled = active;
  }
  // fmt-date/fmt-tags (and images.js's alignment toolbar) all key off this
  // same event for their own active-tab-dependent state - re-dispatching it
  // here means they recompute immediately on every review-mode transition,
  // not just on the next actual tab switch (which may not always follow
  // immediately - see updateSectionAwareToolbar's own comment).
  document.dispatchEvent(new Event("beedance:tab-changed"));
  localDraftsNormal.style.display = active ? "none" : "block";
  localDraftsReviewActive.style.display = active ? "block" : "none";
  reviewPrNormal.style.display = active ? "none" : "block";
  reviewPrReviewActive.style.display = active ? "block" : "none";
  reviewModeBanner.style.display = active ? "flex" : "none";
  // Broad, ambient signal (a frame around the whole window, a badge next
  // to the app's own title) so read-only mode is obvious regardless of
  // which part of the screen you're looking at - the banner alone was easy
  // to miss.
  document.body.classList.toggle("review-mode-active", active);
  reviewModeHeaderBadge.style.display = active ? "inline-block" : "none";
  if (active) {
    const message = `Reviewing PR #${reviewModeActive.number}: "${reviewModeActive.title}" by ${reviewModeActive.authorLogin}.`;
    localDraftsReviewActiveMessage.textContent = message;
    reviewPrReviewActiveMessage.textContent = message;
    reviewModeMessage.textContent = message + " Read only - editing is disabled.";
    reviewModeLink.href = reviewModeActive.url;
  }
};

const describeDrift = (drift) => {
  if (!drift.liveBranch) return "No live-site branch detected yet.";
  if (!drift.hasRemote) {
    return `Live site (${drift.liveBranch}): no remote connected yet - set one up in Settings → GitHub sync.`;
  }
  if (drift.ahead === 0 && drift.behind === 0) {
    return `Live site (${drift.liveBranch}): up to date with the remote.`;
  }
  const parts = [];
  if (drift.behind > 0) parts.push(`${drift.behind} commit${drift.behind === 1 ? "" : "s"} behind`);
  if (drift.ahead > 0) parts.push(`${drift.ahead} commit${drift.ahead === 1 ? "" : "s"} ahead of`);
  return `Live site (${drift.liveBranch}): ${parts.join(" and ")} the remote.`;
};

const updateBranchIndicator = (branches) => {
  if (reviewModeActive) {
    localDraftsButton.textContent = `Reviewing PR #${reviewModeActive.number}`;
    return;
  }
  const current = branches.find((b) => b.isCurrent);
  localDraftsButton.textContent = "Branch: " + (current ? (current.isLive ? "Live site" : current.name) : "…");
};

const renderLocalDraftsList = (branches) => {
  localDraftsList.innerHTML = "";
  for (const branch of branches) {
    const row = document.createElement("div");
    row.className = "review-row" + (branch.isCurrent ? " active" : "");
    const label = document.createElement("span");
    label.className = "review-row-path";
    label.textContent = branch.isLive ? `Live site (${branch.name})` : branch.name;
    const status = document.createElement("span");
    status.className = "review-row-status";
    status.textContent = branch.isCurrent ? "current" : "";
    row.appendChild(label);
    row.appendChild(status);
    if (!branch.isCurrent) {
      row.addEventListener("click", () => switchDraft(branch.name));
    }
    localDraftsList.appendChild(row);
  }
};

const refreshLocalDrafts = async () => {
  try {
    const branches = await invoke("git_list_local_branches");
    renderLocalDraftsList(branches);
    updateBranchIndicator(branches);
  } catch (err) {
    localDraftsStatus.textContent = "ERROR: " + err;
  }
  localDraftsDriftStatus.textContent = "Checking the live site for updates...";
  try {
    const drift = await invoke("git_check_main_drift");
    localDraftsDriftStatus.textContent = describeDrift(drift);
  } catch (err) {
    localDraftsDriftStatus.textContent = "Couldn't check the live site for updates: " + err;
  }
};

// Flushes the active tab's in-progress edits to disk first (matching
// rename_content's own flush-before-operating pattern) - otherwise
// switching branches would either silently carry uncommitted edits onto
// the new draft or lose them, depending on whether the target file
// happens to differ.
const switchDraft = async (name) => {
  const proceed = await askConfirm(
    "Switch drafts?",
    `Switch to "${name}"? Open tabs close and reload from that draft.`,
    "Switch"
  );
  if (!proceed) return;
  localDraftsStatus.textContent = "Switching...";
  try {
    if (activeTab) {
      // Cancels any pending debounced autosave for this tab first - it
      // would otherwise fire ~1.2s from now, after the checkout below,
      // and land on whatever branch happens to be checked out by then.
      // write_file itself is a no-op if nothing was actually typed (see
      // its own doc comment), so this is safe to call unconditionally.
      cancelTabAutosave(activeTab);
      await invoke("write_file", {
        path: activeTab,
        content: editorEl.value,
        datetime: nowForZola(),
        author: currentAuthorName,
      });
    }
    await invoke("git_checkout_branch", { branch: name });
    closeAllTabsQuietly();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    localDraftsStatus.textContent = `Switched to "${name}".`;
    await refreshLocalDrafts();
  } catch (err) {
    localDraftsStatus.textContent = "ERROR: " + err;
  }
};

const renderPrList = (prs) => {
  reviewPrList.innerHTML = "";
  const others = prs.filter(
    (pr) => !currentGithubUsername || pr.authorLogin.toLowerCase() !== currentGithubUsername.toLowerCase()
  );
  if (others.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size: 12px; color: var(--muted);";
    empty.textContent = currentGithubUsername
      ? "No open pull requests from anyone else right now."
      : "No open pull requests right now. Set your GitHub username in Settings to filter out your own.";
    reviewPrList.appendChild(empty);
    return;
  }
  for (const pr of others) {
    const row = document.createElement("div");
    row.className = "review-row";
    const label = document.createElement("span");
    label.className = "review-row-path";
    label.textContent = `#${pr.number} ${pr.title}`;
    const status = document.createElement("span");
    status.className = "review-row-status";
    status.textContent = pr.sameRepo ? `by ${pr.authorLogin}` : `by ${pr.authorLogin} (fork, unsupported)`;
    row.appendChild(label);
    row.appendChild(status);
    if (pr.sameRepo) {
      row.addEventListener("click", () => startReviewingPr(pr));
    } else {
      row.style.opacity = "0.6";
      row.style.cursor = "default";
    }
    reviewPrList.appendChild(row);
  }
};

document.getElementById("review-pr-button").addEventListener("click", async () => {
  reviewPrStatus.textContent = "";
  reviewPrPanel.style.display = "flex";
});

document.getElementById("review-pr-close").addEventListener("click", () => {
  reviewPrPanel.style.display = "none";
});

document.getElementById("review-pr-load").addEventListener("click", async () => {
  reviewPrList.innerHTML = "";
  reviewPrStatus.textContent = "Loading pull requests...";
  try {
    const prs = await invoke("github_list_open_prs");
    renderPrList(prs);
    reviewPrStatus.textContent = "";
  } catch (err) {
    reviewPrStatus.textContent = "ERROR: " + err;
  }
});

// Same flush-then-close-tabs pattern as switchDraft, plus entering
// review mode once the checkout succeeds.
const startReviewingPr = async (pr) => {
  const proceed = await askConfirm(
    "Review this pull request?",
    `Switch to "#${pr.number} ${pr.title}" by ${pr.authorLogin}? Open tabs close and reload read-only.`,
    "Review"
  );
  if (!proceed) return;
  reviewPrStatus.textContent = "Loading...";
  try {
    if (activeTab) {
      cancelTabAutosave(activeTab);
      await invoke("write_file", {
        path: activeTab,
        content: editorEl.value,
        datetime: nowForZola(),
        author: currentAuthorName,
      });
    }
    await invoke("git_checkout_remote_branch", { branch: pr.branch });
    closeAllTabsQuietly();
    setReviewModeActive({ number: pr.number, title: pr.title, authorLogin: pr.authorLogin, url: pr.url });
    applyReviewModeUI();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    reviewPrPanel.style.display = "none";
    reviewPrStatus.textContent = "";
  } catch (err) {
    reviewPrStatus.textContent = "ERROR: " + err;
  }
};

const exitReviewMode = async () => {
  localDraftsStatus.textContent = "Exiting review...";
  try {
    const branches = await invoke("git_list_local_branches");
    const live = branches.find((b) => b.isLive);
    if (live) {
      await invoke("git_checkout_branch", { branch: live.name });
    }
    closeAllTabsQuietly();
    setReviewModeActive(null);
    applyReviewModeUI();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    localDraftsStatus.textContent = "";
    await refreshLocalDrafts();
  } catch (err) {
    localDraftsStatus.textContent = "ERROR: " + err;
  }
};

document.getElementById("local-drafts-exit-review-inline").addEventListener("click", exitReviewMode);
document.getElementById("review-pr-exit-review-inline").addEventListener("click", exitReviewMode);
document.getElementById("review-mode-exit").addEventListener("click", exitReviewMode);

document.getElementById("local-drafts-button").addEventListener("click", async () => {
  localDraftsStatus.textContent = "";
  localDraftsPanel.style.display = "flex";
  await refreshLocalDrafts();
});

document.getElementById("local-drafts-close").addEventListener("click", () => {
  localDraftsPanel.style.display = "none";
});

const createNewDraft = async () => {
  const name = localDraftsNewName.value.trim();
  if (!name) {
    localDraftsStatus.textContent = "Enter a name for the new draft first.";
    return;
  }
  localDraftsStatus.textContent = "Creating...";
  try {
    if (activeTab) {
      cancelTabAutosave(activeTab);
      await invoke("write_file", {
        path: activeTab,
        content: editorEl.value,
        datetime: nowForZola(),
        author: currentAuthorName,
      });
    }
    await invoke("start_draft", { name });
    localDraftsNewName.value = "";
    closeAllTabsQuietly();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    localDraftsStatus.textContent = "New draft created.";
    await refreshLocalDrafts();
  } catch (err) {
    localDraftsStatus.textContent = "ERROR: " + err;
  }
};

document.getElementById("local-drafts-new-confirm").addEventListener("click", createNewDraft);
localDraftsNewName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createNewDraft();
  }
});

// Review changes: a real changed-file list (from git_changed_files)
// instead of the raw "git status" text the debug tools section already
// shows - a non-technical author has no reason to read porcelain codes.
const reviewChangesPanel = document.getElementById("review-changes-panel");
const reviewChangesList = document.getElementById("review-changes-list");
const reviewChangesDiff = document.getElementById("review-changes-diff");
const reviewChangesStatus = document.getElementById("review-changes-status");
const reviewChangesCommitMsg = document.getElementById("review-changes-commit-msg");
let reviewChangesFiles = [];
let reviewChangesSelected = null;

const REVIEW_STATUS_LABELS = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "New",
};

const renderReviewChangesList = () => {
  reviewChangesList.innerHTML = "";
  if (reviewChangesFiles.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size: 12px; color: var(--muted); padding: 6px;";
    empty.textContent = "No changes since the last commit.";
    reviewChangesList.appendChild(empty);
    return;
  }
  for (const file of reviewChangesFiles) {
    const row = document.createElement("div");
    row.className = "review-row" + (file.path === reviewChangesSelected ? " active" : "");
    const pathSpan = document.createElement("span");
    pathSpan.className = "review-row-path";
    pathSpan.textContent = file.path;
    const statusSpan = document.createElement("span");
    statusSpan.className = "review-row-status";
    statusSpan.textContent = REVIEW_STATUS_LABELS[file.status] || file.status;
    row.appendChild(pathSpan);
    row.appendChild(statusSpan);
    row.addEventListener("click", () => selectReviewChangesFile(file.path));
    reviewChangesList.appendChild(row);
  }
};

const selectReviewChangesFile = async (path) => {
  reviewChangesSelected = path;
  renderReviewChangesList();
  reviewChangesDiff.textContent = "Loading...";
  try {
    reviewChangesDiff.textContent = await invoke("git_diff_for_file", { path });
  } catch (err) {
    reviewChangesDiff.textContent = "ERROR: " + err;
  }
};

const refreshReviewChanges = async () => {
  reviewChangesFiles = await invoke("git_changed_files");
  if (!reviewChangesFiles.some((f) => f.path === reviewChangesSelected)) {
    reviewChangesSelected = null;
    reviewChangesDiff.textContent = "Select a file to see its changes.";
  }
  renderReviewChangesList();
};

document.getElementById("review-changes").addEventListener("click", async () => {
  reviewChangesStatus.textContent = "";
  reviewChangesCommitMsg.value = "";
  reviewChangesPanel.style.display = "flex";
  try {
    await refreshReviewChanges();
  } catch (err) {
    reviewChangesStatus.textContent = "ERROR: " + err;
  }
});

document.getElementById("review-changes-close").addEventListener("click", () => {
  reviewChangesPanel.style.display = "none";
});

document.getElementById("review-changes-commit").addEventListener("click", async () => {
  const message = reviewChangesCommitMsg.value.trim();
  if (!message) {
    reviewChangesStatus.textContent = "Describe what changed first.";
    return;
  }
  reviewChangesStatus.textContent = "Committing...";
  try {
    await invoke("git_commit", { message });
    reviewChangesCommitMsg.value = "";
    reviewChangesStatus.textContent = "Committed.";
    await refreshReviewChanges();
  } catch (err) {
    reviewChangesStatus.textContent = "ERROR: " + err;
  }
});

document.getElementById("review-changes-pull").addEventListener("click", async () => {
  reviewChangesStatus.textContent = "Getting the latest changes...";
  try {
    await invoke("git_pull");
    await refreshReviewChanges();
    await refreshFileList();
    // Picks up anything the pull changed in the file currently open -
    // reload's own click handler is a no-op with nothing open.
    document.getElementById("reload").click();
    reviewChangesStatus.textContent = "Up to date.";
  } catch (err) {
    reviewChangesStatus.textContent = "ERROR: " + err;
  }
});

document.getElementById("review-changes-push").addEventListener("click", async () => {
  reviewChangesStatus.textContent = "Sending changes...";
  try {
    await invoke("git_push");
    reviewChangesStatus.textContent = "Sent.";
  } catch (err) {
    reviewChangesStatus.textContent = "ERROR: " + err;
  }
});

// Someone switched branches from outside the app (a terminal `git
// checkout`, most likely) - every open tab's content may now belong to a
// different branch entirely, so those get closed without an attempted
// save (saving now would write the OLD branch's buffer onto the NEW
// branch's files) rather than just flagged, unlike a single file's
// external-edit banner.
const { listen } = window.__TAURI__.event;

listen("branch-changed", async () => {
  try {
    closeAllTabsQuietly();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    await refreshLocalDrafts();
    bannerMessage.textContent = "The checked-out branch changed outside the app - reloaded.";
    banner.style.display = "block";
  } catch (err) {
    console.error("couldn't refresh after an external branch change:", err);
  }
});

wirePanelKeys(reviewChangesPanel, "review-changes-commit", "review-changes-close");
wirePanelKeys(localDraftsPanel, null, "local-drafts-close");
wirePanelKeys(reviewPrPanel, null, "review-pr-close");

// Startup drift check, per pws-y8t's design - a network call (fetch
// against origin) when a remote's configured, so this runs in the
// background rather than blocking the rest of startup on it.
refreshLocalDrafts();
