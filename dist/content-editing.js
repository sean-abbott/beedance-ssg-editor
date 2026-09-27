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
} from "./editor-core.js";
import { makeIcon } from "./icons.js";

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

// Manage tags: delete/rename/merge a tag across EVERY post that uses it,
// not just the one open in the editor right now - reached from the same
// Tags panel (per the original request) rather than its own toolbar
// button, since it's about the site's tag taxonomy as a whole, not this
// one page. Rename and merge are the exact same backend call
// (rewrite_tag) - typing a name that already exists elsewhere just IS a
// merge, so there's no separate "Merge" control to build or explain.
const manageTagsPanel = document.getElementById("manage-tags-panel");
const manageTagsList = document.getElementById("manage-tags-list");
const manageTagsStatus = document.getElementById("manage-tags-status");

const openManageTags = async () => {
  manageTagsStatus.textContent = "";
  try {
    const tags = await invoke("list_all_tags");
    renderManageTagsList(tags);
    if (tags.length === 0) manageTagsStatus.textContent = "No tags used anywhere on the site yet.";
  } catch (err) {
    showError(err);
  }
};

// Deleting or renaming/merging a tag makes its OLD name disappear entirely -
// if a theme template hardcodes that exact name (e.g.
// get_taxonomy_term(kind="tags", term="event")), the next Zola build breaks
// with an "unknown term" error that has nothing to do with content and is
// hard to trace back to "I renamed a tag" after the fact (found this the
// hard way merging "event" into "events"). Zola can't warn about this ahead
// of time itself, so this is the one place that can.
const confirmTagRemovalSafe = async (tag) => {
  let refs = [];
  try {
    refs = await invoke("find_taxonomy_term_template_refs", { term: tag });
  } catch {
    return true; // Check failing shouldn't block the rename/delete itself.
  }
  if (refs.length === 0) return true;
  return askConfirm(
    "This tag is hardcoded in a template",
    `"${tag}" is referenced by name in ${refs.join(", ")} - removing it will likely break the site's next build ` +
      `unless that template is updated too. Proceed anyway?`,
    "Proceed anyway"
  );
};

const renderManageTagsList = (tags) => {
  manageTagsList.innerHTML = "";
  for (const tag of tags) {
    const row = document.createElement("div");
    row.className = "manage-tag-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "manage-tag-name";
    input.value = tag;

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "secondary";
    rename.textContent = "Rename";
    rename.addEventListener("click", async () => {
      const newName = input.value.trim();
      if (!newName) {
        manageTagsStatus.textContent = "Enter a name first.";
        return;
      }
      if (newName.toLowerCase() === tag.toLowerCase()) return;
      const merging = tags.some((t) => t !== tag && t.toLowerCase() === newName.toLowerCase());
      if (!(await confirmTagRemovalSafe(tag))) return;
      const proceed = await askConfirm(
        merging ? "Merge tags?" : "Rename this tag?",
        merging
          ? `"${tag}" and "${newName}" are both already in use - merge every post using either one into "${newName}"?`
          : `Rename "${tag}" to "${newName}" on every post that uses it?`,
        merging ? "Merge" : "Rename"
      );
      if (!proceed) return;
      manageTagsStatus.textContent = "Updating...";
      try {
        const count = await invoke("rewrite_tag", { from: tag, to: newName });
        manageTagsStatus.textContent = `Updated ${count} post${count === 1 ? "" : "s"}.`;
        await openManageTags();
      } catch (err) {
        manageTagsStatus.textContent = "";
        showError(err);
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!(await confirmTagRemovalSafe(tag))) return;
      const proceed = await askConfirm(
        "Delete this tag?",
        `Remove "${tag}" from every post that uses it? This can't be undone.`,
        "Delete"
      );
      if (!proceed) return;
      manageTagsStatus.textContent = "Deleting...";
      try {
        const count = await invoke("rewrite_tag", { from: tag, to: null });
        manageTagsStatus.textContent = `Updated ${count} post${count === 1 ? "" : "s"}.`;
        await openManageTags();
      } catch (err) {
        manageTagsStatus.textContent = "";
        showError(err);
      }
    });

    row.append(input, rename, del);
    manageTagsList.appendChild(row);
  }
};

document.getElementById("manage-tags-open").addEventListener("click", async () => {
  tagsPanel.style.display = "none";
  await openManageTags();
  manageTagsPanel.style.display = "flex";
});

// Same panel, reached directly from the top-level toolbar - this is a
// site-wide operation, not tied to whatever page (if any) is currently
// open, so it shouldn't require going through a specific post's own Tags
// panel first.
document.getElementById("manage-tags-button").addEventListener("click", async () => {
  await openManageTags();
  manageTagsPanel.style.display = "flex";
});

document.getElementById("manage-tags-close").addEventListener("click", () => {
  manageTagsPanel.style.display = "none";
});

wirePanelKeys(manageTagsPanel, null, "manage-tags-close");

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
