// Editor/tab core: the file-list, per-tab buffer/dirty/autosave state, and
// the small bits of generic panel infrastructure (askConfirm, wirePanelKeys)
// every other feature module builds on. Split out of the former single
// index.html script (see pws-zg1h) - this is the module every other one
// depends on, not the other way around.

import { makeIcon } from "./icons.js";

const { invoke } = window.__TAURI__.core;

// Shared by describeGitError below (the reactive backstop) and git-
// workflow.js's ensureNoUncheckpointedChanges (the proactive check) - same
// underlying situation, same wording either way. A flat comma-joined list
// reads fine for one or two files but turns into an unreadable wall of text
// for a real editing session's worth of untouched drafts - one per line,
// capped, is readable regardless of how long the list actually is.
const MAX_LISTED_FILES = 10;
export function formatUncheckpointedFilesMessage(files) {
  const plural = files.length === 1 ? "has" : "have";
  const pronoun = files.length === 1 ? "it" : "them";
  const listed = files
    .slice(0, MAX_LISTED_FILES)
    .map((f) => `  - ${f}`)
    .join("\n");
  const overflow = files.length > MAX_LISTED_FILES ? `\n  ...and ${files.length - MAX_LISTED_FILES} more` : "";
  return (
    `${files.length} file${files.length === 1 ? "" : "s"} ${plural} changes that haven't been checkpointed ` +
    `yet:\n\n${listed}${overflow}\n\nGo to Drafts → Review changes to checkpoint ${pronoun}, then try again.`
  );
}

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
  // Switching drafts/reviewing/pulling all move the checked-out tree to a
  // different commit - git refuses outright if that would silently discard
  // a file's on-disk changes that were never committed. "Committed" isn't
  // this app's vocabulary anywhere else, and "saved" already means
  // "written to disk" (autosave does that constantly) - "checkpoint" is
  // the word this app already uses for a commit (see the Review changes
  // card's own copy), so the translation borrows it rather than
  // introducing git jargon or colliding with "save". A backstop for
  // whatever the proactive uncommitted-changes check (git-workflow.js's
  // ensureNoUncheckpointedChanges) doesn't catch - e.g. a file changed
  // outside the app between that check and the actual checkout.
  const overwriteMatch = text.match(/would be overwritten by (?:checkout|merge):\s*\n([\s\S]*?)\n(?:Please commit|Aborting|error:|$)/i);
  if (overwriteMatch) {
    const files = overwriteMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return formatUncheckpointedFilesMessage(files.length > 0 ? files : ["one or more files"]) + "\n\nRaw error: " + text;
  }
  return text;
}

// Case-insensitive subsequence match ("abt" matches "About") - not a
// scoring/ranking library, just enough for "show only what could plausibly
// be what I'm typing" the way a quick-open box does, rather than a plain
// prefix/substring search.
export const fuzzyMatches = (query, label) => {
  let qi = 0;
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();
  for (let li = 0; li < lowerLabel.length && qi < lowerQuery.length; li++) {
    if (lowerLabel[li] === lowerQuery[qi]) qi++;
  }
  return qi === lowerQuery.length;
};

