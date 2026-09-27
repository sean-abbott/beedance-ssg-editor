// Site menu editor: view/add/remove/reorder the site's main navigation,
// backed by config.toml's [[extra.menu]] (get_site_menu/set_site_menu in
// menu.rs) - the same {name, url} shape the bundled sample site's Abridge
// theme already reads natively, so this same editor works whether or not
// the site's actual theme happens to be Abridge.
//
// Flat, single-level only - neither this data model nor the site's own
// template render a submenu/dropdown for a page's children. Multi-level
// nav editing is separate, not-yet-built future work (see pws-ws2).

import {
  wirePanelKeys,
  showError,
  nowForZola,
  currentAuthorName,
  refreshFileList,
  createSearchCombobox,
} from "./editor-core.js";
import { makeIcon } from "./icons.js";

const { invoke } = window.__TAURI__.core;

const siteMenuPanel = document.getElementById("site-menu-panel");
const siteMenuList = document.getElementById("site-menu-list");
const siteMenuStatus = document.getElementById("site-menu-status");

const createPanel = document.getElementById("site-menu-create-panel");
const createTitleEl = document.getElementById("site-menu-create-title");
const createInput = document.getElementById("site-menu-create-input");
const createSectionRow = document.getElementById("site-menu-create-section-row");
const createSectionSelect = document.getElementById("site-menu-create-section");
const createStatus = document.getElementById("site-menu-create-status");

// {name, kind: "page"|"external", pageUrl, externalUrl} per row - pageUrl/
// externalUrl are kept side by side rather than a single "value" so
// switching the kind dropdown back and forth never loses whatever was
// already chosen/typed in the other one. "New page.../New section..." are
// transient kindSelect choices, not a durable row.kind - picking one opens
// createPanel instead (see openCreatePanel), and the row itself only ever
// settles back into "page" (on success) or whatever it already was (on
// cancel).
let rows = [];
// {path, label, title, group, isSectionIndex} for every content file (not
// templates) - populates each row's "existing page" picker. label is the
// disambiguated "Title (Group)" shown there; title is the page's own plain
// title, used as the menu entry's name when left blank (see saveSiteMenu);
// group/isSectionIndex drive the picker's grouped view and its "Section"
// tag (see createSearchCombobox in editor-core.js).
let linkablePages = [];
// {slug, title} for every top-level section - populates the create-page
// popup's own parent-section dropdown (same source create_page's own
// standalone dialog uses).
let sections = [];
// Which row/kind createPanel is currently working on.
let pendingCreate = null;

