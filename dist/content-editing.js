// New post/page, rename, delete, page date, tags, and the plain-text
// formatting toolbar (bold/italic/code/link/headings/quote/lists) - the
// panels the format toolbar drives, per pws-zg1h's module split.

import {
  editorEl,
  fileSelect,
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
} from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

// "New post"/"New page" share one small modal (title field, kind-specific
// help text) rather than two near-identical dialogs - the only real
// difference is which Rust command runs and what the help text says.
const NEW_CONTENT_HELP = {
  post: "A post is dated content - a blog entry or event - that fades in relevance over time. It's not part of the site's permanent menu.",
  page: "A page is a permanent, menu-linked fixture (like \"About\" or \"Events\"). Use this for content that stays relevant indefinitely.",
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

  // A page always nests under an existing menu section (e.g. a new page
  // under "Biodiversity") rather than minting its own top-level section -
  // this site's nav is hardcoded in the template, so a brand-new
  // top-level section wouldn't be reachable from the menu at all until
  // the nav is rebuilt on a data-driven convention that supports adding
  // new top-level entries from here.
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
    fileSelect.value = path;
    await openTab(path);
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
      const title = await invoke("get_front_matter_title", { content: editorEl.value });
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
      content: editorEl.value,
      datetime: nowForZola(),
      author: currentAuthorName,
    });
    const newPath = await invoke("rename_content", { path: oldPath, newTitle });
    closeTabQuietly(oldPath);
    renamePanel.style.display = "none";
    await refreshFileList();
    fileSelect.value = newPath;
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

// Wraps the selection as link text and leaves the placeholder URL
// selected, so typing the real URL right after clicking just replaces it.
const insertLink = () => {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const value = editorEl.value;
  const linkText = value.slice(start, end) || "link text";
  const url = "https://";

  editorEl.value = value.slice(0, start) + "[" + linkText + "](" + url + ")" + value.slice(end);
  editorEl.focus();
  const urlStart = start + 1 + linkText.length + 2;
  editorEl.setSelectionRange(urlStart, urlStart + url.length);
  emitEdited();
};

document.getElementById("fmt-bold").addEventListener("click", withActiveTab(() => wrapSelection("**", "**")));
document.getElementById("fmt-italic").addEventListener("click", withActiveTab(() => wrapSelection("_", "_")));
document.getElementById("fmt-code").addEventListener("click", withActiveTab(() => wrapSelection("`", "`")));
document.getElementById("fmt-link").addEventListener("click", withActiveTab(insertLink));
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
      const current = await invoke("get_front_matter_date", { content: editorEl.value });
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
    const updated = await invoke("remove_front_matter_date", { content: editorEl.value });
    editorEl.value = updated;
    emitEdited();
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
    const updated = await invoke("set_front_matter_date", { content: editorEl.value, datetime });
    editorEl.value = updated;
    emitEdited();
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
    remove.setAttribute("aria-label", "Remove " + tag);
    remove.textContent = "×";
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
        invoke("get_content_tags", { content: editorEl.value }),
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
    const updated = await invoke("set_content_tags", { content: editorEl.value, tags: tagsPanelTags });
    editorEl.value = updated;
    emitEdited();
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
