// Site menu editor: view/add/remove/reorder the site's main navigation,
// backed by config.toml's [[extra.menu]] (get_site_menu/set_site_menu in
// menu.rs) - the same {name, url} shape the bundled sample site's Abridge
// theme already reads natively, so this same editor works whether or not
// the site's actual theme happens to be Abridge.

import { wirePanelKeys, showError, nowForZola, currentAuthorName } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const siteMenuPanel = document.getElementById("site-menu-panel");
const siteMenuList = document.getElementById("site-menu-list");
const siteMenuStatus = document.getElementById("site-menu-status");

// {name, kind, pageUrl, externalUrl, newTitle, newSection} per row - the
// per-kind fields (pageUrl/externalUrl/newTitle/newSection) are all kept
// side by side rather than a single "value" so switching the kind dropdown
// back and forth never loses whatever was already typed/chosen in the
// others.
let rows = [];
// {path, label} for every content file (not templates) - populates each
// row's "existing page" dropdown.
let linkablePages = [];
// {slug, title} for every top-level section - populates "New page..."'s
// own parent-section dropdown (same source create_page's own dialog uses).
let sections = [];

const zolaUrlForPage = (path) => "@/" + path.replace(/^content\//, "");

// Re-fetched (rather than hand-synthesized) after creating a page/section,
// so a freshly created entry's label/group matches exactly what a real
// panel-open would show - no risk of this JS drifting from site.rs's own
// group/label logic.
const refreshPagesAndSections = async () => {
  const [files, sectionList] = await Promise.all([invoke("list_editable_files_detailed"), invoke("list_page_sections")]);
  linkablePages = files.filter((f) => f.group !== "Templates").map((f) => ({ path: f.path, label: `${f.label} (${f.group})` }));
  sections = sectionList;
};

const renderSiteMenuList = () => {
  siteMenuList.innerHTML = "";
  rows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "menu-entry-row";
    el.style.flexWrap = "wrap";

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

    const pageSelect = document.createElement("select");
    pageSelect.className = "menu-entry-page";
    for (const page of linkablePages) {
      const opt = document.createElement("option");
      opt.value = zolaUrlForPage(page.path);
      opt.textContent = page.label;
      pageSelect.appendChild(opt);
    }
    pageSelect.value = row.pageUrl;
    pageSelect.addEventListener("change", () => {
      row.pageUrl = pageSelect.value;
    });

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "menu-entry-url";
    urlInput.placeholder = "https://...";
    urlInput.value = row.externalUrl;
    urlInput.addEventListener("input", () => {
      row.externalUrl = urlInput.value;
    });

    // "New page..." - a title plus a parent section (create_page's own
    // dialog offers the same choice), created immediately on its own
    // "Create" click rather than deferred to the panel's overall Save, so a
    // duplicate-title/empty-section error surfaces right where it happened
    // instead of after everything else in the panel already looked saved.
    const newPageWrap = document.createElement("span");
    newPageWrap.style.cssText = "display: flex; gap: 4px; flex: 1; min-width: 0;";
    const newPageTitle = document.createElement("input");
    newPageTitle.type = "text";
    newPageTitle.placeholder = "New page title";
    newPageTitle.style.flex = "1";
    newPageTitle.value = row.newTitle;
    newPageTitle.addEventListener("input", () => {
      row.newTitle = newPageTitle.value;
    });
    const newPageSection = document.createElement("select");
    for (const s of sections) {
      const opt = document.createElement("option");
      opt.value = s.slug;
      opt.textContent = s.title;
      newPageSection.appendChild(opt);
    }
    if (row.newSection) newPageSection.value = row.newSection;
    newPageSection.addEventListener("change", () => {
      row.newSection = newPageSection.value;
    });
    const newPageCreate = document.createElement("button");
    newPageCreate.type = "button";
    newPageCreate.className = "secondary";
    newPageCreate.textContent = "Create";
    newPageCreate.addEventListener("click", async () => {
      const title = newPageTitle.value.trim();
      if (!title) {
        siteMenuStatus.textContent = "Enter a title for the new page first.";
        return;
      }
      if (!newPageSection.value) {
        siteMenuStatus.textContent = "This site has no existing sections to add a page to yet - create a section first.";
        return;
      }
      siteMenuStatus.textContent = "Creating page...";
      try {
        const path = await invoke("create_page", {
          title,
          section: newPageSection.value,
          datetime: nowForZola(),
          author: currentAuthorName,
        });
        await refreshPagesAndSections();
        row.kind = "page";
        row.pageUrl = zolaUrlForPage(path);
        if (!row.name.trim()) row.name = title;
        siteMenuStatus.textContent = "";
        renderSiteMenuList();
      } catch (err) {
        siteMenuStatus.textContent = "";
        showError(err);
      }
    });
    newPageWrap.append(newPageTitle, newPageSection, newPageCreate);

    // "New section..." - a brand-new top-level section (its own
    // content/<slug>/_index.md), a sibling of About/Biodiversity/etc.
    const newSectionWrap = document.createElement("span");
    newSectionWrap.style.cssText = "display: flex; gap: 4px; flex: 1; min-width: 0;";
    const newSectionTitle = document.createElement("input");
    newSectionTitle.type = "text";
    newSectionTitle.placeholder = "New section title";
    newSectionTitle.style.flex = "1";
    newSectionTitle.value = row.newTitle;
    newSectionTitle.addEventListener("input", () => {
      row.newTitle = newSectionTitle.value;
    });
    const newSectionCreate = document.createElement("button");
    newSectionCreate.type = "button";
    newSectionCreate.className = "secondary";
    newSectionCreate.textContent = "Create";
    newSectionCreate.addEventListener("click", async () => {
      const title = newSectionTitle.value.trim();
      if (!title) {
        siteMenuStatus.textContent = "Enter a title for the new section first.";
        return;
      }
      siteMenuStatus.textContent = "Creating section...";
      try {
        const path = await invoke("create_section", { title, author: currentAuthorName });
        await refreshPagesAndSections();
        row.kind = "page";
        row.pageUrl = zolaUrlForPage(path);
        if (!row.name.trim()) row.name = title;
        siteMenuStatus.textContent = "";
        renderSiteMenuList();
      } catch (err) {
        siteMenuStatus.textContent = "";
        showError(err);
      }
    });
    newSectionWrap.append(newSectionTitle, newSectionCreate);

    const applyKindVisibility = () => {
      pageSelect.style.display = kindSelect.value === "page" ? "" : "none";
      urlInput.style.display = kindSelect.value === "external" ? "" : "none";
      newPageWrap.style.display = kindSelect.value === "new-page" ? "flex" : "none";
      newSectionWrap.style.display = kindSelect.value === "new-section" ? "flex" : "none";
    };
    applyKindVisibility();
    kindSelect.addEventListener("change", () => {
      row.kind = kindSelect.value;
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

    el.append(up, down, nameInput, kindSelect, pageSelect, urlInput, newPageWrap, newSectionWrap, remove);
    siteMenuList.appendChild(el);
  });
};

document.getElementById("site-menu-button").addEventListener("click", async () => {
  siteMenuStatus.textContent = "";
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
        newTitle: "",
        newSection: "",
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
    newTitle: "",
    newSection: "",
  });
  renderSiteMenuList();
});

document.getElementById("site-menu-save").addEventListener("click", async () => {
  const entries = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (row.kind === "new-page" || row.kind === "new-section") {
      siteMenuStatus.textContent = 'Finish creating every "New page"/"New section" entry (or remove it) before saving.';
      return;
    }
    const url = row.kind === "external" ? row.externalUrl.trim() : row.pageUrl;
    if (!name || !url) {
      siteMenuStatus.textContent = "Every link needs a label and a destination.";
      return;
    }
    entries.push({ name, url });
  }
  siteMenuStatus.textContent = "Saving...";
  try {
    await invoke("set_site_menu", { entries });
    siteMenuStatus.textContent = "Saved.";
  } catch (err) {
    siteMenuStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("site-menu-close").addEventListener("click", () => {
  siteMenuPanel.style.display = "none";
});

wirePanelKeys(siteMenuPanel, "site-menu-save", "site-menu-close");
