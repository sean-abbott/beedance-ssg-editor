// Editor/tab core: the file-list, per-tab buffer/dirty/autosave state, and
// the small bits of generic panel infrastructure (askConfirm, wirePanelKeys)
// every other feature module builds on. Split out of the former single
// index.html script (see pws-zg1h) - this is the module every other one
// depends on, not the other way around.

const { invoke } = window.__TAURI__.core;

// Translates common raw git/SSH failure text into something a non-technical
// person can actually act on. Found the necessity the hard way: even a
// working developer (Dave) got stuck on a stale SSH host-key fingerprint
// warning from GitHub's own real 2024 key rotation - completely opaque
// unless you already know what a host key fingerprint is. Someone who isn't
// technical has no path forward at all from git's own wording, so every
// recognized SSH failure here points at the one escape hatch this app CAN
// fully drive: switching to the HTTPS repository link with a personal
// access token (Settings -> GitHub sync), which sidesteps SSH entirely.
// Unrecognized errors pass through unchanged rather than being hidden.
export function describeGitError(rawError) {
  const text = String(rawError);
  if (/host key verification failed/i.test(text) || /REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return (
      "GitHub's identity doesn't match what this computer already trusts for SSH - a security check, " +
      "not necessarily anything wrong. This needs someone comfortable with SSH to sort out on this " +
      "machine, or switch to the HTTPS repository link with a personal access token instead (Settings " +
      "→ GitHub sync), which avoids SSH entirely.\n\nRaw error: " + text
    );
  }
  if (/permission denied \(publickey\)/i.test(text)) {
    return (
      "This computer doesn't have an SSH key GitHub recognizes for this repository. Use the HTTPS " +
      "repository link with a personal access token instead (Settings → GitHub sync), or have " +
      "someone set up an SSH key here.\n\nRaw error: " + text
    );
  }
  if (/could not resolve host/i.test(text)) {
    return "Couldn't reach GitHub - check the internet connection on this machine.\n\nRaw error: " + text;
  }
  return text;
}

export const fileSelect = document.getElementById("file-select");
export const editorEl = document.getElementById("editor");
const tabBar = document.getElementById("tab-bar");
export const statusEl = document.getElementById("editor-status");
export const banner = document.getElementById("external-change-banner");
export const bannerMessage = document.getElementById("external-change-message");
const saveButton = document.getElementById("save");
const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");

// Every open file is its own tab with its own buffer/dirty/autosave-timer/
// external-change state, keyed by site-relative path.
export const tabs = new Map();
export let activeTab = null;
export function setActiveTab(path) {
  activeTab = path;
}
const AUTOSAVE_DELAY_MS = 1200;

// Session identity state - lives here (not in settings.js, which loads/
// saves it) so every module that needs to read it can depend on core.js
// alone, rather than core.js and settings.js needing each other (settings.js
// already needs wirePanelKeys from core.js for its own dialog).
export let currentAuthorName = "";
export function setCurrentAuthorName(name) {
  currentAuthorName = name;
}
export let currentGithubUsername = "";
export function setCurrentGithubUsername(name) {
  currentGithubUsername = name;
}

// Non-null while looking at someone else's open pull request read-only -
// {number, title, authorLogin, url} (see git-workflow.js, which owns
// entering/exiting review mode). Lives here, not there, so content-
// editing.js's own section-aware toolbar guard (fmt-date/fmt-tags) can
// compose with it directly instead of both independently fighting over the
// same buttons' .disabled state.
export let reviewModeActive = null;
export function setReviewModeActive(value) {
  reviewModeActive = value;
}

// Zola's `date` field is naive (no timezone) and this app's users are a
// single local group, so "now" means the browser's own local wall-clock
// time, formatted the same way whether it's an auto-stamp (create_post)
// or a manual edit (the date panel) - one shared source of truth instead
// of the two drifting apart.
export const pad2 = (n) => String(n).padStart(2, "0");
export const nowForZola = () => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
};

// "Titles" mode groups files by their site section (using each page's
// own front-matter title) so browsing feels like the site's real
// structure instead of raw content/ paths. "Paths" mode
// is the original flat, raw-path list, for technical use.
let fileListMode = "titles";
const fileListModeToggle = document.getElementById("file-list-mode-toggle");

const GROUP_ORDER_FIRST = "Home";
const GROUP_ORDER_LAST = "Templates";

