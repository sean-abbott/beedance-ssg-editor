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
  reloadTabFromDisk,
  refreshFileList,
  askConfirm,
  nowForZola,
  currentAuthorName,
  currentGithubUsername,
  banner,
  bannerMessage,
  reviewModeActive,
  setReviewModeActive,
  describeGitError,
  formatUncheckpointedFilesMessage,
  showError,
} from "./editor-core.js";
import { makeIcon } from "./icons.js";
import { showAppMainPage } from "./menus.js";

const { invoke } = window.__TAURI__.core;

const localDraftsList = document.getElementById("local-drafts-list");
const localDraftsDriftStatus = document.getElementById("local-drafts-drift-status");
const localDraftsNewName = document.getElementById("local-drafts-new-name");
const localDraftsStatus = document.getElementById("local-drafts-status");
// The persistent header pill (every page, not just Editor/Drafts) - only
// this inner label span's text updates, so an update never clobbers the
// branch icon sitting beside it. Lives in the header rather than being
// gated behind the Drafts page itself for the same reason Start/Stop
// preview live there (pws-898q): which draft you're on is a global,
// not-page-scoped concern.
const headerDraftIndicator = document.getElementById("header-draft-indicator");
const headerDraftIndicatorLabel = document.getElementById("header-draft-indicator-label");
headerDraftIndicator.addEventListener("click", (e) => {
  e.preventDefault();
  showAppMainPage("drafts");
});
const localDraftsNormal = document.getElementById("local-drafts-normal");
const localDraftsReviewActive = document.getElementById("local-drafts-review-active");
const localDraftsReviewActiveMessage = document.getElementById("local-drafts-review-active-message");

// A permanent section of its own on the Drafts page (beside Switch draft and
// Review changes), not nested inside either - found the hard way that
// nesting it two levels deep (the old modal) made it hard to discover at all.
const reviewPrNormal = document.getElementById("review-pr-normal");
const reviewPrReviewActive = document.getElementById("review-pr-review-active");
const reviewPrReviewActiveMessage = document.getElementById("review-pr-review-active-message");
const reviewPrGithubLink = document.getElementById("review-pr-github-link");
const reviewPrList = document.getElementById("review-pr-list");
const reviewPrStatus = document.getElementById("review-pr-status");
const reviewPrApprove = document.getElementById("review-pr-approve");
const reviewPrApproveStatus = document.getElementById("review-pr-approve-status");
// The read-only "what's changed" diff shown while reviewing - same list+diff
// pattern as the Review changes card, but diffing the checked-out PR branch
// against the live branch (review_changed_files/review_diff_for_file),
// never the working tree (git_changed_files/git_diff_for_file) - a freshly
// checked-out branch has nothing uncommitted to show there at all.
const reviewPrDiffList = document.getElementById("review-pr-diff-list");
const reviewPrDiffContent = document.getElementById("review-pr-diff-content");
const reviewPrFeedbackText = document.getElementById("review-pr-feedback-text");
const reviewPrFeedbackStatus = document.getElementById("review-pr-feedback-status");
let reviewPrDiffFiles = [];
let reviewPrDiffSelected = null;

// Same reasoning as reviewModeLink below - target="_blank" doesn't reliably
// open the system browser from inside this app's webview.
reviewPrGithubLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (reviewPrGithubLink.href && reviewPrGithubLink.href !== "#" && !reviewPrGithubLink.href.endsWith("/#")) {
    window.__TAURI__.shell.open(reviewPrGithubLink.href);
  }
});

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
    reviewPrGithubLink.href = reviewModeActive.url;
    reviewPrApproveStatus.textContent = "";
    reviewPrApprove.disabled = false;
    reviewPrFeedbackText.value = "";
    reviewPrFeedbackStatus.textContent = "";
    refreshReviewPrDiff().catch((err) => showError(err));
    // Otherwise the header pill keeps showing whatever branch was current
    // before entering review mode until something else happens to call
    // refreshLocalDrafts (e.g. navigating to Drafts) - Sean: "the branch
    // picker doesn't change." updateBranchIndicator ignores its argument
    // entirely when reviewModeActive is set, so no real branch list is
    // needed here. Exiting doesn't need the same call - exitReviewMode
    // already ends with a real refreshLocalDrafts() that updates this from
    // actual branch data.
    updateBranchIndicator();
  }
};

