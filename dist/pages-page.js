// Pages page: a browsable, filterable list of every real page/post on the
// site (site-menu.js owns this same page's OTHER section, "Site
// navigation" - kept separate since that one's a distinct, pre-existing
// concern this page just now also hosts). Reached from the sidebar's
// "Pages" nav item (see menus.js's showAppMainPage).

import { openTab, fileSelect, showError, createSearchCombobox } from "./editor-core.js";
import { makeIcon } from "./icons.js";
import { showAppMainPage } from "./menus.js";

const { invoke } = window.__TAURI__.core;

const pagesPageList = document.getElementById("pages-page-list");
const filterTitle = document.getElementById("pages-page-filter-title");
const filterKind = document.getElementById("pages-page-filter-kind");
const filterContextBanner = document.getElementById("pages-filter-context");
const filterContextLabel = document.getElementById("pages-filter-context-label");

let allPages = [];
let currentKindFilter = "all";
// {label, value} per distinct tag in use, plus a leading "All tags" (value
// null) entry - rebuilt by populateTagFilterOptions whenever allPages
// changes. Case-insensitive dedup (first-seen casing wins), matching how
// the rest of the tag system already treats tag names.
let tagFilterEntries = [{ label: "All tags", value: null }];

// Set either by picking directly from the tag filter combobox (the
// obvious, discoverable way to filter by tag from this page itself) or by
// the Tags page's "N posts" link (showAppMainPage("pages", { tag }) - see
// menus.js). A plain sidebar-nav click always passes tag: null (menus.js's
// own default), so navigating here normally never carries a stale filter
// over from an earlier visit.
let currentTagFilter = null;

// Set by Media's "Used on N pages" link (showAppMainPage("pages", { paths,
// image }) - see menus.js and media-page.js) - an exact-pages filter,
// deliberately a different dimension than the tag combobox above. Gets its
// own dismissible banner rather than folding into the tag filter's UI, so
// "how did I get this narrowed view" stays visible and undoable on its own,
// independent of whatever tag filter (if any) is also active.
let currentPathsFilter = null;
let currentPathsFilterImage = null;
let pagesLoaded = false;

const renderFilterContextBanner = () => {
  const active = currentPathsFilter && currentPathsFilter.length > 0;
  filterContextBanner.classList.toggle("visible", !!active);
  if (active) {
    filterContextLabel.textContent =
      `Showing ${currentPathsFilter.length} page${currentPathsFilter.length === 1 ? "" : "s"} that use ` +
      `"${currentPathsFilterImage}"`;
  }
};

document.getElementById("pages-filter-context-clear").addEventListener("click", () => {
  currentPathsFilter = null;
  currentPathsFilterImage = null;
  renderFilterContextBanner();
  renderPagesList();
});

// Same searchable combobox the main "Open file" control and the site-menu
// page picker use (see createSearchCombobox in editor-core.js) - a plain
// <select> here would be the odd one out, and Sean specifically asked for
// this to match rather than reinvent a second filter pattern.
const tagFilterCombobox = createSearchCombobox({
  input: document.getElementById("pages-page-tag-filter"),
  resultsEl: document.getElementById("pages-page-tag-filter-results"),
  getEntries: () => tagFilterEntries,
  getCurrentLabel: () => tagFilterEntries.find((e) => e.value === currentTagFilter)?.label || "All tags",
  onSelect: (entry) => {
    applyTagFilter(entry.value);
    renderPagesList();
  },
});

// Sets the active filter and keeps the combobox's displayed text in sync
// with it - the single place both directions of "which tag is selected"
// flow through, whether the tag came from picking it directly here, from
// the Tags page's "N posts" link, or from re-syncing after the entry list
// itself was just rebuilt (see populateTagFilterOptions). Falls back to
// "All tags" if the requested tag isn't one of the current entries (e.g.
// a stale filter naming a tag that's since been removed).
const applyTagFilter = (tag) => {
  const exists = tag && tagFilterEntries.some((e) => e.value === tag);
  currentTagFilter = exists ? tag : null;
  tagFilterCombobox.syncDisplay();
};