// A searchable "pick a site page" combobox - a real text box with a custom
// dropdown, not a native <datalist> (a bare <input list=...> shows nothing
// until you start typing and only prefix/substring-matches, which doesn't
// give "show the full list on focus, then fuzzy-filter it" this needs to
// get consistently across this app's 3 target webviews). Shared by the
// main "Open file" control and the site-menu editor's per-row page picker
// (site-menu.js) - one implementation instead of two copies that could
// drift apart.
//
// Each entry needs at least `label` (also what's matched/shown); `group`
// (rendered as a header instead of the flat sort, but only while the query
// is empty - once there's an actual query, matches can span groups and
// sort by relevance instead) and `isSectionIndex` (a small "Section" tag,
// since it's often not obvious from a plain page list which entries can
// have pages nested under them) are both optional.
export function createSearchCombobox({ input, resultsEl, getEntries, onSelect, getCurrentLabel }) {
  let visibleEntries = [];
  let highlightIndex = -1;

  const close = () => {
    resultsEl.style.display = "none";
    resultsEl.innerHTML = "";
    visibleEntries = [];
    highlightIndex = -1;
  };

  const updateHighlight = () => {
    const resultRows = resultsEl.querySelectorAll(".search-combobox-result");
    resultRows.forEach((el, i) => el.classList.toggle("active", i === highlightIndex));
    resultRows[highlightIndex]?.scrollIntoView({ block: "nearest" });
  };

  const select = (entry) => {
    input.value = entry.label;
    close();
    onSelect(entry);
  };

  const render = (query) => {
    const q = query.trim();
    const entries = getEntries();
    const showGrouped = q === "" && entries.some((e) => e.group !== undefined);

    let matches = entries.filter((e) => fuzzyMatches(q, e.label));
    if (!showGrouped) {
      matches = matches.sort((a, b) => {
        const aPrefix = a.label.toLowerCase().startsWith(q.toLowerCase());
        const bPrefix = b.label.toLowerCase().startsWith(q.toLowerCase());
        if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
    }
    visibleEntries = matches;

    resultsEl.innerHTML = "";
    if (visibleEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-combobox-no-results";
      empty.textContent = "No matches.";
      resultsEl.appendChild(empty);
      highlightIndex = -1;
    } else {
      highlightIndex = 0;
      let lastGroup = null;
      for (const entry of visibleEntries) {
        if (showGrouped && entry.group !== lastGroup) {
          const header = document.createElement("div");
          header.className = "search-combobox-group-header";
          header.textContent = entry.group;
          resultsEl.appendChild(header);
          lastGroup = entry.group;
        }
        const row = document.createElement("div");
        row.className = "search-combobox-result";
        const text = document.createElement("span");
        text.textContent = entry.label;
        row.appendChild(text);
        if (entry.isSectionIndex) {
          const tag = document.createElement("span");
          tag.className = "search-combobox-section-tag";
          tag.textContent = "Section";
          row.appendChild(tag);
        }
        // mousedown, not click - fires before the input's own blur handler
        // would otherwise close this dropdown first and discard the click.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          select(entry);
        });
        resultsEl.appendChild(row);
      }
      updateHighlight();
    }
    resultsEl.style.display = "block";
  };

  const syncDisplay = () => {
    input.value = getCurrentLabel ? getCurrentLabel() : "";
  };

  input.addEventListener("focus", () => {
    // Clear outright rather than select()-ing the current text - a click's
    // own default caret placement can otherwise land after the focus
    // event's select() and quietly undo it, so typing wouldn't reliably
    // wipe "About (About)" the way it should. blur (below) already
    // restores this text if nothing gets picked, so clearing here loses
    // nothing.
    input.value = "";
    render("");
  });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (resultsEl.style.display === "none") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightIndex = Math.min(visibleEntries.length - 1, highlightIndex + 1);
      updateHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIndex = Math.max(0, highlightIndex - 1);
      updateHighlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const entry = visibleEntries[highlightIndex];
      if (entry) select(entry);
    } else if (e.key === "Escape") {
      // Stopped here so this only closes the dropdown - without this, the
      // same keystroke also bubbles up to the enclosing modal's own
      // Escape handler (wirePanelKeys) and closes/cancels the whole
      // modal in one press, when closing just the picker is what's
      // actually wanted (e.g. the site menu editor's page picker).
      e.stopPropagation();
      close();
      input.blur();
    }
  });
  // Typed text that never resolved to a real selection (left as a dead
  // end, rather than picking a suggestion) shouldn't linger looking like
  // it's the real current value - snap back to whatever it actually is.
  input.addEventListener("blur", () => {
    close();
    syncDisplay();
  });

  return { syncDisplay };
}

export const fileSelect = document.getElementById("file-select");
// fileSelect stays a real, populated <select> - just hidden - so every
// OTHER module's existing `fileSelect.value` reads/writes keep working
// unchanged; the visible search box (fileSearchCombobox, below
// refreshFileList) is kept in sync with it through fileSearchEntries.
let fileSearchEntries = [];
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
      // Deliberately no leading-space indent for a child page (that used
      // to distinguish it from its section's own index entry visually) -
      // a native <select>'s built-in type-to-search matches from the very
      // start of each option's text, so any fixed prefix on every child
      // page silently broke typing a page's real name to jump to it.
      // Grouping into optgroups by section already conveys the nesting.
      opt.textContent = e.label;
      optgroup.appendChild(opt);

      // Always "Label (Group)", even for a section's own index (where
      // group === label) - matching site-menu.js's own page-picker exactly,
      // and sidestepping any case where two different sections happen to
      // have a same-titled child page.
      fileSearchEntries.push({
        label: `${e.label} (${groupName})`,
        path: e.path,
        group: groupName,
        isSectionIndex: e.isSectionIndex,
      });
    }
    fileSelect.appendChild(optgroup);
  }
};

