// New post/page, rename, delete, page date, tags, and the plain-text
// formatting toolbar (bold/italic/code/link/headings/quote/lists) - the
// panels the format toolbar drives, per pws-zg1h's module split.

import {
  editorEl,
  setActiveFilePath,
  statusEl,
  activeTab,
  withActiveTab,
  askConfirm,
  wirePanelKeys,
  emitEdited,
  nowForZola,
  pad2,
  refreshFileList,
  openTab,
  closeTabQuietly,
  currentAuthorName,
  reviewModeActive,
  showError,
  createSearchCombobox,
  activeTabFullContent,
  applyFullContentUpdate,
} from "./editor-core.js";
import { makeIcon } from "./icons.js";
import { showAppMainPage } from "./menus.js";

const { invoke } = window.__TAURI__.core;

// "New post"/"New page" share one small modal (title field, kind-specific
// help text) rather than two near-identical dialogs - the only real
// difference is which Rust command runs and what the help text says.
const NEW_CONTENT_HELP = {
  post: "A post is dated content - a blog entry or event - that fades in relevance over time. It always goes into whichever section is set up as the blog, not wherever you happen to be editing right now.",
  page: "A page is a permanent, menu-linked fixture (like \"About\" or \"Contact\") that nests under an existing section. A few sections that might look similar won't show up as a destination below - an auto-generated listing built entirely from tagged posts, or a single bespoke embedded page, isn't a real container to add a page under.",
};
let newContentKind = "post";
const newContentPanel = document.getElementById("new-content-panel");
const newContentTitleEl = document.getElementById("new-content-title");
const newContentHelpEl = document.getElementById("new-content-help");
const newContentInput = document.getElementById("new-content-title-input");
const newContentSectionRow = document.getElementById("new-content-section-row");
const newContentSection = document.getElementById("new-content-section");
const newContentStatus = document.getElementById("new-content-status");

const openNewContentPanel = async (kind) => {
  newContentKind = kind;
  newContentTitleEl.textContent = kind === "post" ? "New post" : "New page";
  newContentHelpEl.textContent = NEW_CONTENT_HELP[kind];
  newContentInput.value = "";
  newContentStatus.textContent = "";
  newContentPanel.style.display = "flex";
  newContentInput.focus();

  // A page here always nests under an existing section (e.g. a new page
  // under "About") rather than minting its own top-level section - see
  // site-menu.js's "New section..." option (from the Site menu editor)
  // for creating one of those instead.
  if (kind === "page") {
    newContentSectionRow.style.display = "block";
    newContentSection.innerHTML = "<option>(loading...)</option>";
    try {
      const sections = await invoke("list_page_sections");
      newContentSection.innerHTML = "";
      for (const s of sections) {
        const opt = document.createElement("option");
        opt.value = s.slug;
        opt.textContent = s.title;
        newContentSection.appendChild(opt);
      }
      if (sections.length === 0) {
        newContentStatus.textContent = "This site has no existing sections to add a page to yet.";
      }
    } catch (err) {
      newContentStatus.textContent = "Couldn't load sections: " + err;
    }
  } else {
    newContentSectionRow.style.display = "none";
  }
};

document.getElementById("new-post").addEventListener("click", () => openNewContentPanel("post"));
document.getElementById("new-page").addEventListener("click", () => openNewContentPanel("page"));

document.getElementById("new-content-cancel").addEventListener("click", () => {
  newContentPanel.style.display = "none";
});