// Rebuilds the combobox's own entry list from whatever tags are actually
// in use among the currently loaded pages.
const populateTagFilterOptions = () => {
  const seen = new Map();
  for (const page of allPages) {
    for (const tag of page.tags) {
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
  }
  const tags = [...seen.values()].sort((a, b) => a.localeCompare(b));
  tagFilterEntries = [{ label: "All tags", value: null }, ...tags.map((t) => ({ label: t, value: t }))];
  applyTagFilter(currentTagFilter);
};

const formatDate = (isoLike) => {
  if (!isoLike) return "—";
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return isoLike;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const renderPagesList = () => {
  const query = filterTitle.value.trim().toLowerCase();
  const visible = allPages.filter((p) => {
    if (currentKindFilter === "pages" && p.isBlogHeading) return false;
    if (currentKindFilter === "posts" && !p.isBlogHeading) return false;
    if (query && !p.label.toLowerCase().includes(query)) return false;
    // Case-insensitive, matching how the rest of the tag system (rewrite_
    // tag's own de-dupe, etc.) already treats tag names.
    if (currentTagFilter && !p.tags.some((t) => t.toLowerCase() === currentTagFilter.toLowerCase())) return false;
    if (currentPathsFilter && !currentPathsFilter.includes(p.path)) return false;
    return true;
  });

  pagesPageList.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px; color: var(--muted); font-size: 13px;";
    empty.textContent =
      allPages.length === 0
        ? "No pages or posts yet."
        : currentPathsFilter
          ? `None of the pages using "${currentPathsFilterImage}" match the rest of this filter.`
          : currentTagFilter
            ? `Nothing tagged "${currentTagFilter}" matches the rest of this filter.`
            : "Nothing matches that filter.";
    pagesPageList.appendChild(empty);
    return;
  }

  for (const page of visible) {
    const row = document.createElement("div");
    row.className = "content-row";

    row.appendChild(makeIcon(page.isBlogHeading ? "doc-post" : "doc", "content-row-icon"));

    const openInEditor = () => {
      fileSelect.value = page.path;
      openTab(page.path);
      showAppMainPage("editor");
    };

    const main = document.createElement("div");
    main.className = "content-row-main";
    const title = document.createElement("span");
    title.className = "content-row-title content-row-title-link";
    title.textContent = page.label;
    title.title = "Open in editor";
    title.addEventListener("click", openInEditor);
    const path = document.createElement("span");
    path.className = "content-row-path";
    path.textContent = page.path;
    main.append(title, path);
    row.appendChild(main);

    const tags = document.createElement("span");
    tags.className = "content-row-tags";
    for (const tag of page.tags) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = tag;
      tags.appendChild(chip);
    }
    row.appendChild(tags);

    // Title and tags each get ~50% of the row's flexible space (see
    // .content-row-tags's flex:1 1 0 + overflow:hidden) - a page with many
    // tags used to push the title out of the way; beyond a fixed count of
    // 2, the rest collapse into this toggle instead of crowding the row.
    const maxVisibleTags = 2;
    if (page.tags.length > maxVisibleTags) {
      const extra = page.tags.length - maxVisibleTags;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tag-overflow-toggle";
      toggle.textContent = `+${extra}`;
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const expanded = tags.classList.toggle("expanded");
        toggle.textContent = expanded ? "Show less" : `+${extra}`;
      });
      row.appendChild(toggle);
    }

    const date = document.createElement("span");
    date.className = "content-row-date";
    date.textContent = formatDate(page.date);
    row.appendChild(date);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary btn-icon";
    open.title = "Open in editor";
    open.appendChild(makeIcon("external-link"));
    open.addEventListener("click", openInEditor);
    row.appendChild(open);

    pagesPageList.appendChild(row);
  }
};

const loadPagesList = async () => {
  try {
    const files = await invoke("list_editable_files_detailed");
    allPages = files.filter((f) => !f.isSectionIndex && f.group !== "Templates");
    populateTagFilterOptions();
    renderPagesList();
  } catch (err) {
    showError(err);
  }
};

filterTitle.addEventListener("input", renderPagesList);
filterKind.querySelectorAll("button[data-kind]").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentKindFilter = btn.dataset.kind;
    filterKind.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    renderPagesList();
  });
});
document.getElementById("pages-page-new-post").addEventListener("click", () => {
  document.getElementById("new-post").click();
});
document.getElementById("pages-page-new-page").addEventListener("click", () => {
  document.getElementById("new-page").click();
});

document.addEventListener("beedance:page-changed", (e) => {
  if (e.detail.page !== "pages") return;
  // Unlike the tag filter, the exact-paths filter has no entry list to
  // validate against - a raw assignment is always safe, even on the very
  // first load, so this doesn't need the tag filter's deferred-validation
  // dance below.
  currentPathsFilter = e.detail.paths;
  currentPathsFilterImage = e.detail.image;
  renderFilterContextBanner();
  if (!pagesLoaded) {
    // applyTagFilter validates against tagFilterEntries, which don't exist
    // yet before the first real load - a raw assignment here instead, so
    // loadPagesList's own populateTagFilterOptions (which re-applies
    // currentTagFilter once real entries exist) is what actually validates
    // and syncs it. Calling applyTagFilter here too would silently reset
    // an incoming tag to null before that ever happens, dropping the very
    // first click-through from the Tags page.
    currentTagFilter = e.detail.tag;
    pagesLoaded = true;
    loadPagesList();
  } else {
    applyTagFilter(e.detail.tag);
    renderPagesList();
  }
});
// A create through the File menu (or this page's own New post/New page
// shortcuts, which delegate to those same buttons) should show up here
// without needing to leave and re-enter the page - refreshFileList already
// runs after every create; piggyback on the same "file list changed" event
// it fires (see editor-core.js's notifyTabChanged... actually simplest:
// just reload whenever this page is visible and a file list refresh
// happens elsewhere, via the existing beedance:tab-changed event content
// creation already triggers alongside its own refreshFileList call).
document.addEventListener("beedance:tab-changed", () => {
  if (pagesLoaded && document.getElementById("pages-page").style.display !== "none") loadPagesList();
});