export const refreshFileList = async () => {
  const previous = fileSelect.value;
  fileSelect.innerHTML = "";
  fileSearchEntries = [];
  if (fileListMode === "paths") {
    const files = await invoke("list_editable_files");
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      fileSelect.appendChild(opt);
      fileSearchEntries.push({ label: f, path: f });
    }
    if (files.includes(previous)) fileSelect.value = previous;
  } else {
    const entries = await invoke("list_editable_files_detailed");
    populateFileSelectGrouped(entries);
    if (entries.some((e) => e.path === previous)) fileSelect.value = previous;
  }
  fileSearchCombobox.syncDisplay();
};

// Sets which file is "selected" everywhere this app shows that (the hidden
// backing <select> every other module reads, and the visible search box) -
// exported so any module that used to just write fileSelect.value directly
// keeps the search box honest too, instead of the two silently drifting
// apart.
export const setActiveFilePath = (path) => {
  fileSelect.value = path;
  fileSearchCombobox.syncDisplay();
};

const fileSearchCombobox = createSearchCombobox({
  input: document.getElementById("file-search"),
  resultsEl: document.getElementById("file-search-results"),
  getEntries: () => fileSearchEntries,
  getCurrentLabel: () => fileSearchEntries.find((e) => e.path === fileSelect.value)?.label || "",
  onSelect: (entry) => {
    fileSelect.value = entry.path;
    openTab(entry.path);
  },
});

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

    el.appendChild(makeIcon("doc", "tab-icon"));

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
    close.appendChild(makeIcon("close"));
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

// pws-dbs.19 - frontmatter lives in its own de-emphasized box above the
// body textarea, not mixed into one uniformly-styled buffer. tab.content
// stays the FULL file text (unchanged - still what write_file, undo, and
// external-change-detection all key off); the frontmatter box and editorEl
// (body only) are just two views DERIVED from splitting it apart, re-split
// fresh on every render rather than cached, so there's exactly one source
// of truth to keep consistent.
const FRONTMATTER_RE = /^(\+\+\+|---)\r?\n([\s\S]*?)\r?\n\1\r?\n?/;

// Lossless by construction: frontmatter + body === content always, since
// frontmatter is a literal leading substring and body is exactly whatever
// follows it.
const splitFrontmatter = (content) => {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[0], body: content.slice(match[0].length) };
};

const frontmatterBlockText = (frontmatterRaw) => {
  const match = frontmatterRaw.match(FRONTMATTER_RE);
  return match ? match[2] : "";
};

// Same simple line-based "key = value" / "key: value" convention as
// frontmatter.rs's own front_matter_field (not a real TOML parser) - an
// intentional match, not a shortcut: anything that convention can't parse
// correctly, the Rust side can't either, so this isn't a new gap on top of
// an existing one.
const parseFrontmatterFields = (block) => {
  const fields = new Map();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) fields.set(key, value);
  }
  return fields;
};

