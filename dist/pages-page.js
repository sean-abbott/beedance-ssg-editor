// Pages page: a browsable, filterable list of every real page/post on the
// site (site-menu.js owns this same page's OTHER section, "Site
// navigation" - kept separate since that one's a distinct, pre-existing
// concern this page just now also hosts). Reached from the sidebar's
// "Pages" nav item (see menus.js's showAppMainPage).

import { openTab, fileSelect, showError } from "./editor-core.js";
import { makeIcon } from "./icons.js";
import { showAppMainPage } from "./menus.js";

const { invoke } = window.__TAURI__.core;

const pagesPageList = document.getElementById("pages-page-list");
const filterTitle = document.getElementById("pages-page-filter-title");
const filterKind = document.getElementById("pages-page-filter-kind");
const tagFilterChip = document.getElementById("pages-page-tag-filter-chip");
const tagFilterName = document.getElementById("pages-page-tag-filter-name");

let allPages = [];
let currentKindFilter = "all";
// Set by the Tags page's "N posts" link (showAppMainPage("pages", { tag })
// - see menus.js) - a plain sidebar-nav click always passes tag: null
// (menus.js's own default), so navigating here normally never carries a
// stale filter over from an earlier visit.
let currentTagFilter = null;
let pagesLoaded = false;

const applyTagFilter = (tag) => {
  currentTagFilter = tag;
  tagFilterChip.style.display = tag ? "inline-flex" : "none";
  tagFilterName.textContent = tag || "";
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
    return true;
  });

  pagesPageList.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px; color: var(--muted); font-size: 13px;";
    empty.textContent =
      allPages.length === 0
        ? "No pages or posts yet."
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

    const main = document.createElement("div");
    main.className = "content-row-main";
    const title = document.createElement("span");
    title.className = "content-row-title";
    title.textContent = page.label;
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

    const date = document.createElement("span");
    date.className = "content-row-date";
    date.textContent = formatDate(page.date);
    row.appendChild(date);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary btn-icon";
    open.title = "Open in editor";
    open.appendChild(makeIcon("external-link"));
    open.addEventListener("click", () => {
      fileSelect.value = page.path;
      openTab(page.path);
      showAppMainPage("editor");
    });
    row.appendChild(open);

    pagesPageList.appendChild(row);
  }
};

const loadPagesList = async () => {
  try {
    const files = await invoke("list_editable_files_detailed");
    allPages = files.filter((f) => !f.isSectionIndex && f.group !== "Templates");
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

document.getElementById("pages-page-tag-filter-clear").addEventListener("click", () => {
  applyTagFilter(null);
  renderPagesList();
});

document.addEventListener("beedance:page-changed", (e) => {
  if (e.detail.page !== "pages") return;
  applyTagFilter(e.detail.tag);
  if (!pagesLoaded) {
    pagesLoaded = true;
    loadPagesList();
  } else {
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
