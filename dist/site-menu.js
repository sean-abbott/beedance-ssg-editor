// Site menu editor: view/add/remove/reorder the site's main navigation,
// backed by config.toml's [[extra.menu]] (get_site_menu/set_site_menu in
// menu.rs) - the same {name, url} shape the bundled sample site's Abridge
// theme already reads natively, so this same editor works whether or not
// the site's actual theme happens to be Abridge.

import { wirePanelKeys, showError } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const siteMenuPanel = document.getElementById("site-menu-panel");
const siteMenuList = document.getElementById("site-menu-list");
const siteMenuStatus = document.getElementById("site-menu-status");

// {name, kind: "page"|"external", pageUrl, externalUrl} per row - kind/
// pageUrl/externalUrl are split apart so switching the dropdown back and
// forth doesn't lose whatever was typed into the other one.
let rows = [];
// {path, label} for every content file (not templates) - populates each
// row's "existing page" dropdown.
let linkablePages = [];

const zolaUrlForPage = (path) => "@/" + path.replace(/^content\//, "");

const renderSiteMenuList = () => {
  siteMenuList.innerHTML = "";
  rows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "menu-entry-row";

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

    const applyKindVisibility = () => {
      pageSelect.style.display = kindSelect.value === "page" ? "" : "none";
      urlInput.style.display = kindSelect.value === "external" ? "" : "none";
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

    el.append(up, down, nameInput, kindSelect, pageSelect, urlInput, remove);
    siteMenuList.appendChild(el);
  });
};

document.getElementById("site-menu-button").addEventListener("click", async () => {
  siteMenuStatus.textContent = "";
  try {
    const [entries, files] = await Promise.all([invoke("get_site_menu"), invoke("list_editable_files_detailed")]);
    linkablePages = files
      .filter((f) => f.group !== "Templates")
      .map((f) => ({ path: f.path, label: `${f.label} (${f.group})` }));

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

document.getElementById("site-menu-save").addEventListener("click", async () => {
  const entries = [];
  for (const row of rows) {
    const name = row.name.trim();
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