const cleanFrontmatterValue = (raw) => raw.trim().replace(/^["']|["']$/g, "");

const formatFrontmatterTags = (raw) =>
  raw
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((s) => cleanFrontmatterValue(s))
    .filter(Boolean)
    .join(", ");

const formatFrontmatterDate = (raw) => {
  const cleaned = cleanFrontmatterValue(raw);
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return cleaned;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const frontmatterViewEl = document.getElementById("frontmatter-view");
const frontmatterEditEl = document.getElementById("frontmatter-edit");
const frontmatterFieldsEl = document.getElementById("frontmatter-fields");
const frontmatterOtherEl = document.getElementById("frontmatter-other");
const frontmatterOtherListEl = document.getElementById("frontmatter-other-list");
const frontmatterRawEl = document.getElementById("frontmatter-raw");

// [frontmatter key, display label, value formatter] - anything in the
// block NOT listed here falls through to the plain key = value "Other
// fields" list instead (pws-dbs.19's explicit answer to "what about fields
// the app doesn't recognize but a theme does" - never hidden).
const KNOWN_FRONTMATTER_FIELDS = [
  ["title", "Title", cleanFrontmatterValue],
  ["date", "Date", formatFrontmatterDate],
  ["tags", "Tags", formatFrontmatterTags],
];

const renderFrontmatterFieldsAndExtras = (block) => {
  const fields = parseFrontmatterFields(block);

  frontmatterFieldsEl.innerHTML = "";
  for (const [key, label, format] of KNOWN_FRONTMATTER_FIELDS) {
    if (!fields.has(key)) continue;
    const display = format(fields.get(key));
    if (!display) continue;
    const field = document.createElement("span");
    field.className = "frontmatter-field";
    const labelSpan = document.createElement("span");
    labelSpan.className = "frontmatter-field-label";
    labelSpan.textContent = label;
    field.appendChild(labelSpan);
    field.appendChild(document.createTextNode(display));
    frontmatterFieldsEl.appendChild(field);
  }

  const knownKeys = new Set(KNOWN_FRONTMATTER_FIELDS.map(([key]) => key));
  frontmatterOtherListEl.innerHTML = "";
  let hasExtras = false;
  for (const [key, value] of fields) {
    if (knownKeys.has(key)) continue;
    hasExtras = true;
    const line = document.createElement("span");
    line.textContent = `${key} = ${value}`;
    frontmatterOtherListEl.appendChild(line);
  }
  frontmatterOtherEl.style.display = hasExtras ? "flex" : "none";
};

// The one render entry point for the frontmatter box - called on every tab
// switch, undo/redo jump, disk reload, and post-stamp resync, always from
// scratch (never a partial update), so the view/edit boxes can never drift
// from what tab.content actually holds.
const renderFrontmatterBox = (tab) => {
  const { frontmatter } = splitFrontmatter(tab.content);
  if (!frontmatter) {
    frontmatterViewEl.style.display = "none";
    frontmatterEditEl.style.display = "none";
    return;
  }
  renderFrontmatterFieldsAndExtras(frontmatterBlockText(frontmatter));
  frontmatterRawEl.value = frontmatter;
  frontmatterViewEl.style.display = tab.frontmatterEditing ? "none" : "block";
  frontmatterEditEl.style.display = tab.frontmatterEditing ? "block" : "none";
};

document.getElementById("frontmatter-edit-open").addEventListener("click", () => {
  if (!activeTab) return;
  const tab = tabs.get(activeTab);
  tab.frontmatterEditing = true;
  renderFrontmatterBox(tab);
});

document.getElementById("frontmatter-edit-close").addEventListener("click", () => {
  if (!activeTab) return;
  const tab = tabs.get(activeTab);
  tab.frontmatterEditing = false;
  renderFrontmatterBox(tab);
});

// A page whose actual rendered content is driven by something other than
// what's visibly in this buffer - a custom `template` override, or a
// <script> tag pasted directly into the body. Just a heads-up, not a
// block - both are still perfectly editable.
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
  editorEl.value = splitFrontmatter(tab.content).body;
  renderFrontmatterBox(tab);
  editorEl.disabled = false;
  updateStatusForActiveTab();
  renderTabBar();
  // Every path into switchToTab (the search box, the hidden <select>'s own
  // change event, a direct tab-bar click) should leave the search box
  // showing what's actually open - not just the ones that went through the
  // search box itself.
  fileSelect.value = path;
  fileSearchCombobox.syncDisplay();
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
      frontmatterEditing: false,
    });
    switchToTab(path);
  } catch (err) {
    statusEl.textContent = "";
    showError(err);
  }
};

// write_file's frontmatter stamping (an `updated` date, an appended author)
// inserts whole new lines into the frontmatter block the first time that
// field doesn't exist yet - `written` isn't just `content` with a field's
// VALUE changed, it can be a different LENGTH, with everything after the
// stamped region shifted by the difference. A raw numeric selectionStart/
// End captured against the OLD string is meaningless against a shifted
// NEW one - reapplying it blindly (as this used to) silently moved the
// cursor away from where the user was actively typing on literally the
// first autosave of a fresh post (Dave: "cursor moving elsewhere in the
// document" while writing). Remapped via plain common-prefix/common-suffix
// matching rather than a real diff library - the change is always one
// small, localized edit (a stamped field), never an arbitrary rewrite, so
// this is exact for every real case and only degrades to "clamp to the
// edited region" if the cursor happened to sit inside the stamped text
// itself (frontmatter, never the body the user is actually typing in).
const remapOffset = (oldStr, newStr, oldOffset) => {
  if (oldStr === newStr) return oldOffset;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && oldStr[prefixLen] === newStr[prefixLen]) prefixLen++;
  const maxSuffix = Math.min(oldStr.length, newStr.length) - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  )
    suffixLen++;
  if (oldOffset <= prefixLen) return oldOffset;
  if (oldOffset >= oldStr.length - suffixLen) return newStr.length - (oldStr.length - oldOffset);
  return prefixLen;
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
          // remapOffset now only ever needs to correct for a shift INSIDE
          // the body - a frontmatter-only stamp (the common case) leaves
          // the body substring byte-identical, so this is a no-op in
          // practice, kept as a defensive fallback rather than relied on.
          const { frontmatter: oldFm, body: oldBody } = splitFrontmatter(content);
          const { frontmatter: newFm, body: newBody } = splitFrontmatter(written);
          const selStart = remapOffset(oldBody, newBody, editorEl.selectionStart);
          const selEnd = remapOffset(oldBody, newBody, editorEl.selectionEnd);
          editorEl.value = newBody;
          editorEl.setSelectionRange(selStart, selEnd);
          // Only re-render the frontmatter box if the stamp actually
          // changed it - avoids clobbering an in-progress raw-edit for no
          // reason on every single autosave tick.
          if (newFm !== oldFm) renderFrontmatterBox(tab);
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