const populateFileSelectGrouped = (entries) => {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === GROUP_ORDER_FIRST) return -1;
    if (b === GROUP_ORDER_FIRST) return 1;
    if (a === GROUP_ORDER_LAST) return 1;
    if (b === GROUP_ORDER_LAST) return -1;
    return a.localeCompare(b);
  });
  for (const groupName of groupNames) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;
    const groupItems = groups.get(groupName);
    // A "blog heading" group (Blog) orders the same way the real site
    // does - newest first by date - rather than alphabetically by
    // title, which would scatter posts in a different order than
    // they'll actually appear once published.
    const isBlogHeading = groupItems.some((e) => e.isBlogHeading);
    const items = [...groupItems].sort((a, b) => {
      if (a.isSectionIndex !== b.isSectionIndex) return a.isSectionIndex ? -1 : 1;
      if (isBlogHeading) return (b.date || "").localeCompare(a.date || "");
      return a.label.localeCompare(b.label);
    });
    for (const e of items) {
      const opt = document.createElement("option");
      opt.value = e.path;
      opt.textContent = e.isSectionIndex ? e.label : "  " + e.label;
      optgroup.appendChild(opt);
    }
    fileSelect.appendChild(optgroup);
  }
};

export const refreshFileList = async () => {
  const previous = fileSelect.value;
  fileSelect.innerHTML = "";
  if (fileListMode === "paths") {
    const files = await invoke("list_editable_files");
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      fileSelect.appendChild(opt);
    }
    if (files.includes(previous)) fileSelect.value = previous;
  } else {
    const entries = await invoke("list_editable_files_detailed");
    populateFileSelectGrouped(entries);
    if (entries.some((e) => e.path === previous)) fileSelect.value = previous;
  }
};

fileListModeToggle.addEventListener("click", async () => {
  fileListMode = fileListMode === "titles" ? "paths" : "titles";
  fileListModeToggle.textContent = fileListMode === "titles" ? "Show: Titles" : "Show: Paths";
  await refreshFileList();
});

export const renderTabBar = () => {
  tabBar.innerHTML = "";
  for (const [path, tab] of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (path === activeTab ? " active" : "");
    el.title = path;

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dot";
      dot.textContent = "●";
      el.appendChild(dot);
    } else if (tab.externallyChanged) {
      const dot = document.createElement("span");
      dot.className = "tab-external-dot";
      dot.textContent = "●";
      el.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = path;
    el.appendChild(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close " + path);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(path);
    });
    el.appendChild(close);

    el.addEventListener("click", () => switchToTab(path));
    tabBar.appendChild(el);
  }
};

const updateStatusForActiveTab = () => {
  statusEl.classList.remove("dirty");
  if (!activeTab) {
    statusEl.textContent = "";
    saveButton.classList.add("clean");
    undoButton.disabled = true;
    redoButton.disabled = true;
    return;
  }
  const tab = tabs.get(activeTab);
  if (tab.dirty) {
    statusEl.classList.add("dirty");
    statusEl.textContent = "● unsaved changes";
    saveButton.classList.remove("clean");
  } else {
    statusEl.textContent = "";
    saveButton.classList.add("clean");
  }
  // reviewModeActive composes here rather than through git-workflow.js's own
  // toolbar-disabling list - same reasoning as content-editing.js's
  // section-aware fmt-date/fmt-tags guard, so the two disable-reasons
  // (nothing to undo vs. read-only review) don't fight over .disabled.
  undoButton.disabled = reviewModeActive != null || tab.undoStack.length === 0;
  redoButton.disabled = reviewModeActive != null || tab.redoStack.length === 0;
};

const externalContentBanner = document.getElementById("external-content-banner");
const externalContentMessage = document.getElementById("external-content-message");

// A page whose actual rendered content is driven by something other
// than what's visibly in this buffer - a custom `template` override
// (e.g. events/calendar.md: an empty body, the real "calendar" behavior
// lives entirely in events-calendar.html) or a <script> tag pasted
// directly into the body (e.g. plant-safari's embedded widget, real
// editable text but easy to break by editing it as if it were prose).
// Just a heads-up, not a block - both are still perfectly editable.
const refreshExternalContentBanner = async (content) => {
  try {
    const info = await invoke("detect_external_content", { content });
    if (info.customTemplate) {
      externalContentMessage.textContent =
        `This page uses a custom template ("${info.customTemplate}") - its actual layout/behavior lives in the theme's code, not shown here.`;
      externalContentBanner.style.display = "block";
    } else if (info.hasScriptTag) {
      externalContentMessage.textContent =
        "This page embeds custom code (a <script> tag) - edit the surrounding text with care, don't remove it unless you mean to.";
      externalContentBanner.style.display = "block";
    } else {
      externalContentBanner.style.display = "none";
    }
  } catch {
    externalContentBanner.style.display = "none";
  }
};