document.getElementById("new-content-confirm").addEventListener("click", async () => {
  const title = newContentInput.value.trim();
  if (!title) {
    newContentStatus.textContent = "Enter a title first.";
    return;
  }
  if (newContentKind === "page" && !newContentSection.value) {
    newContentStatus.textContent = "Choose a section first.";
    return;
  }
  newContentStatus.textContent = "Creating...";
  try {
    const command = newContentKind === "post" ? "create_post" : "create_page";
    const args =
      newContentKind === "post"
        ? { title, datetime: nowForZola(), author: currentAuthorName }
        : { title, section: newContentSection.value, datetime: nowForZola(), author: currentAuthorName };
    const path = await invoke(command, args);
    newContentPanel.style.display = "none";
    await refreshFileList();
    setActiveFilePath(path);
    await openTab(path);
    // pws-jkuo - creating new content should always end with you looking
    // at it in the Editor, regardless of which panel (Pages, main toolbar)
    // triggered creation - otherwise the new tab opens in the background
    // with no visual cue it happened or where to find it.
    showAppMainPage("editor");
  } catch (err) {
    newContentStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("delete-content").addEventListener(
  "click",
  withActiveTab(async () => {
    const path = activeTab;
    const proceed = await askConfirm("Delete this page?", `Delete "${path}"? This can't be undone.`, "Delete");
    if (!proceed) return;
    try {
      await invoke("delete_content", { path });
      closeTabQuietly(path);
      await refreshFileList();
    } catch (err) {
      showError(err);
    }
  })
);

const renamePanel = document.getElementById("rename-panel");
const renamePanelInput = document.getElementById("rename-panel-input");
const renamePanelStatus = document.getElementById("rename-panel-status");
let renamePanelOriginalTitle = "";

document.getElementById("rename-content").addEventListener(
  "click",
  withActiveTab(async () => {
    renamePanelStatus.textContent = "";
    try {
      const title = await invoke("get_front_matter_title", { content: activeTabFullContent() });
      renamePanelOriginalTitle = title || "";
      renamePanelInput.value = renamePanelOriginalTitle;
    } catch (err) {
      renamePanelStatus.textContent = "";
      showError(err);
    }
    renamePanel.style.display = "flex";
    renamePanelInput.focus();
  })
);

document.getElementById("rename-panel-cancel").addEventListener("click", () => {
  renamePanel.style.display = "none";
});

document.getElementById("rename-panel-confirm").addEventListener("click", async () => {
  if (!activeTab) return;
  const newTitle = renamePanelInput.value.trim();
  if (!newTitle) {
    renamePanelStatus.textContent = "Enter a title first.";
    return;
  }
  const proceed = await askConfirm(
    "Rename this page?",
    `Rename "${renamePanelOriginalTitle}" to "${newTitle}"? Its web address changes too.`,
    "Rename"
  );
  if (!proceed) return;
  const oldPath = activeTab;
  renamePanelStatus.textContent = "Renaming...";
  try {
    // rename_content works directly against what's on disk and this tab
    // gets reloaded from disk afterward - flush any unsaved edits first,
    // or they'd be silently discarded.
    await invoke("write_file", {
      path: oldPath,
      content: activeTabFullContent(),
      datetime: nowForZola(),
      author: currentAuthorName,
    });
    const newPath = await invoke("rename_content", { path: oldPath, newTitle });
    closeTabQuietly(oldPath);
    renamePanel.style.display = "none";
    await refreshFileList();
    setActiveFilePath(newPath);
    await openTab(newPath);
  } catch (err) {
    renamePanelStatus.textContent = "";
    showError(err);
  }
});

// Wraps the current selection in prefix/suffix (bold/italic/code): with
// text selected, wraps it in place and keeps it selected; with nothing
// selected, inserts an empty pair with the cursor left in between.
const wrapSelection = (prefix, suffix) => {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const value = editorEl.value;
  const selected = value.slice(start, end);

  editorEl.value = value.slice(0, start) + prefix + selected + suffix + value.slice(end);
  editorEl.focus();
  editorEl.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
  emitEdited();
};

// Applies a per-line prefix (heading/quote/bullets) to every line touched
// by the selection, or just the current line if the selection is collapsed.
const prefixLines = (linePrefix) => {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const value = editorEl.value;

  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;

  const block = value.slice(blockStart, blockEnd);
  const newBlock = block
    .split("\n")
    .map((line) => linePrefix + line)
    .join("\n");

  editorEl.value = value.slice(0, blockStart) + newBlock + value.slice(blockEnd);
  editorEl.focus();
  editorEl.setSelectionRange(blockStart, blockStart + newBlock.length);
  emitEdited();
};

// Same idea as prefixLines but numbers each line sequentially (1. 2. 3. ...).
const numberLines = () => {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const value = editorEl.value;

  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;

  const block = value.slice(blockStart, blockEnd);
  const newBlock = block
    .split("\n")
    .map((line, i) => `${i + 1}. ${line}`)
    .join("\n");

  editorEl.value = value.slice(0, blockStart) + newBlock + value.slice(blockEnd);
  editorEl.focus();
  editorEl.setSelectionRange(blockStart, blockStart + newBlock.length);
  emitEdited();
};

// pws-0ayq - one entry point ("Link") for both an internal page link and a
// plain web address, rather than a second toolbar button, per design's
// "keeps one discoverable entry point for insert a link" call. Opening the
// panel moves focus away from the textarea, so the selection has to be
// captured up front - everything below reads from this, never from
// editorEl.selectionStart/End directly.
const linkPanel = document.getElementById("link-panel");
const linkPanelTitle = document.getElementById("link-panel-title");
const linkPanelPageMode = document.getElementById("link-panel-page-mode");
const linkPanelUrlMode = document.getElementById("link-panel-url-mode");
const linkPanelPageSearch = document.getElementById("link-panel-page-search");
const linkPanelPageSearchResults = document.getElementById("link-panel-page-search-results");
const linkPanelUrlInput = document.getElementById("link-panel-url-input");
const linkPanelTextInput = document.getElementById("link-panel-text-input");
const linkPanelConfirm = document.getElementById("link-panel-confirm");
let linkSelectionStart = 0;
let linkSelectionEnd = 0;
let linkableFileEntries = [];
let linkSelectedPageEntry = null;
let currentLinkPanelMode = "page";

// Inserts/replaces at linkSelectionStart/End - either the original
// selection (a brand new link) or an existing link's own full
// `[text](target)` span (editing one in place, see findLinkAtCursor) -
// leaves the caret right after it, and closes the panel.
const insertLinkMarkdown = (linkText, target) => {
  const value = editorEl.value;
  const inserted = "[" + linkText + "](" + target + ")";
  editorEl.value = value.slice(0, linkSelectionStart) + inserted + value.slice(linkSelectionEnd);
  linkPanel.style.display = "none";
  editorEl.focus();
  const caret = linkSelectionStart + inserted.length;
  editorEl.setSelectionRange(caret, caret);
  emitEdited();
};

// EditableFile.path is site-relative INCLUDING the "content/" prefix (see
// its own doc comment in site.rs); Zola's @/ link syntax is already
// content-relative, so that prefix has to come off here or the built link
// would 404 (Zola would look for content/content/...).
const zolaLinkPath = (path) => "@/" + path.replace(/^content\//, "");

// Finds a `[text](target)` markdown link whose span contains `pos` (the
// caret, or the start of a selection) - used so clicking "Link" while
// already inside one re-opens it for editing instead of inserting a new,
// nested link right next to it.
const LINK_MARKDOWN_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const findLinkAtCursor = (value, pos) => {
  LINK_MARKDOWN_RE.lastIndex = 0;
  let match;
  while ((match = LINK_MARKDOWN_RE.exec(value))) {
    const start = match.index;
    const end = start + match[0].length;
    if (pos >= start && pos <= end) return { start, end, text: match[1], target: match[2] };
  }
  return null;
};

const updateLinkConfirmEnabled = () => {
  linkPanelConfirm.disabled = currentLinkPanelMode === "page" && !linkSelectedPageEntry;
};

const linkPagePicker = createSearchCombobox({
  input: linkPanelPageSearch,
  resultsEl: linkPanelPageSearchResults,
  getEntries: () => linkableFileEntries,
  onSelect: (entry) => {
    linkSelectedPageEntry = entry;
    // Only fills the text field when it's empty, so picking a page never
    // clobbers a label already typed/kept from the original selection or
    // an existing link being edited.
    if (!linkPanelTextInput.value.trim()) linkPanelTextInput.value = entry.title;
    updateLinkConfirmEnabled();
  },
  getCurrentLabel: () => (linkSelectedPageEntry ? linkSelectedPageEntry.label : ""),
});

const setLinkPanelMode = (mode) => {
  currentLinkPanelMode = mode;
  linkPanelMode.querySelectorAll("button[data-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  linkPanelPageMode.style.display = mode === "page" ? "block" : "none";
  linkPanelUrlMode.style.display = mode === "url" ? "block" : "none";
  updateLinkConfirmEnabled();
  if (mode === "page") {
    linkPanelPageSearch.focus();
  } else {
    linkPanelUrlInput.focus();
    linkPanelUrlInput.select();
  }
};

const linkPanelMode = document.getElementById("link-panel-mode");
linkPanelMode.querySelectorAll("button[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setLinkPanelMode(btn.dataset.mode));
});

const openLinkPanel = async () => {
  const pos = editorEl.selectionStart;
  const existing = findLinkAtCursor(editorEl.value, pos);

  linkSelectedPageEntry = null;
  let pendingExistingTarget = null;
  if (existing) {
    linkSelectionStart = existing.start;
    linkSelectionEnd = existing.end;
    linkPanelTextInput.value = existing.text;
    if (existing.target.startsWith("@/")) {
      pendingExistingTarget = existing.target;
    } else {
      linkPanelUrlInput.value = existing.target;
    }
  } else {
    linkSelectionStart = editorEl.selectionStart;
    linkSelectionEnd = editorEl.selectionEnd;
    linkPanelTextInput.value = editorEl.value.slice(linkSelectionStart, linkSelectionEnd);
    linkPanelUrlInput.value = "https://";
  }
  linkPanelTitle.textContent = existing ? "Edit link" : "Insert link";
  linkPanelConfirm.textContent = existing ? "Update link" : "Insert link";

  linkPanel.style.display = "flex";
  try {
    const files = await invoke("list_editable_files_detailed");
    linkableFileEntries = files.map((f) => ({
      label: `${f.label} (${f.group})`,
      title: f.label,
      path: f.path,
      group: f.group,
      isSectionIndex: f.isSectionIndex,
    }));
  } catch (err) {
    linkableFileEntries = [];
    showError(err);
  }

  if (pendingExistingTarget) {
    linkSelectedPageEntry = linkableFileEntries.find((e) => zolaLinkPath(e.path) === pendingExistingTarget) || null;
    if (linkSelectedPageEntry) {
      setLinkPanelMode("page");
    } else {
      // An @/ target that doesn't resolve to any current page (stale, or
      // predates this feature) - fall back to Web address mode so editing
      // the text still works rather than leaving Insert permanently
      // disabled over an unresolvable page pick.
      linkPanelUrlInput.value = pendingExistingTarget;
      setLinkPanelMode("url");
    }
  } else {
    setLinkPanelMode(existing ? "url" : "page");
  }
  linkPagePicker.syncDisplay();
};

document.getElementById("link-panel-cancel").addEventListener("click", () => {
  linkPanel.style.display = "none";
});

linkPanelConfirm.addEventListener("click", () => {
  if (linkPanelConfirm.disabled) return;
  const linkText = linkPanelTextInput.value.trim() || "link text";
  const target =
    currentLinkPanelMode === "page" ? zolaLinkPath(linkSelectedPageEntry.path) : linkPanelUrlInput.value.trim() || "https://";
  insertLinkMarkdown(linkText, target);
});

wirePanelKeys(linkPanel, "link-panel-confirm", "link-panel-cancel");

document.getElementById("fmt-bold").addEventListener("click", withActiveTab(() => wrapSelection("**", "**")));
document.getElementById("fmt-italic").addEventListener("click", withActiveTab(() => wrapSelection("_", "_")));
document.getElementById("fmt-code").addEventListener("click", withActiveTab(() => wrapSelection("`", "`")));
document.getElementById("fmt-link").addEventListener("click", withActiveTab(openLinkPanel));
document.getElementById("fmt-h2").addEventListener("click", withActiveTab(() => prefixLines("## ")));
document.getElementById("fmt-h3").addEventListener("click", withActiveTab(() => prefixLines("### ")));
document.getElementById("fmt-quote").addEventListener("click", withActiveTab(() => prefixLines("> ")));
document.getElementById("fmt-ul").addEventListener("click", withActiveTab(() => prefixLines("- ")));
document.getElementById("fmt-ol").addEventListener("click", withActiveTab(numberLines));

// Plain number inputs, not <input type="datetime-local"> - that input
// type is a known weak spot in WebKitGTK (this app's Linux webview
// engine), historically with no real native picker and unreliable
// keyboard input, and this app has to work identically across Mac/
// Windows/Linux. Number inputs are universally supported everywhere.

// Parses whatever's actually in the front matter's `date` field (bare
// "2026-06-17", a full "2026-09-26T14:30:00", TOML-quoted, or a space
// instead of "T") into {year, month, day, hour, minute} - hour/minute
// default to 0 if the value has no time component. Best-effort: an
// unparseable value returns null rather than guessing wrong.
const zolaDateToParts = (raw) => {
  if (!raw) return null;
  const unquoted = raw.trim().replace(/^["'](.*)["']$/, "$1").replace(" ", "T");
  const m = unquoted.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] !== undefined ? Number(m[4]) : 0,
    minute: m[5] !== undefined ? Number(m[5]) : 0,
  };
};

const datePanel = document.getElementById("date-panel");
const datePanelYear = document.getElementById("date-panel-year");
const datePanelMonth = document.getElementById("date-panel-month");
const datePanelDay = document.getElementById("date-panel-day");
const datePanelHour = document.getElementById("date-panel-hour");
const datePanelMinute = document.getElementById("date-panel-minute");
const datePanelFields = [datePanelYear, datePanelMonth, datePanelDay, datePanelHour, datePanelMinute];
const datePanelStatus = document.getElementById("date-panel-status");

const fillDatePanel = (parts) => {
  datePanelYear.value = parts ? parts.year : "";
  datePanelMonth.value = parts ? parts.month : "";
  datePanelDay.value = parts ? parts.day : "";
  datePanelHour.value = parts ? parts.hour : "";
  datePanelMinute.value = parts ? parts.minute : "";
};

document.getElementById("fmt-date").addEventListener(
  "click",
  withActiveTab(async () => {
    datePanelStatus.textContent = "";
    try {
      const current = await invoke("get_front_matter_date", { content: activeTabFullContent() });
      fillDatePanel(zolaDateToParts(current));
    } catch (err) {
      datePanelStatus.textContent = "";
      showError(err);
    }
    datePanel.style.display = "flex";
  })
);

document.getElementById("date-panel-now").addEventListener("click", () => {
  const d = new Date();
  fillDatePanel({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  });
});

// Removing the date is immediate, not deferred to Save - with five
// separate fields there's no clean single "this means remove" state to
// leave them in.
document.getElementById("date-panel-clear").addEventListener("click", async () => {
  if (!activeTab) return;
  try {
    const updated = await invoke("remove_front_matter_date", { content: activeTabFullContent() });
    applyFullContentUpdate(updated);
    datePanel.style.display = "none";
  } catch (err) {
    datePanelStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("date-panel-cancel").addEventListener("click", () => {
  datePanel.style.display = "none";
});

document.getElementById("date-panel-confirm").addEventListener("click", async () => {
  if (!activeTab) return;
  if (datePanelFields.some((f) => f.value === "")) {
    datePanelStatus.textContent = 'Fill in all fields (or use "Remove date" to clear it).';
    return;
  }
  const datetime =
    `${String(datePanelYear.value).padStart(4, "0")}-${pad2(datePanelMonth.value)}-${pad2(datePanelDay.value)}` +
    `T${pad2(datePanelHour.value)}:${pad2(datePanelMinute.value)}:00`;
  try {
    const updated = await invoke("set_front_matter_date", { content: activeTabFullContent(), datetime });
    applyFullContentUpdate(updated);
    datePanel.style.display = "none";
  } catch (err) {
    datePanelStatus.textContent = "";
    showError(err);
  }
});

// Tags: chips (add via a text input + native <datalist> autocomplete
// against every tag already used anywhere on the site, remove via each
// chip's own × ) rather than hand-editing the raw
// `tags = ["a", "b"]` TOML array line - and the autocomplete nudges
// toward reusing an existing tag instead of minting a near-duplicate
// (this site's real content already has both "Newsletter" and
// "newsletter" as separate tags).
let tagsPanelTags = [];
const tagsPanel = document.getElementById("tags-panel");
const tagsPanelChips = document.getElementById("tags-panel-chips");
const tagsPanelInput = document.getElementById("tags-panel-input");
const tagsPanelDatalist = document.getElementById("tags-panel-datalist");
const tagsPanelStatus = document.getElementById("tags-panel-status");

const renderTagsPanelChips = () => {
  tagsPanelChips.innerHTML = "";
  for (const tag of tagsPanelTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const label = document.createElement("span");
    label.textContent = tag;
    chip.appendChild(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.setAttribute("aria-label", "Remove " + tag);
    remove.appendChild(makeIcon("close"));
    remove.addEventListener("click", () => {
      tagsPanelTags = tagsPanelTags.filter((t) => t !== tag);
      renderTagsPanelChips();
    });
    chip.appendChild(remove);
    tagsPanelChips.appendChild(chip);
  }
};

const addTagFromInput = () => {
  const tag = tagsPanelInput.value.trim();
  tagsPanelInput.value = "";
  if (!tag) return;
  // Case-insensitive de-dupe within THIS page's own tag list, matching
  // list_all_tags' site-wide de-dupe logic - adding "Newsletter" when
  // "newsletter" is already on this same page shouldn't produce two.
  if (tagsPanelTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  tagsPanelTags.push(tag);
  renderTagsPanelChips();
};

document.getElementById("fmt-tags").addEventListener(
  "click",
  withActiveTab(async () => {
    tagsPanelStatus.textContent = "";
    try {
      const [current, allTags] = await Promise.all([
        invoke("get_content_tags", { content: activeTabFullContent() }),
        invoke("list_all_tags"),
      ]);
      tagsPanelTags = [...current];
      renderTagsPanelChips();
      tagsPanelDatalist.innerHTML = "";
      for (const tag of allTags) {
        const opt = document.createElement("option");
        opt.value = tag;
        tagsPanelDatalist.appendChild(opt);
      }
    } catch (err) {
      tagsPanelStatus.textContent = "";
      showError(err);
    }
    tagsPanelInput.value = "";
    tagsPanel.style.display = "flex";
    tagsPanelInput.focus();
  })
);

document.getElementById("tags-panel-add").addEventListener("click", addTagFromInput);
tagsPanelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTagFromInput();
  }
});

document.getElementById("tags-panel-cancel").addEventListener("click", () => {
  tagsPanel.style.display = "none";
});

document.getElementById("tags-panel-confirm").addEventListener("click", async () => {
  if (!activeTab) return;
  // A tag still sitting in the text box (typed but not confirmed with
  // Enter/Add) shouldn't silently vanish on Save.
  addTagFromInput();
  try {
    const updated = await invoke("set_content_tags", { content: activeTabFullContent(), tags: tagsPanelTags });
    applyFullContentUpdate(updated);
    tagsPanel.style.display = "none";
  } catch (err) {
    tagsPanelStatus.textContent = "";
    showError(err);
  }
});

wirePanelKeys(newContentPanel, "new-content-confirm", "new-content-cancel");
wirePanelKeys(datePanel, "date-panel-confirm", "date-panel-cancel");
wirePanelKeys(renamePanel, "rename-panel-confirm", "rename-panel-cancel");
wirePanelKeys(tagsPanel, null, "tags-panel-cancel");

// Tags page: delete/rename/merge a tag across EVERY post that uses it, not
// just the one open in the editor right now - a full app-main page (see
// menus.js's showAppMainPage), not a modal, per pws-898q's later direction.
// Rename and merge are the exact same backend call (rewrite_tag) - typing a
// name that already exists elsewhere just IS a merge, so there's no
// separate "Merge" control to build or explain.
const tagsPageList = document.getElementById("tags-page-list");
const tagsPageStatus = document.getElementById("tags-page-status");
const tagsPageFilter = document.getElementById("tags-page-filter");

// {name, count, protectedBy: string[]} per tag, cached so the filter box
// re-renders instantly against what's already loaded instead of re-fetching
// on every keystroke.
let tagsPageTags = [];

const loadTagsPage = async () => {
  tagsPageStatus.textContent = "Loading...";
  try {
    const tags = await invoke("list_all_tags_with_counts");
    // A protected-tag check per tag, all in parallel - the same
    // find_taxonomy_term_template_refs check the old skippable confirm()
    // dialog used, now surfaced as a persistent "Required" badge up front
    // instead of only at the moment of the action (Sean lost a required
    // tag merging past that confirm once already).
    const protectedByLists = await Promise.all(
      tags.map((t) => invoke("find_taxonomy_term_template_refs", { term: t.name }).catch(() => []))
    );
    tagsPageTags = tags.map((t, i) => ({ ...t, protectedBy: protectedByLists[i] }));
    tagsPageStatus.textContent = tags.length === 0 ? "No tags used anywhere on the site yet." : "";
    renderTagsPageList();
  } catch (err) {
    tagsPageStatus.textContent = "";
    showError(err);
  }
};

const renderTagsPageList = () => {
  const query = tagsPageFilter.value.trim().toLowerCase();
  tagsPageList.innerHTML = "";
  const visible = query ? tagsPageTags.filter((t) => t.name.toLowerCase().includes(query)) : tagsPageTags;
  if (visible.length === 0 && tagsPageTags.length > 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px; color: var(--muted); font-size: 13px;";
    empty.textContent = "No tags match that filter.";
    tagsPageList.appendChild(empty);
    return;
  }

  for (const tag of visible) {
    const row = document.createElement("div");
    row.className = "tag-manage-row" + (tag.protectedBy.length > 0 ? " tag-manage-protected" : "");

    row.appendChild(makeIcon("tag", "tag-manage-icon"));

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tag-manage-name";
    input.value = tag.name;
    // Escape reverts to the actual tag name and drops focus - otherwise a
    // half-typed edit just sits there with no way to back out of it short
    // of retyping the original by hand.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      input.value = tag.name;
      input.blur();
    });
    row.appendChild(input);

    if (tag.protectedBy.length > 0) {
      const badge = document.createElement("span");
      badge.className = "tag-manage-protected-badge";
      badge.title =
        `Referenced by name in ${tag.protectedBy.join(", ")} - Rename and Delete are disabled until that ` +
        `template no longer needs this exact tag. Templates aren't editable in this app - open that file in ` +
        `a code editor (e.g. VS Code) to change it; this just won't rewrite it for you.`;
      badge.appendChild(makeIcon("lock"));
      badge.appendChild(document.createTextNode("Required"));
      row.appendChild(badge);
    }

    const count = document.createElement("button");
    count.type = "button";
    count.className = "tag-manage-count tag-manage-count-link";
    count.textContent = `${tag.count} post${tag.count === 1 ? "" : "s"}`;
    count.title = `See every post tagged "${tag.name}" on the Pages page`;
    count.addEventListener("click", () => showAppMainPage("pages", { tag: tag.name }));
    row.appendChild(count);

    const actions = document.createElement("span");
    actions.className = "tag-manage-actions";

    const isProtected = tag.protectedBy.length > 0;
    const isReviewing = reviewModeActive != null;

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "secondary btn-icon";
    rename.title = isProtected
      ? `Can't rename here - required by ${tag.protectedBy.join(", ")} (edit that template directly to change this)`
      : "Rename";
    rename.appendChild(makeIcon("pencil"));
    rename.disabled = isProtected || isReviewing;
    rename.addEventListener("click", async () => {
      const newName = input.value.trim();
      if (!newName) {
        tagsPageStatus.textContent = "Enter a name first.";
        return;
      }
      if (newName.toLowerCase() === tag.name.toLowerCase()) {
        // Nothing to rename yet - focus+select rather than silently doing
        // nothing, since the name field looks like plain text at rest
        // (Sean: "the edit button does nothing" - it was this, clicking
        // Rename before realizing the name itself is what you type into).
        input.focus();
        input.select();
        return;
      }
      const merging = tagsPageTags.some((t) => t.name !== tag.name && t.name.toLowerCase() === newName.toLowerCase());
      const proceed = await askConfirm(
        merging ? "Merge tags?" : "Rename this tag?",
        merging
          ? `"${tag.name}" and "${newName}" are both already in use - merge every post using either one into "${newName}"?`
          : `Rename "${tag.name}" to "${newName}" on every post that uses it?`,
        merging ? "Merge" : "Rename"
      );
      if (!proceed) return;
      tagsPageStatus.textContent = "Updating...";
      try {
        const changed = await invoke("rewrite_tag", { from: tag.name, to: newName });
        tagsPageStatus.textContent = `Updated ${changed} post${changed === 1 ? "" : "s"}.`;
        await loadTagsPage();
      } catch (err) {
        tagsPageStatus.textContent = "";
        showError(err);
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary btn-icon danger";
    del.title = isProtected
      ? `Can't delete here - required by ${tag.protectedBy.join(", ")} (edit that template directly to change this)`
      : "Delete";
    del.appendChild(makeIcon("trash"));
    del.disabled = isProtected || isReviewing;
    del.addEventListener("click", async () => {
      const proceed = await askConfirm(
        "Delete this tag?",
        `Remove "${tag.name}" from every post that uses it? This can't be undone.`,
        "Delete"
      );
      if (!proceed) return;
      tagsPageStatus.textContent = "Deleting...";
      try {
        const changed = await invoke("rewrite_tag", { from: tag.name, to: null });
        tagsPageStatus.textContent = `Updated ${changed} post${changed === 1 ? "" : "s"}.`;
        await loadTagsPage();
      } catch (err) {
        tagsPageStatus.textContent = "";
        showError(err);
      }
    });

    actions.append(rename, del);
    row.appendChild(actions);
    tagsPageList.appendChild(row);
  }
};

tagsPageFilter.addEventListener("input", renderTagsPageList);

document.addEventListener("beedance:page-changed", (e) => {
  if (e.detail.page === "tags") loadTagsPage();
});
// Review mode can toggle while the Tags page happens to already be open -
// re-render so Rename/Delete pick up the disabled state immediately rather
// than only on the next navigation to this page.
document.addEventListener("beedance:tab-changed", () => {
  if (document.getElementById("tags-page").style.display !== "none") renderTagsPageList();
});

// The per-post Tags popover's own "Manage tags..." link - closes that
// popup and navigates to the real Tags page instead of opening a second,
// now-removed modal on top of it.
document.getElementById("manage-tags-open").addEventListener("click", () => {
  tagsPanel.style.display = "none";
  showAppMainPage("tags");
});

// Zola's Section front matter is a genuinely smaller, different set of
// recognized fields than Page's - no `date`, no `taxonomies` (tags), only
// `extra` as a catch-all. Stamping either onto a section index (_index.md)
// isn't just wrong, it's a hard TOML "unknown field" build error - the same
// class of bug found and fixed for the automatic `updated` stamp (site.rs's
// write_file). Guarded here, at the only two buttons that could trigger it,
// rather than in the backend commands themselves, which take raw content
// text with no path at all to check against.
const fmtDateButton = document.getElementById("fmt-date");
const fmtTagsButton = document.getElementById("fmt-tags");

// Composed with reviewModeActive (not just the section check alone) so this
// doesn't fight git-workflow.js's own review-mode disabling over the same
// two buttons - each recomputes independently from the same shared state
// instead of one overwriting the other's reason for disabling.
const updateSectionAwareToolbar = () => {
  const isSection = activeTab != null && activeTab.split("/").pop() === "_index.md";
  const disabled = isSection || reviewModeActive != null;
  fmtDateButton.disabled = disabled;
  fmtTagsButton.disabled = disabled;
  fmtDateButton.title = isSection ? "Not available for section pages" : "";
  fmtTagsButton.title = isSection ? "Not available for section pages" : "";
};
document.addEventListener("beedance:tab-changed", updateSectionAwareToolbar);