// Shared by both editable surfaces (the body textarea and the frontmatter
// raw-edit textarea, pws-dbs.19) - each just reassembles its own half plus
// whatever the OTHER half currently is and hands the full result here,
// so there is exactly one undo/dirty/autosave implementation regardless of
// which box was actually typed in.
const handleBufferEdit = (tab, newValue) => {
  const previousValue = tab.content;

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
};

editorEl.addEventListener("input", () => {
  if (!activeTab) return;
  const tab = tabs.get(activeTab);
  const { frontmatter } = splitFrontmatter(tab.content);
  handleBufferEdit(tab, frontmatter + editorEl.value);
});

frontmatterRawEl.addEventListener("input", () => {
  if (!activeTab) return;
  const tab = tabs.get(activeTab);
  const { body } = splitFrontmatter(tab.content);
  handleBufferEdit(tab, frontmatterRawEl.value + body);
});

// Jumps straight to a stored buffer (used by undo/redo) without going
// through the "input" listeners above - they already changed their own
// textarea's value, so re-dispatching input would just push this jump back
// onto the undo/redo stacks as if it were a fresh edit. Always resets to
// frontmatter VIEW mode (not raw-edit) and re-splits from scratch - a
// history entry could have been pushed by either textarea, so there's no
// single "right" one to leave focused.
const jumpToHistoryEntry = (tab, value) => {
  tab.lastUndoTime = null;
  tab.content = value;
  const { body } = splitFrontmatter(value);
  editorEl.value = body;
  editorEl.setSelectionRange(body.length, body.length);
  tab.frontmatterEditing = false;
  renderFrontmatterBox(tab);
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

// Reloads one tab's buffer from whatever's actually on disk right now -
// shared by the "Reload from disk" button (always the active tab) and
// anything else that changes a file's on-disk content out from under an
// open tab's buffer without that tab knowing about it (e.g. git-workflow.js's
// discard-changes action). Without this, a pending (or even a brand new)
// autosave for that tab would silently overwrite the fresh disk content
// right back with the tab's own stale in-memory copy the next time it
// fires - found exactly this way: discarding a file whose tab was still
// open looked like it hadn't done anything, because the next git operation
// re-flushed the tab's old content before checking for anything
// uncommitted. A no-op if that path isn't even open as a tab.
export const reloadTabFromDisk = async (path) => {
  const tab = tabs.get(path);
  if (!tab) return;
  cancelTabAutosave(path);
  const content = await invoke("read_file", { path });
  tab.content = content;
  tab.dirty = false;
  tab.externallyChanged = false;
  tab.undoStack.length = 0;
  tab.redoStack.length = 0;
  tab.lastUndoTime = null;
  tab.frontmatterEditing = false;
  if (path === activeTab) {
    editorEl.value = splitFrontmatter(content).body;
    renderFrontmatterBox(tab);
    updateStatusForActiveTab();
    banner.style.display = "none";
  }
  renderTabBar();
};

document.getElementById("reload").addEventListener("click", async () => {
  if (!activeTab) return;
  try {
    await reloadTabFromDisk(activeTab);
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
  siteDirEl.title = dir;
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

  const result = await invoke("set_site_dir", { path: folder });
  currentSiteDir = folder;
  siteDirEl.textContent = result;
  siteDirEl.title = result;

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