// Other modules (images.js) need to react to the buffer changing out from
// under them (a new tab opened, a tab closed down to none) without core.js
// importing anything from them - a custom event on `document` keeps this a
// one-way dependency instead of a circular import.
const notifyTabChanged = () => document.dispatchEvent(new Event("beedance:tab-changed"));

const switchToTab = (path) => {
  const tab = tabs.get(path);
  if (!tab) return;
  activeTab = path;
  editorEl.value = tab.content;
  editorEl.disabled = false;
  updateStatusForActiveTab();
  renderTabBar();
  if (tab.externallyChanged) {
    bannerMessage.textContent = path + " changed on disk externally.";
    banner.style.display = "block";
  } else {
    banner.style.display = "none";
  }
  refreshExternalContentBanner(tab.content);
  notifyTabChanged();
};

export const openTab = async (path) => {
  if (tabs.has(path)) {
    switchToTab(path);
    return;
  }
  try {
    const content = await invoke("read_file", { path });
    tabs.set(path, {
      content,
      dirty: false,
      timer: null,
      externallyChanged: false,
      undoStack: [],
      redoStack: [],
      lastUndoTime: null,
    });
    switchToTab(path);
  } catch (err) {
    statusEl.textContent = "";
    showError(err);
  }
};

// onError is deliberately opt-in, not automatic - doSave also runs from the
// autosave debounce timer and flushTab (closing a tab, quitting the app),
// where a popup on every failed background save would be far more
// disruptive than the inline status text this already shows. Only the
// explicit "Save" button (below) opts in.
const doSave = async (path, content, { onError } = {}) => {
  const tab = tabs.get(path);
  try {
    const written = await invoke("write_file", { path, content, datetime: nowForZola(), author: currentAuthorName });
    if (tab) {
      tab.dirty = false;
      // write_file stamps an `updated` front-matter field, which changes
      // what's actually on disk from what was submitted - reflect that
      // back into the buffer, but only if nothing's changed since this
      // exact save started. If the user kept typing during the
      // round-trip, tab.content has already moved past `content`, and
      // overwriting it here would silently discard those newer
      // keystrokes.
      if (tab.content === content) {
        tab.content = written;
        if (path === activeTab) {
          const selStart = editorEl.selectionStart;
          const selEnd = editorEl.selectionEnd;
          editorEl.value = written;
          editorEl.setSelectionRange(selStart, selEnd);
        }
      }
    }
    if (path === activeTab) updateStatusForActiveTab();
    renderTabBar();
  } catch (err) {
    if (path === activeTab) statusEl.textContent = "ERROR: " + err;
    if (onError) onError(err);
  }
};

const flushTab = (path) => {
  const tab = tabs.get(path);
  if (!tab) return;
  if (tab.timer) {
    clearTimeout(tab.timer);
    tab.timer = null;
    doSave(path, tab.content);
  }
};

export const cancelTabAutosave = (path) => {
  const tab = tabs.get(path);
  if (tab && tab.timer) {
    clearTimeout(tab.timer);
    tab.timer = null;
  }
};

const closeTab = (path) => {
  flushTab(path);
  invoke("close_file", { path }).catch(() => {});
  tabs.delete(path);

  if (activeTab === path) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      activeTab = null;
      editorEl.value = "";
      editorEl.disabled = true;
      banner.style.display = "none";
      updateStatusForActiveTab();
      renderTabBar();
      notifyTabChanged();
    }
  } else {
    renderTabBar();
  }
};

// Same tab-switching logic as closeTab, but skips flushTab - used after
// rename_content/delete_content, where the file this tab pointed at has
// already been moved or removed on disk, so saving it would either
// recreate what was just deleted or write into a path that no longer
// exists.
export const closeTabQuietly = (path) => {
  cancelTabAutosave(path);
  invoke("close_file", { path }).catch(() => {});
  tabs.delete(path);

  if (activeTab === path) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      activeTab = null;
      editorEl.value = "";
      editorEl.disabled = true;
      banner.style.display = "none";
      updateStatusForActiveTab();
      renderTabBar();
      notifyTabChanged();
    }
  } else {
    renderTabBar();
  }
};

export const closeAllTabsQuietly = () => {
  for (const path of [...tabs.keys()]) {
    closeTabQuietly(path);
  }
};

const scheduleAutosave = (path, tab) => {
  clearTimeout(tab.timer);
  tab.timer = setTimeout(() => {
    tab.timer = null;
    doSave(path, tab.content);
  }, AUTOSAVE_DELAY_MS);
};