const zolaUrlForPage = (path) => "@/" + path.replace(/^content\//, "");

// Re-fetched (rather than hand-synthesized) after creating a page/section,
// so a freshly created entry's label/group matches exactly what a real
// panel-open would show - no risk of this JS drifting from site.rs's own
// group/label logic.
const refreshPagesAndSections = async () => {
  const [files, sectionList] = await Promise.all([invoke("list_editable_files_detailed"), invoke("list_page_sections")]);
  linkablePages = files
    .filter((f) => f.group !== "Templates")
    .map((f) => ({
      path: f.path,
      label: `${f.label} (${f.group})`,
      title: f.label,
      group: f.group,
      isSectionIndex: f.isSectionIndex,
    }));
  sections = sectionList;
};

const openCreatePanel = (row, kind) => {
  pendingCreate = { row, kind };
  createTitleEl.textContent = kind === "new-page" ? "New page" : "New section";
  createInput.value = "";
  createStatus.textContent = "";
  createSectionRow.style.display = kind === "new-page" ? "block" : "none";
  if (kind === "new-page") {
    createSectionSelect.innerHTML = "";
    for (const s of sections) {
      const opt = document.createElement("option");
      opt.value = s.slug;
      opt.textContent = s.title;
      createSectionSelect.appendChild(opt);
    }
    if (sections.length === 0) {
      createStatus.textContent = "This site has no existing sections to add a page to yet.";
    }
  }
  createPanel.style.display = "flex";
  createInput.focus();
};

const renderSiteMenuList = () => {
  siteMenuList.innerHTML = "";
  rows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "menu-entry-row";

    // Drag to reorder - the up/down buttons below work fine for a small
    // nudge, but repeatedly clicking "up" at a fixed mouse position to move
    // something a long way doesn't keep hitting the same row (each click
    // reshuffles which row's button ends up under the cursor next). A drag
    // sidesteps that entirely: the dragged row's own element visually
    // tracks the pointer for the whole gesture (a CSS transform, not a
    // rebuild - rebuilding mid-drag would drop the pointer capture this
    // relies on), and the array only actually reorders once, on release.
    const dragHandle = document.createElement("span");
    dragHandle.className = "menu-entry-drag";
    dragHandle.title = "Drag to reorder";
    // An SVG grip icon rather than a Unicode glyph (the earlier "⠿" was
    // hard to see - too small/faint, and glyph rendering/legibility varies
    // across this app's 3 target webviews anyway) - vector paths render
    // identically everywhere, unlike font glyph coverage/hinting.
    dragHandle.appendChild(makeIcon("grip"));
    dragHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startIndex = i;
      const startY = e.clientY;
      const rowHeight = el.getBoundingClientRect().height + 6;
      // A fixed snapshot of the OTHER rows' elements, taken before the
      // indicator (below) becomes a sibling of theirs too - inserting the
      // indicator shifts live DOM indices around as it moves, so computing
      // "which element to insert before" against this stable array (never
      // touched again during the drag) instead of a live children lookup
      // keeps that math correct throughout.
      const rowEls = Array.from(siteMenuList.children);
      dragHandle.setPointerCapture(e.pointerId);
      el.classList.add("dragging");

      const indicator = document.createElement("div");
      indicator.className = "menu-entry-drop-indicator";

      const computeTargetIndex = (clientY) => {
        const deltaRows = Math.round((clientY - startY) / rowHeight);
        return Math.min(rows.length - 1, Math.max(0, startIndex + deltaRows));
      };
      // targetIndex is where the dragged row will land among the OTHER
      // (rowEls) rows once removed from its own original slot - one slot
      // earlier in rowEls-space than targetIndex once the drop point has
      // passed the dragged row's own original position, since that's one
      // fewer "other" row separating the start of the list from there.
      const placeIndicator = (targetIndex) => {
        const boundary = targetIndex < startIndex ? targetIndex : targetIndex + 1;
        siteMenuList.insertBefore(indicator, rowEls[boundary] || null);
      };
      placeIndicator(startIndex);

      const onMove = (moveEvent) => {
        el.style.transform = `translateY(${moveEvent.clientY - startY}px)`;
        placeIndicator(computeTargetIndex(moveEvent.clientY));
      };
      const onUp = (upEvent) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        el.classList.remove("dragging");
        el.style.transform = "";
        indicator.remove();

        const targetIndex = computeTargetIndex(upEvent.clientY);
        if (targetIndex !== startIndex) {
          const [moved] = rows.splice(startIndex, 1);
          rows.splice(targetIndex, 0, moved);
          renderSiteMenuList();
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });

    const up = document.createElement("button");
    up.type = "button";
    up.className = "secondary";
    up.textContent = "▲";
    up.title = "Move up";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
      renderSiteMenuList();
    });

    const down = document.createElement("button");
    down.type = "button";
    down.className = "secondary";
    down.textContent = "▼";
    down.title = "Move down";
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => {
      [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
      renderSiteMenuList();
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "menu-entry-name";
    nameInput.placeholder = "Label";
    nameInput.value = row.name;
    nameInput.addEventListener("input", () => {
      row.name = nameInput.value;
    });

    const kindSelect = document.createElement("select");
    kindSelect.className = "menu-entry-kind";
    for (const [value, text] of [
      ["page", "Existing page"],
      ["new-page", "New page…"],
      ["new-section", "New section…"],
      ["external", "Web address"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      kindSelect.appendChild(opt);
    }
    kindSelect.value = row.kind;

    // Same searchable combobox the main "Open file" control uses (see
    // createSearchCombobox in editor-core.js) - a plain <select> here had
    // no search at all, and made it easy to lose track of a page that was
    // created but never added to the nav (Sean: "I can find environment
    // now" once he tried the top-level picker instead). Each entry's
    // isSectionIndex also gets a "Section" tag, since it's otherwise not
    // obvious which pages could have something nested under them.
    const pageWrap = document.createElement("span");
    pageWrap.className = "menu-entry-page-wrap";
    const pageInput = document.createElement("input");
    pageInput.type = "text";
    pageInput.className = "menu-entry-page";
    pageInput.placeholder = "Search pages…";
    const pageResults = document.createElement("div");
    pageResults.className = "search-combobox-results";
    pageWrap.append(pageInput, pageResults);

    const pageCombobox = createSearchCombobox({
      input: pageInput,
      resultsEl: pageResults,
      getEntries: () => linkablePages,
      getCurrentLabel: () => linkablePages.find((p) => zolaUrlForPage(p.path) === row.pageUrl)?.label || "",
      onSelect: (entry) => {
        row.pageUrl = zolaUrlForPage(entry.path);
        row.justCreated = false;
        newBadge.style.display = "none";
      },
    });
    pageCombobox.syncDisplay();

    // Marks a row whose page/section was just minted through this same
    // dialog (openCreatePanel) rather than picked from what already
    // existed - it otherwise looks identical to any other "Existing page"
    // entry, with nothing showing it's actually brand new. Visibility is
    // set below, by applyKindVisibility.
    const newBadge = document.createElement("span");
    newBadge.className = "menu-entry-new-badge";
    newBadge.textContent = "New";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "menu-entry-url";
    urlInput.placeholder = "https://...";
    urlInput.value = row.externalUrl;
    urlInput.addEventListener("input", () => {
      row.externalUrl = urlInput.value;
    });

    const applyKindVisibility = () => {
      pageWrap.style.display = row.kind === "page" ? "" : "none";
      urlInput.style.display = row.kind === "external" ? "" : "none";
      newBadge.style.display = row.kind === "page" && row.justCreated ? "" : "none";
      nameInput.placeholder = row.kind === "page" ? "Label (defaults to the page's title)" : "Label";
    };
    applyKindVisibility();
    kindSelect.addEventListener("change", () => {
      const chosen = kindSelect.value;
      if (chosen === "new-page" || chosen === "new-section") {
        // Doesn't change row.kind (or the row's layout) at all yet - only a
        // successful create in the popup does that (see
        // site-menu-create-confirm). Snap the dropdown back to what the
        // row actually still is right away, rather than leaving it showing
        // a transient choice the row hasn't adopted.
        kindSelect.value = row.kind;
        openCreatePanel(row, chosen);
        return;
      }
      row.kind = chosen;
      applyKindVisibility();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "×";
    remove.title = "Remove this link";
    remove.addEventListener("click", () => {
      rows.splice(i, 1);
      renderSiteMenuList();
    });

    el.append(dragHandle, up, down, nameInput, kindSelect, pageWrap, newBadge, urlInput, remove);
    siteMenuList.appendChild(el);
  });
};

document.getElementById("site-menu-button").addEventListener("click", async () => {
  setSiteMenuStatus("", null);
  try {
    const entries = await invoke("get_site_menu");
    await refreshPagesAndSections();

    rows = entries.map((e) => {
      const isExternal = /^https?:\/\//.test(e.url);
      return {
        name: e.name,
        kind: isExternal ? "external" : "page",
        pageUrl: isExternal ? (linkablePages[0] ? zolaUrlForPage(linkablePages[0].path) : "") : e.url,
        externalUrl: isExternal ? e.url : "",
      };
    });
    renderSiteMenuList();
    siteMenuPanel.style.display = "flex";
  } catch (err) {
    showError(err);
  }
});

document.getElementById("site-menu-add").addEventListener("click", () => {
  rows.push({
    name: "",
    kind: "page",
    pageUrl: linkablePages[0] ? zolaUrlForPage(linkablePages[0].path) : "",
    externalUrl: "",
  });
  renderSiteMenuList();
});

document.getElementById("site-menu-create-cancel").addEventListener("click", () => {
  createPanel.style.display = "none";
  pendingCreate = null;
});

document.getElementById("site-menu-create-confirm").addEventListener("click", async () => {
  if (!pendingCreate) return;
  const { row, kind } = pendingCreate;
  const title = createInput.value.trim();
  if (!title) {
    createStatus.textContent = "Enter a title first.";
    return;
  }
  if (kind === "new-page" && !createSectionSelect.value) {
    createStatus.textContent = "Choose a section first.";
    return;
  }
  createStatus.textContent = "Creating...";
  try {
    const path =
      kind === "new-page"
        ? await invoke("create_page", {
            title,
            section: createSectionSelect.value,
            datetime: nowForZola(),
            author: currentAuthorName,
          })
        : await invoke("create_section", { title, author: currentAuthorName });
    // Both the menu editor's own page/section pickers AND the main "Open
    // file" dropdown need to know about this - they're two separate
    // frontend modules with their own independently-fetched copies of the
    // same underlying file list, so creating a file through this dialog
    // doesn't otherwise reach the other one at all.
    await Promise.all([refreshPagesAndSections(), refreshFileList()]);
    row.kind = "page";
    row.pageUrl = zolaUrlForPage(path);
    row.justCreated = true;
    if (!row.name.trim()) row.name = title;
    createPanel.style.display = "none";
    pendingCreate = null;
    renderSiteMenuList();
  } catch (err) {
    createStatus.textContent = "";
    showError(err);
  }
});

let siteMenuStatusClearTimer = null;

const setSiteMenuStatus = (text, kind) => {
  clearTimeout(siteMenuStatusClearTimer);
  siteMenuStatus.textContent = text;
  siteMenuStatus.classList.remove("status-success", "status-error");
  if (kind) siteMenuStatus.classList.add(kind === "success" ? "status-success" : "status-error");
  if (kind === "success") {
    siteMenuStatusClearTimer = setTimeout(() => {
      siteMenuStatus.textContent = "";
      siteMenuStatus.classList.remove("status-success");
    }, 3000);
  }
};

// Returns true on a successful save, false on a validation problem or a
// real error (already reported, either inline or via showError) - so
// site-menu-save-close only closes the panel once the save actually went
// through, not just because the button was clicked.
const saveSiteMenu = async () => {
  const entries = [];
  for (const row of rows) {
    const url = row.kind === "external" ? row.externalUrl.trim() : row.pageUrl;
    // Leaving the label blank for an existing-page entry defaults it to
    // that page's own title - no need to pick a page from the dropdown
    // and then retype its exact title right back into the label field.
    // A web address has no title to fall back on, so it still needs one.
    let name = row.name.trim();
    if (!name && row.kind === "page") {
      name = linkablePages.find((p) => zolaUrlForPage(p.path) === url)?.title || "";
    }
    if (!name || !url) {
      setSiteMenuStatus("Every link needs a label and a destination.", "error");
      return false;
    }
    entries.push({ name, url });
  }
  setSiteMenuStatus("Saving...", null);
  try {
    await invoke("set_site_menu", { entries });
    setSiteMenuStatus("✓ Saved.", "success");
    return true;
  } catch (err) {
    setSiteMenuStatus("", null);
    showError(err);
    return false;
  }
};

document.getElementById("site-menu-save").addEventListener("click", saveSiteMenu);

document.getElementById("site-menu-save-close").addEventListener("click", async () => {
  if (await saveSiteMenu()) siteMenuPanel.style.display = "none";
});

document.getElementById("site-menu-close").addEventListener("click", () => {
  siteMenuPanel.style.display = "none";
});

wirePanelKeys(siteMenuPanel, "site-menu-save-close", "site-menu-close");
wirePanelKeys(createPanel, "site-menu-create-confirm", "site-menu-create-cancel");