reviewPrApprove.addEventListener("click", async () => {
  if (!reviewModeActive) return;
  reviewPrApproveStatus.textContent = "Submitting approval...";
  reviewPrApprove.disabled = true;
  try {
    await invoke("github_approve_pull_request", { prNumber: reviewModeActive.number });
    reviewPrApproveStatus.textContent = "Approved.";
  } catch (err) {
    reviewPrApprove.disabled = false;
    reviewPrApproveStatus.textContent = "";
    showError(describeGitError(err));
  }
});

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
    headerDraftIndicatorLabel.textContent = `Reviewing PR #${reviewModeActive.number}`;
    headerDraftIndicator.classList.add("on-draft");
    return;
  }
  const current = branches.find((b) => b.isCurrent);
  // "main" (the live site) is the calm/neutral state - the pill only pops
  // for anything else, per Sean's repeated ask for the current draft to be
  // "more visually obvious" when it's NOT main.
  const onLive = !current || current.isLive;
  headerDraftIndicatorLabel.textContent = current ? (current.isLive ? "main" : current.name) : "…";
  headerDraftIndicator.classList.toggle("on-draft", !onLive);
};

const renderLocalDraftsList = (branches) => {
  localDraftsList.innerHTML = "";
  for (const branch of branches) {
    const row = document.createElement("div");
    row.className = "review-row" + (branch.isCurrent ? " active" : "");
    row.appendChild(makeIcon("branch", "review-row-status-icon"));
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

// Checking out a different branch fails hard (a raw git error) if ANY
// tracked file has changes that would be overwritten - not just the active
// tab's own edits. Autosave writes to disk immediately, which is a
// separate step from checkpointing (committing) - so a file edited earlier
// in this session, then left alone, can silently block a switch with no
// warning otherwise. Checked proactively, in the same plain checkpoint
// language this app already uses (see the Review changes card's own
// copy), rather than only reacting to git's own error after the fact -
// describeGitError (editor-core.js) still translates that raw error too,
// as a backstop for whatever slips past this check (e.g. a file changed
// outside the app in the moment between this check and the checkout
// itself). Call this AFTER flushing the active tab, not before - the
// flush's own write needs to already be on disk for this check to see it.
const ensureNoUncheckpointedChanges = async () => {
  const changed = await invoke("git_changed_files");
  if (changed.length === 0) return true;
  showError(formatUncheckpointedFilesMessage(changed.map((f) => f.path)));
  return false;
};


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
    if (!(await ensureNoUncheckpointedChanges())) {
      localDraftsStatus.textContent = "";
      return;
    }
    await invoke("git_checkout_branch", { branch: name });
    closeAllTabsQuietly();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    localDraftsStatus.textContent = `Switched to "${name}".`;
    await refreshLocalDrafts();
  } catch (err) {
    localDraftsStatus.textContent = "";
    showError(describeGitError(err));
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
    row.appendChild(makeIcon("pull-request", "review-row-status-icon"));
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

// The read-only diff shown while actively reviewing a PR - same list+diff
// pattern as the Review changes card, but against review_changed_files/
// review_diff_for_file (the checked-out branch vs. the live branch), not
// git_changed_files/git_diff_for_file (the working tree vs. the index,
// which is empty right after a clean checkout - there's nothing
// "uncommitted" to show for someone else's already-committed draft).
const renderReviewPrDiffList = () => {
  reviewPrDiffList.innerHTML = "";
  if (reviewPrDiffFiles.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size: 12px; color: var(--muted); padding: 6px;";
    empty.textContent = "This draft doesn't change anything yet.";
    reviewPrDiffList.appendChild(empty);
    return;
  }
  for (const file of reviewPrDiffFiles) {
    const row = document.createElement("div");
    row.className = `review-row status-${file.status}` + (file.path === reviewPrDiffSelected ? " active" : "");
    row.appendChild(makeIcon(REVIEW_STATUS_ICONS[file.status] || "doc", "review-row-status-icon"));
    const pathSpan = document.createElement("span");
    pathSpan.className = "review-row-path";
    pathSpan.textContent = file.path;
    const statusSpan = document.createElement("span");
    statusSpan.className = "review-row-status";
    statusSpan.textContent = REVIEW_STATUS_LABELS[file.status] || file.status;
    row.appendChild(pathSpan);
    row.appendChild(statusSpan);
    row.addEventListener("click", () => selectReviewPrDiffFile(file.path));
    reviewPrDiffList.appendChild(row);
  }
};

const selectReviewPrDiffFile = async (path) => {
  reviewPrDiffSelected = path;
  renderReviewPrDiffList();
  reviewPrDiffContent.textContent = "Loading...";
  try {
    reviewPrDiffContent.textContent = await invoke("review_diff_for_file", { path });
  } catch (err) {
    reviewPrDiffContent.textContent = "ERROR: " + err;
  }
};

const refreshReviewPrDiff = async () => {
  reviewPrDiffFiles = await invoke("review_changed_files");
  reviewPrDiffSelected = null;
  reviewPrDiffContent.textContent = "Select a file to see its changes.";
  renderReviewPrDiffList();
};

document.getElementById("review-pr-feedback-submit").addEventListener("click", async () => {
  const comment = reviewPrFeedbackText.value.trim();
  if (!comment) {
    reviewPrFeedbackStatus.textContent = "Write something first.";
    return;
  }
  if (!reviewModeActive) return;
  const body = reviewPrDiffSelected ? `On \`${reviewPrDiffSelected}\`:\n\n${comment}` : comment;
  reviewPrFeedbackStatus.textContent = "Posting...";
  try {
    await invoke("github_create_pr_comment", { prNumber: reviewModeActive.number, body });
    reviewPrFeedbackText.value = "";
    reviewPrFeedbackStatus.textContent = "Posted.";
  } catch (err) {
    reviewPrFeedbackStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("review-pr-load").addEventListener("click", async () => {
  reviewPrList.innerHTML = "";
  reviewPrStatus.textContent = "Loading pull requests...";
  try {
    const prs = await invoke("github_list_open_prs");
    renderPrList(prs);
    reviewPrStatus.textContent = "";
  } catch (err) {
    reviewPrStatus.textContent = "";
    showError(err);
  }
});

// Same flush-then-close-tabs pattern as switchDraft, plus entering
// review mode once the checkout succeeds.
const startReviewingPr = async (pr) => {
  // Backstop for whatever got the row rendered/clickable despite no token
  // being configured (reviewPrCard is hidden without one, so this
  // shouldn't normally be reachable) - same reasoning as
  // ensureNoUncheckpointedChanges: block up front with a clear message
  // rather than let Comment/Approve fail later with their own separate
  // errors.
  if (!(await hasGithubToken())) {
    showError(
      "Reviewing someone's draft needs a personal access token with \"Pull requests\" read and write " +
        "access (Settings → GitHub sync) - set one up first."
    );
    return;
  }
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
    if (!(await ensureNoUncheckpointedChanges())) {
      reviewPrStatus.textContent = "";
      return;
    }
    await invoke("git_checkout_remote_branch", { branch: pr.branch });
    closeAllTabsQuietly();
    setReviewModeActive({ number: pr.number, title: pr.title, authorLogin: pr.authorLogin, url: pr.url });
    applyReviewModeUI();
    await refreshFileList();
    if (fileSelect.value) await openTab(fileSelect.value);
    reviewPrStatus.textContent = "";
  } catch (err) {
    reviewPrStatus.textContent = "";
    showError(describeGitError(err));
  }
};

const exitReviewMode = async () => {
  localDraftsStatus.textContent = "Exiting review...";
  try {
    // Editing is disabled during review (readOnly), so this shouldn't
    // normally find anything - checked anyway for the same reason as
    // switchDraft/startReviewingPr: defense against whatever edge case
    // left something uncheckpointed, rather than surfacing a raw git error.
    if (!(await ensureNoUncheckpointedChanges())) {
      localDraftsStatus.textContent = "";
      return;
    }
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
    localDraftsStatus.textContent = "";
    showError(describeGitError(err));
  }
};

document.getElementById("local-drafts-exit-review-inline").addEventListener("click", exitReviewMode);
document.getElementById("review-pr-exit-review-inline").addEventListener("click", exitReviewMode);
document.getElementById("review-mode-exit").addEventListener("click", exitReviewMode);

// The Switch-draft/Review-changes/Sync sections are now permanent
// Drafts-page content (not modals opened on demand) - loaded on
// page-changed below, same pattern as every other sidebar page's own list.
document.addEventListener("beedance:page-changed", (e) => {
  if (e.detail.page !== "drafts") return;
  refreshLocalDrafts();
  reviewChangesCommitMsg.value = "";
  reviewChangesStatus.textContent = "";
  refreshReviewChanges().catch((err) => showError(err));
  // Only relevant in the "normal" (not actively reviewing) state - the list
  // this loads is hidden while reviewModeActive anyway.
  if (!reviewModeActive) updateReviewPrAvailability().catch((err) => showError(err));
});

const reviewPrNoTokenNotice = document.getElementById("review-pr-no-token-notice");
const reviewPrCard = document.getElementById("review-pr-card");

// Listing open PRs technically works unauthenticated (rate-limited), but
// the whole point of reviewing here is leaving feedback or approving,
// which both hard-require a token (github.rs's github_api_post refuses
// outright with no token) - letting someone get partway into a read-only
// checkout only to hit a wall on Comment/Approve is worse than not
// offering the interface at all. Sean: "I feel like we should block even
// the review interface when the PAT isn't set up yet."
const hasGithubToken = async () => !!(await invoke("get_git_auth_config")).token;

const updateReviewPrAvailability = async () => {
  const available = await hasGithubToken();
  reviewPrNoTokenNotice.style.display = available ? "none" : "block";
  reviewPrCard.style.display = available ? "block" : "none";
  if (available) document.getElementById("review-pr-load").click();
  return available;
};

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
    localDraftsStatus.textContent = "";
    showError(err);
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
// A permanent Drafts-page section now, not a modal - see pws-662d.2.
const reviewChangesList = document.getElementById("review-changes-list");
const reviewChangesDiff = document.getElementById("review-changes-diff");
const reviewChangesStatus = document.getElementById("review-changes-status");
const reviewChangesCommitMsg = document.getElementById("review-changes-commit-msg");
// Separate from reviewChangesStatus - Commit's own status sits with the
// Review changes card it belongs to; Sync (pull/push) gets its own line in
// the Sync card instead of a message appearing in a different card than
// the buttons that produced it.
const reviewSyncStatus = document.getElementById("review-sync-status");
let reviewChangesFiles = [];
let reviewChangesSelected = null;

const REVIEW_STATUS_LABELS = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "New",
};

const REVIEW_STATUS_ICONS = {
  modified: "pencil",
  added: "doc-post",
  deleted: "trash",
  renamed: "doc",
  untracked: "doc-post",
};

// Discarding is a real, irreversible loss of whatever that file's own
// uncommitted edits were - Sean: "we're gonna need a way to revert
// uncommitted files", the diff view had no way to back out of an edit
// short of retyping it by hand. Confirmed per-file rather than offering a
// blanket "discard everything" - less to lose in one click, and a rename
// is explicitly unsupported here (git_discard_file's own doc comment).
const discardReviewChangesFile = async (path) => {
  const proceed = await askConfirm(
    "Discard changes?",
    `Discard every uncommitted change to "${path}"? This can't be undone.`,
    "Discard"
  );
  if (!proceed) return;
  try {
    await invoke("git_discard_file", { path });
    if (path === reviewChangesSelected) reviewChangesSelected = null;
    // If this file is also open as a tab, its in-memory buffer still has
    // the just-discarded edit - left alone, the NEXT autosave (or even just
    // switching branches, which flushes the active tab first) would
    // silently write that stale content right back to disk, making the
    // discard look like it never took effect.
    await reloadTabFromDisk(path);
    await refreshReviewChanges();
  } catch (err) {
    showError(err);
  }
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
  const isReviewing = reviewModeActive != null;
  for (const file of reviewChangesFiles) {
    const row = document.createElement("div");
    row.className = `review-row status-${file.status}` + (file.path === reviewChangesSelected ? " active" : "");
    row.appendChild(makeIcon(REVIEW_STATUS_ICONS[file.status] || "doc", "review-row-status-icon"));
    const pathSpan = document.createElement("span");
    pathSpan.className = "review-row-path";
    pathSpan.textContent = file.path;
    const statusSpan = document.createElement("span");
    statusSpan.className = "review-row-status";
    statusSpan.textContent = REVIEW_STATUS_LABELS[file.status] || file.status;
    row.appendChild(pathSpan);
    row.appendChild(statusSpan);

    const discardBlocked = isReviewing || file.status === "renamed";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "secondary btn-icon";
    discard.title = file.status === "renamed" ? "Can't discard a rename here - ask for git help" : "Discard changes to this file";
    discard.disabled = discardBlocked;
    discard.appendChild(makeIcon("trash"));
    discard.addEventListener("click", (e) => {
      e.stopPropagation();
      discardReviewChangesFile(file.path);
    });
    row.appendChild(discard);

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
    reviewChangesStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("review-changes-pull").addEventListener("click", async () => {
  reviewSyncStatus.textContent = "Getting the latest changes...";
  try {
    await invoke("git_pull");
    await refreshReviewChanges();
    await refreshFileList();
    // Picks up anything the pull changed in the file currently open -
    // reload's own click handler is a no-op with nothing open.
    document.getElementById("reload").click();
    reviewSyncStatus.textContent = "Up to date.";
  } catch (err) {
    reviewSyncStatus.textContent = "";
    showError(describeGitError(err));
  }
});

document.getElementById("review-changes-push").addEventListener("click", async () => {
  reviewSyncStatus.textContent = "Sending changes...";
  try {
    await invoke("git_push");
    reviewSyncStatus.textContent = "Sent. Opening a pull request for review...";
    try {
      const branch = await invoke("current_branch");
      const pr = await invoke("github_create_pull_request", { title: branch, body: "" });
      reviewSyncStatus.textContent = `Sent. Pull request #${pr.number} is up for review.`;
    } catch (prErr) {
      // The branch itself sent fine - a PR is a separate, best-effort step
      // on top of that, most commonly missing because no personal access
      // token is configured yet (see github_create_pull_request's own
      // errors) - so this doesn't get treated as the push itself failing.
      reviewSyncStatus.textContent = "Sent, but couldn't open a pull request: " + prErr;
    }
  } catch (err) {
    reviewSyncStatus.textContent = "";
    showError(describeGitError(err));
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

// Startup drift check, per pws-y8t's design - a network call (fetch
// against origin) when a remote's configured, so this runs in the
// background rather than blocking the rest of startup on it.
refreshLocalDrafts();