// Undo/redo is app-managed rather than relying on the textarea's native
// browser undo stack - every toolbar action in this app (bold/italic wrap,
// date/tags panels, image insert/resize/delete) works by assigning
// editorEl.value directly, and a direct .value assignment resets/desyncs
// the native undo history in every webview engine this app targets
// (WebKitGTK, WKWebView, WebView2). Centralized here because this "input"
// listener already fires for every content change in the app, typed or
// programmatic (every module ends its own edits with emitEdited(), which
// dispatches a real "input" event on editorEl) - one choke point, no other
// module needs to know undo/redo exists.
const UNDO_COALESCE_MS = 700;
const UNDO_MAX_DEPTH = 200;

editorEl.addEventListener("input", () => {
  if (!activeTab) return;
  const tab = tabs.get(activeTab);
  const previousValue = tab.content;
  const newValue = editorEl.value;

  if (previousValue !== newValue) {
    const now = Date.now();
    const delta = Math.abs(newValue.length - previousValue.length);
    // Coalesce a burst of plain typing into one undo step; anything bigger
    // than a single character in one go (paste, a toolbar action, a
    // panel-driven rewrite) always starts its own step regardless of timing.
    const withinCoalesceWindow =
      tab.lastUndoTime != null && now - tab.lastUndoTime < UNDO_COALESCE_MS && delta <= 1;
    if (!withinCoalesceWindow) {
      tab.undoStack.push(previousValue);
      if (tab.undoStack.length > UNDO_MAX_DEPTH) tab.undoStack.shift();
      tab.redoStack.length = 0;
    }
    tab.lastUndoTime = now;
  }

  tab.content = newValue;
  tab.dirty = true;
  updateStatusForActiveTab();
  renderTabBar();
  scheduleAutosave(activeTab, tab);
});

// Jumps straight to a stored buffer (used by undo/redo) without going
// through the "input" listener above - it already changed editorEl.value
// itself, so re-dispatching input would just push this jump back onto the
// undo/redo stacks as if it were a fresh edit.
const jumpToHistoryEntry = (tab, value) => {
  tab.lastUndoTime = null;
  tab.content = value;
  editorEl.value = value;
  editorEl.setSelectionRange(value.length, value.length);
  tab.dirty = true;
  updateStatusForActiveTab();
  renderTabBar();
  scheduleAutosave(activeTab, tab);
};

export const undo = () => {
  if (!activeTab || reviewModeActive != null) return;
  const tab = tabs.get(activeTab);
  if (!tab || tab.undoStack.length === 0) return;
  tab.redoStack.push(tab.content);
  jumpToHistoryEntry(tab, tab.undoStack.pop());
};

export const redo = () => {
  if (!activeTab || reviewModeActive != null) return;
  const tab = tabs.get(activeTab);
  if (!tab || tab.redoStack.length === 0) return;
  tab.undoStack.push(tab.content);
  jumpToHistoryEntry(tab, tab.redoStack.pop());
};

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

editorEl.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === "z" || e.key === "Z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (e.key === "y" || e.key === "Y") {
    e.preventDefault();
    redo();
  }
});

export const withActiveTab = (fn) => () => {
  if (!activeTab) return;
  fn();
};

// A styled confirmation dialog (matching every other panel in this app)
// instead of a native browser confirm() popup, which looks out of place
// next to everything else here. Resolves true/false; only one at a time
// (a second call while one's already open replaces its resolver, which
// is fine since nothing in this app opens two confirmations at once).
const confirmPanel = document.getElementById("confirm-panel");
const confirmPanelTitle = document.getElementById("confirm-panel-title");
const confirmPanelMessage = document.getElementById("confirm-panel-message");
let confirmPanelResolve = null;

export const askConfirm = (title, message, confirmLabel = "Confirm") =>
  new Promise((resolve) => {
    confirmPanelTitle.textContent = title;
    confirmPanelMessage.textContent = message;
    document.getElementById("confirm-panel-confirm").textContent = confirmLabel;
    confirmPanelResolve = resolve;
    confirmPanel.style.display = "flex";
  });

document.getElementById("confirm-panel-cancel").addEventListener("click", () => {
  confirmPanel.style.display = "none";
  if (confirmPanelResolve) confirmPanelResolve(false);
  confirmPanelResolve = null;
});

document.getElementById("confirm-panel-confirm").addEventListener("click", () => {
  confirmPanel.style.display = "none";
  if (confirmPanelResolve) confirmPanelResolve(true);
  confirmPanelResolve = null;
});

// A real popup for a failed command's error text instead of dumping it
// inline into whatever small status line happened to be nearby - some of
// these (a raw R2 XML error body, for one real example) are long, technical,
// and easy to lose track of squeezed into a one-line status area. Every
// catch block across every module routes its error text through this
// instead of writing it into its own inline status element directly.
const errorPanel = document.getElementById("error-panel");
const errorPanelMessage = document.getElementById("error-panel-message");

export const showError = (err) => {
  errorPanelMessage.textContent = String(err);
  errorPanel.style.display = "flex";
};

document.getElementById("error-panel-close").addEventListener("click", () => {
  errorPanel.style.display = "none";
});

export const emitEdited = () => editorEl.dispatchEvent(new Event("input", { bubbles: true }));

// Enter triggers a panel's own primary action, Esc always cancels/closes -
// exported so every feature module can wire its OWN panels right after
// defining them, instead of one centralized list needing every panel
// variable in scope (which is what forced this to live at the bottom of the
// old single-file script, for hoisting).
export function wirePanelKeys(panelEl, confirmId, cancelId) {
  panelEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && confirmId) {
      e.preventDefault();
      document.getElementById(confirmId).click();
    } else if (e.key === "Escape") {
      document.getElementById(cancelId).click();
    }
  });
}

wirePanelKeys(confirmPanel, "confirm-panel-confirm", "confirm-panel-cancel");
wirePanelKeys(errorPanel, "error-panel-close", "error-panel-close");

window.addEventListener("beforeunload", () => {
  for (const path of tabs.keys()) flushTab(path);
});

document.getElementById("reload").addEventListener("click", async () => {
  if (!activeTab) return;
  const path = activeTab;
  cancelTabAutosave(path);
  try {
    const content = await invoke("read_file", { path });
    const tab = tabs.get(path);
    tab.content = content;
    tab.dirty = false;
    tab.externallyChanged = false;
    tab.undoStack.length = 0;
    tab.redoStack.length = 0;
    tab.lastUndoTime = null;
    if (path === activeTab) {
      editorEl.value = content;
      updateStatusForActiveTab();
      banner.style.display = "none";
    }
    renderTabBar();
  } catch (err) {
    statusEl.textContent = "";
    showError(err);
  }
});

document.getElementById("refresh-files").addEventListener("click", refreshFileList);

fileSelect.addEventListener("change", () => openTab(fileSelect.value));

document.getElementById("save").addEventListener("click", () => {
  if (!activeTab) return;
  cancelTabAutosave(activeTab);
  doSave(activeTab, editorEl.value, { onError: showError });
});

const siteDirEl = document.getElementById("site-dir");
// Kept separate from siteDirEl's displayed text, which can carry a
// trailing " (warning: ...)" suffix after set_site_dir - the picker's
// defaultPath needs the bare path.
export let currentSiteDir = "";

invoke("get_site_dir").then((dir) => {
  currentSiteDir = dir;
  siteDirEl.textContent = dir;
});

refreshFileList().then(() => {
  if (fileSelect.value) openTab(fileSelect.value);
});

invoke("get_author_settings")
  .then((author) => {
    currentAuthorName = author.displayName;
  })
  .catch(() => {});

// Shared by the "Change site..." button below and onboarding.js's clone
// flow - leaving the current site entirely, so every open tab against it
// gets flushed/closed first (closeTab already saves pending edits and tells
// the backend to stop tracking each path), before switching underneath.
export const switchToSiteDir = async (folder) => {
  for (const path of [...tabs.keys()]) closeTab(path);

  await invoke("zola_stop");
  document.getElementById("phone-toggle").checked = false;

  const result = await invoke("set_site_dir", { path: folder });
  currentSiteDir = folder;
  siteDirEl.textContent = result;

  await refreshFileList();
  if (fileSelect.value) openTab(fileSelect.value);
};

document.getElementById("change-site").addEventListener("click", async () => {
  try {
    const folder = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Choose site directory",
      defaultPath: currentSiteDir,
    });
    if (!folder) return;
    await switchToSiteDir(folder);
  } catch (err) {
    showError(err);
  }
});

const { listen } = window.__TAURI__.event;

listen("content-file-changed", (event) => {
  const path = event.payload;
  const tab = tabs.get(path);
  if (!tab) return;
  tab.externallyChanged = true;
  renderTabBar();
  if (path === activeTab) {
    bannerMessage.textContent = path + " changed on disk externally.";
    banner.style.display = "block";
  }
});

document.getElementById("banner-reload").addEventListener("click", () => {
  document.getElementById("reload").click();
});

document.getElementById("banner-dismiss").addEventListener("click", () => {
  if (activeTab) {
    const tab = tabs.get(activeTab);
    if (tab) tab.externallyChanged = false;
    renderTabBar();
  }
  banner.style.display = "none";
});
