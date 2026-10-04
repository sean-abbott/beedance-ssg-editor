// Media library (pws-ply7): browsing/deleting SHARED images only (static/
// images/ locally, and R2) - a page-bundle image ("with this page only")
// is out of scope, see the page's own description text. A full app-main
// page (see menus.js's showAppMainPage), reached from the sidebar's
// "Media" nav item.
//
// No general multi-select framework here on purpose - "Select all unused"
// is a single binary toggle (every currently-unused image, or none); which
// of those actually get deleted is decided in the "Review & delete"
// checklist that follows, not with per-card checkboxes on the grid itself.

import { askConfirm, currentSiteDir, reviewModeActive, showError, wirePanelKeys } from "./editor-core.js";
import { makeIcon } from "./icons.js";
import { showAppMainPage } from "./menus.js";

const { invoke } = window.__TAURI__.core;

const grid = document.getElementById("media-page-grid");
const statusEl = document.getElementById("media-page-status");
const sourceFilterEl = document.getElementById("media-page-source-filter");
const unusedToggle = document.getElementById("media-page-unused-toggle");
const nameFilterInput = document.getElementById("media-page-filter-name");
const selectAllCheckbox = document.getElementById("media-select-all");
const selectAllLabel = document.getElementById("media-select-all-label");
const actionBar = document.getElementById("media-action-bar");
const selectionCountEl = document.getElementById("media-selection-count");

const reviewPanel = document.getElementById("media-delete-review-panel");
const reviewTitle = document.getElementById("media-delete-review-title");
const reviewList = document.getElementById("media-delete-review-list");
const reviewStatus = document.getElementById("media-delete-review-status");

const renamePanel = document.getElementById("media-rename-panel");
const renameTitle = document.getElementById("media-rename-title");
const renameInput = document.getElementById("media-rename-input");
const renameDescription = document.getElementById("media-rename-description");
const renameStatus = document.getElementById("media-rename-status");

const altTextPanel = document.getElementById("media-alt-text-panel");
const altTextTitle = document.getElementById("media-alt-text-title");
const altTextList = document.getElementById("media-alt-text-list");
const altTextStatus = document.getElementById("media-alt-text-status");

let allImages = []; // {key, filename, source, width, height, sizeBytes, contentRefs, templateRefs}
let r2PublicUrlBase = "";
let sourceFilter = "all";
let unusedOnly = false;
let mediaLoaded = false;
const selectedKeys = new Set();

const isUnused = (img) => img.contentRefs.length === 0 && img.templateRefs.length === 0;
// A template reference can't be safely auto-edited the way a content file
// can (rewrite_image_references only touches content files) - Rename and
// Move are blocked ONLY by this, a materially narrower rule than Delete's
// "any reference at all" (content references get rewritten automatically
// as part of the operation, so they're not a blocker for those two).
const isProtected = (img) => img.templateRefs.length > 0;

const sourceLabel = (source) => (source === "r2" ? "R2" : source === "external" ? "External" : "Local");

const formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// Mirrors media.rs's own filename_from_url exactly (last path segment,
// query/fragment stripped) - purely for display here, the real filename
// this ends up saved as is still decided server-side by that same logic
// when localize_external_image actually runs.
const filenameFromUrl = (url) => {
  const withoutQuery = url.split(/[?#]/)[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  return segments[segments.length - 1] || url;
};

const viewImage = (img) => {
  const url =
    img.source === "external"
      ? img.key
      : img.source === "r2" && r2PublicUrlBase
        ? `${r2PublicUrlBase.replace(/\/+$/, "")}/${img.key}`
        : `file://${currentSiteDir}/static/${img.key}`;
  window.__TAURI__.shell.open(url).catch((err) => showError(err));
};

const doLocalize = async (img) => {
  const proceed = await askConfirm(
    "Localize this image?",
    `Download "${img.filename}" and store it here instead of relying on the outside link? Every content reference updates automatically.`,
    "Localize"
  );
  if (!proceed) return;
  try {
    const tier = await invoke("get_tier_settings");
    await invoke("localize_external_image", { url: img.key, tier });
    await loadMedia();
  } catch (err) {
    showError(err);
  }
};

const deleteImage = async (img) => {
  if (img.source === "r2") {
    await invoke("delete_r2_shared_image", { key: img.key });
  } else {
    await invoke("delete_local_shared_image", { key: img.key });
  }
};

const updateSelectionBar = () => {
  const count = selectedKeys.size;
  actionBar.classList.toggle("visible", count > 0);
  selectionCountEl.textContent = `${count} unused selected`;
};

const doDelete = async (img) => {
  const proceed = await askConfirm("Delete this image?", `Delete "${img.filename}"? This can't be undone.`, "Delete");
  if (!proceed) return;
  try {
    await deleteImage(img);
    await loadMedia();
  } catch (err) {
    showError(err);
  }
};

const openRenamePanel = (img) => {
  renameTitle.textContent = `Rename ${img.filename}`;
  renameInput.value = img.filename;
  renameDescription.textContent = isUnused(img)
    ? "Updates the file itself. Nothing else references it yet."
    : `Updates the file itself and every content reference to it - ${img.contentRefs.length} ` +
      `page${img.contentRefs.length === 1 ? "" : "s"} (${img.contentRefs.join(", ")}).`;
  renameStatus.textContent = "";
  renamePanel.style.display = "flex";
  renamePanel.dataset.key = img.key;
  renamePanel.dataset.source = img.source;
  renameInput.focus();
  renameInput.select();
};

const doMove = async (img) => {
  const targetLabel = img.source === "r2" ? "Local" : "R2";
  const proceed = await askConfirm(
    `Move to ${targetLabel}?`,
    `Move "${img.filename}" to ${targetLabel} storage? Every content reference to it updates automatically.`,
    "Move"
  );
  if (!proceed) return;
  try {
    await invoke("move_shared_image", { oldKey: img.key, source: img.source });
    await loadMedia();
  } catch (err) {
    showError(err);
  }
};

const openAltTextPanel = async (img) => {
  altTextTitle.textContent = `Alt text — ${img.filename}`;
  altTextStatus.textContent = "Loading...";
  altTextList.innerHTML = "";
  altTextPanel.style.display = "flex";
  altTextPanel.dataset.key = img.key;
  altTextPanel.dataset.source = img.source;
  try {
    const usages = await invoke("list_image_alt_text_usages", { key: img.key, source: img.source });
    altTextStatus.textContent = "";
    for (const usage of usages) {
      const card = document.createElement("div");
      card.className = "card";
      card.style.marginBottom = "var(--space-3)";
      const header = document.createElement("div");
      header.className = "card-header";
      const h4 = document.createElement("h4");
      h4.style.fontSize = "var(--text-sm)";
      h4.textContent = usage.contentFile;
      header.appendChild(h4);
      card.appendChild(header);
      const input = document.createElement("input");
      input.type = "text";
      input.style.width = "100%";
      input.value = usage.alt;
      input.placeholder = "Describe the image for screen readers";
      input.dataset.contentFile = usage.contentFile;
      card.appendChild(input);
      altTextList.appendChild(card);
    }
  } catch (err) {
    altTextStatus.textContent = "";
    showError(err);
  }
};

// A single .menu (see menus.js's delegated open/close) per card, built
// fresh on every render - Rename/Edit alt text/Move behind it rather than
// more persistent icon buttons alongside View, so the card doesn't get
// button-cluttered as capabilities grow (Delete moved in here too, out of
// its old spot next to View).
const buildOverflowMenu = (img, isReviewing) => {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.style.marginLeft = "auto";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary btn-icon";
  toggle.title = "More actions";
  toggle.appendChild(makeIcon("kebab"));
  menu.appendChild(toggle);

  const dropdown = document.createElement("div");
  dropdown.className = "menu-dropdown";

  const addItem = (icon, label, disabled, title, onClick, danger) => {
    const btn = document.createElement("button");
    btn.type = "button";
    if (disabled) btn.className = "menu-item-muted";
    else if (danger) btn.style.color = "var(--danger)";
    btn.disabled = disabled;
    if (title) btn.title = title;
    btn.appendChild(makeIcon(icon));
    btn.appendChild(document.createTextNode(label));
    if (!disabled) btn.addEventListener("click", onClick);
    dropdown.appendChild(btn);
    return btn;
  };

  // Rename/Move are only blocked by a TEMPLATE reference - unlike Delete,
  // a content-file reference isn't a blocker for these two, since it gets
  // rewritten automatically as part of the operation (see
  // rewrite_image_references on the Rust side).
  const blockedByTemplate = isProtected(img) || isReviewing;
  const templateNames = img.templateRefs.join(", ");
  addItem(
    "pencil",
    "Rename…",
    blockedByTemplate,
    isProtected(img)
      ? `Can't rename here - required by ${templateNames} (edit that template directly to change this)`
      : "Rename",
    () => openRenamePanel(img)
  );

  const altBlocked = isProtected(img) || img.contentRefs.length === 0 || isReviewing;
  addItem(
    "tag",
    "Edit alt text…",
    altBlocked,
    isProtected(img)
      ? `Set in ${templateNames} directly, not here`
      : img.contentRefs.length === 0
        ? "Not used anywhere yet - insert it into a page first"
        : "Edit alt text",
    () => openAltTextPanel(img)
  );

  addItem(
    "external-link",
    img.source === "r2" ? "Move to Local…" : "Move to R2…",
    blockedByTemplate,
    isProtected(img)
      ? `Can't move here - required by ${templateNames} (edit that template directly to change this)`
      : "Move",
    () => doMove(img)
  );

  const divider = document.createElement("div");
  divider.className = "menu-divider";
  dropdown.appendChild(divider);

  // Delete is blocked by ANY reference at all, content or template - the
  // materially broader rule, since there's nothing to rewrite a delete to.
  const deleteBlocked = !isUnused(img) || isReviewing;
  addItem(
    "trash",
    "Delete",
    deleteBlocked,
    isProtected(img)
      ? `Can't delete here - required by ${templateNames} (edit that template directly to change this)`
      : deleteBlocked
        ? `Used on ${img.contentRefs.length} page${img.contentRefs.length === 1 ? "" : "s"} - remove those references first`
        : "Delete this image",
    () => doDelete(img),
    true
  );

  menu.appendChild(dropdown);
  return menu;
};

const render = () => {
  const query = nameFilterInput.value.trim().toLowerCase();
  const visible = allImages.filter((img) => {
    if (sourceFilter !== "all" && img.source !== sourceFilter) return false;
    if (unusedOnly && !isUnused(img)) return false;
    if (query && !img.filename.toLowerCase().includes(query)) return false;
    return true;
  });

  const isReviewing = reviewModeActive != null;
  const unusedCount = allImages.filter(isUnused).length;
  selectAllLabel.textContent = `Select all unused (${unusedCount})`;
  selectAllCheckbox.disabled = unusedCount === 0 || isReviewing;
  document.getElementById("media-review-delete").disabled = isReviewing;

  const externalCount = allImages.filter((img) => img.source === "external").length;
  const localizeAllButton = document.getElementById("media-localize-all");
  localizeAllButton.style.display = sourceFilter === "external" && externalCount > 0 ? "" : "none";
  localizeAllButton.textContent = `Localize all (${externalCount})…`;
  localizeAllButton.disabled = isReviewing;

  grid.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px; color: var(--muted); font-size: 13px;";
    // Names exactly which active filters produced the empty result,
    // rather than a single generic message for every cause - "0 local
    // images found on disk" and "3 local images exist but none match
    // 'Unused only'" look identical otherwise, and telling those apart is
    // the whole question when a filter appears to be hiding something
    // that's known to exist.
    if (allImages.length === 0) {
      empty.textContent = "No shared images found under static/ at all.";
    } else if (sourceFilter !== "all" && allImages.every((img) => img.source !== sourceFilter)) {
      empty.textContent = `No ${sourceLabel(sourceFilter)} images found (${allImages.length} total from other sources).`;
    } else {
      const activeFilters = [];
      if (sourceFilter !== "all") activeFilters.push(sourceLabel(sourceFilter));
      if (unusedOnly) activeFilters.push("Unused only");
      if (query) activeFilters.push(`filename contains "${query}"`);
      empty.textContent =
        activeFilters.length > 0 ? `No images match: ${activeFilters.join(", ")}.` : "Nothing matches that filter.";
    }
    grid.appendChild(empty);
    return;
  }

  for (const img of visible) {
    const card = document.createElement("div");
    card.className = "media-card";

    const thumb = document.createElement("div");
    thumb.className = "media-thumb";
    if (img.source === "external") {
      // Already a real, directly-fetchable URL - no round trip needed at
      // all, unlike Local (see read_image_preview's own reasoning below).
      const el = document.createElement("img");
      el.src = img.key;
      el.alt = "";
      el.loading = "lazy";
      thumb.appendChild(el);
    } else if (img.source === "r2") {
      // The bucket's own public URL directly - simplest thing that works
      // today (no extra IPC round trip). Revisit with a resized thumbnail
      // only if loading a whole grid of full-size R2 objects turns out to
      // actually be slow in practice.
      const el = document.createElement("img");
      el.src = r2PublicUrlBase ? `${r2PublicUrlBase.replace(/\/+$/, "")}/${img.key}` : "";
      el.alt = "";
      el.loading = "lazy";
      thumb.appendChild(el);
    } else {
      // A plain file:// src isn't reliably usable from this webview (see
      // read_image_preview's own doc comment) - fetched as a data: URL
      // instead, per card, lazily as each one renders.
      const el = document.createElement("img");
      el.alt = "";
      el.loading = "lazy";
      thumb.appendChild(el);
      invoke("read_image_preview", { path: `${currentSiteDir}/static/${img.key}` })
        .then((dataUrl) => {
          el.src = dataUrl;
        })
        .catch(() => {
          thumb.innerHTML = "";
          const fallback = makeIcon("image");
          fallback.style.width = "28px";
          fallback.style.height = "28px";
          fallback.style.color = "var(--muted)";
          thumb.appendChild(fallback);
        });
    }
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "media-body";

    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = img.filename;
    body.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "media-meta-row";
    const badge = document.createElement("span");
    badge.className = "media-source-badge" + (img.source === "r2" || img.source === "external" ? " r2" : "");
    badge.textContent = sourceLabel(img.source);
    meta.appendChild(badge);
    if (img.source !== "external") {
      const dims = document.createElement("span");
      const dimsText = img.width && img.height ? `${img.width}×${img.height} · ` : "";
      dims.textContent = `${dimsText}${formatBytes(img.sizeBytes)}`;
      meta.appendChild(dims);
    }
    body.appendChild(meta);

    if (isProtected(img)) {
      const req = document.createElement("span");
      req.className = "tag-manage-protected-badge";
      req.style.marginTop = "2px";
      req.title =
        `Referenced by name in ${img.templateRefs.join(", ")} - every page using that template needs this ` +
        `exact image, not just one post. Templates aren't editable in this app - open that file in a code ` +
        `editor (e.g. VS Code) to change it; these actions just won't rewrite it for you.`;
      req.appendChild(makeIcon("lock"));
      req.appendChild(document.createTextNode("Required"));
      body.appendChild(req);
    } else if (isUnused(img)) {
      const usage = document.createElement("span");
      usage.className = "media-usage unused";
      usage.textContent = "Unused";
      body.appendChild(usage);
    } else {
      // A link to the Pages page, pre-filtered to exactly these referencing
      // pages - a different filter dimension than the tag combobox (Pages
      // page shows this as its own "filter-context-banner", not a tag
      // filter), same pattern as the Tags page's "N posts" click-through.
      const usage = document.createElement("button");
      usage.type = "button";
      usage.className = "media-usage";
      usage.title = `${img.contentRefs.join(", ")} - click to see these pages`;
      usage.textContent = `Used on ${img.contentRefs.length} page${img.contentRefs.length === 1 ? "" : "s"}`;
      usage.addEventListener("click", () => showAppMainPage("pages", { paths: img.contentRefs, image: img.filename }));
      body.appendChild(usage);
    }

    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "media-actions";

    const view = document.createElement("button");
    view.type = "button";
    view.className = "secondary btn-icon";
    view.title = "View full size";
    view.appendChild(makeIcon("external-link"));
    view.addEventListener("click", () => viewImage(img));
    actions.appendChild(view);

    if (img.source === "external") {
      // No Rename/Move/Alt-text/Delete for these - there's no local file
      // yet to act on, only one meaningful action until there is one.
      const localize = document.createElement("button");
      localize.type = "button";
      localize.className = "secondary";
      localize.style.marginLeft = "auto";
      localize.disabled = isReviewing;
      localize.textContent = "Localize…";
      localize.addEventListener("click", () => doLocalize(img));
      actions.appendChild(localize);
    } else {
      actions.appendChild(buildOverflowMenu(img, isReviewing));
    }

    card.appendChild(actions);
    grid.appendChild(card);
  }
};

const loadMedia = async () => {
  statusEl.textContent = "Loading...";
  try {
    const [local, r2, usage, r2Site, external] = await Promise.all([
      invoke("list_local_shared_images"),
      invoke("list_r2_images"),
      invoke("scan_image_usage"),
      invoke("get_r2_site_config"),
      invoke("scan_external_image_references"),
    ]);
    r2PublicUrlBase = r2Site.publicUrlBase || "";
    const owned = [...local, ...r2].map((img) => {
      const u = usage[img.key] || { contentRefs: [], templateRefs: [] };
      return { ...img, contentRefs: u.contentRefs, templateRefs: u.templateRefs };
    });
    // External refs never come from usage (that map only covers images
    // this site already owns a copy of) - contentRefs comes straight from
    // scan_external_image_references itself, which found them by their
    // content-file reference in the first place, so it's never empty.
    const externalImages = external.map((ref) => ({
      key: ref.url,
      filename: filenameFromUrl(ref.url),
      source: "external",
      width: null,
      height: null,
      sizeBytes: null,
      contentRefs: ref.contentRefs,
      templateRefs: [],
    }));
    allImages = [...owned, ...externalImages];
    // Drop anything no longer present from the current selection (e.g. it
    // was deleted individually while a bulk selection was still pending).
    for (const key of [...selectedKeys]) {
      if (!allImages.some((img) => img.key === key)) selectedKeys.delete(key);
    }
    statusEl.textContent = "";
    render();
    updateSelectionBar();
  } catch (err) {
    statusEl.textContent = "";
    showError(err);
  }
};

sourceFilterEl.querySelectorAll("button[data-source]").forEach((btn) => {
  btn.addEventListener("click", () => {
    sourceFilter = btn.dataset.source;
    sourceFilterEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
});

unusedToggle.addEventListener("click", () => {
  unusedOnly = !unusedOnly;
  unusedToggle.classList.toggle("active", unusedOnly);
  render();
});

nameFilterInput.addEventListener("input", render);

selectAllCheckbox.addEventListener("change", () => {
  selectedKeys.clear();
  if (selectAllCheckbox.checked) {
    for (const img of allImages) if (isUnused(img)) selectedKeys.add(img.key);
  }
  updateSelectionBar();
});

document.getElementById("media-clear-selection").addEventListener("click", () => {
  selectedKeys.clear();
  selectAllCheckbox.checked = false;
  updateSelectionBar();
});

document.getElementById("media-localize-all").addEventListener("click", async () => {
  const externalImages = allImages.filter((img) => img.source === "external");
  if (externalImages.length === 0) return;
  // No review checklist here the way bulk Delete has one - localizing
  // isn't destructive the same way (nothing is lost, only where it's
  // stored changes), so the lighter-weight confirm this app already uses
  // for a single Localize is enough for all of them together too.
  const proceed = await askConfirm(
    "Localize all external images?",
    `Download and store all ${externalImages.length} externally-hosted images found in your content? Every reference updates automatically.`,
    "Localize all"
  );
  if (!proceed) return;
  statusEl.textContent = `Localizing 0 of ${externalImages.length}...`;
  let done = 0;
  let failed = 0;
  const tier = await invoke("get_tier_settings");
  for (const img of externalImages) {
    try {
      await invoke("localize_external_image", { url: img.key, tier });
    } catch {
      failed += 1;
    }
    done += 1;
    statusEl.textContent = `Localizing ${done} of ${externalImages.length}...`;
  }
  await loadMedia();
  statusEl.textContent = failed > 0 ? `${failed} of ${externalImages.length} couldn't be localized.` : "";
});

document.getElementById("media-review-delete").addEventListener("click", () => {
  const selected = allImages.filter((img) => selectedKeys.has(img.key));
  reviewTitle.textContent = `Delete ${selected.length} unused image${selected.length === 1 ? "" : "s"}?`;
  reviewStatus.textContent = "";
  reviewList.innerHTML = "";
  for (const img of selected) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.key = img.key;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(img.filename));
    const meta = document.createElement("span");
    meta.style.cssText = "color: var(--muted); margin-left: auto;";
    meta.textContent = `${img.source === "r2" ? "R2" : "Local"} · ${formatBytes(img.sizeBytes)}`;
    label.appendChild(meta);
    reviewList.appendChild(label);
  }
  reviewPanel.style.display = "flex";
});

document.getElementById("media-delete-review-cancel").addEventListener("click", () => {
  reviewPanel.style.display = "none";
});

document.getElementById("media-delete-review-confirm").addEventListener("click", async () => {
  const checkedKeys = Array.from(reviewList.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.dataset.key);
  if (checkedKeys.length === 0) {
    reviewPanel.style.display = "none";
    return;
  }
  reviewStatus.textContent = "Deleting...";
  const toDelete = allImages.filter((img) => checkedKeys.includes(img.key));
  let failed = 0;
  for (const img of toDelete) {
    try {
      await deleteImage(img);
    } catch {
      failed += 1;
    }
  }
  selectedKeys.clear();
  selectAllCheckbox.checked = false;
  reviewPanel.style.display = "none";
  await loadMedia();
  if (failed > 0) {
    statusEl.textContent = `${failed} of ${toDelete.length} couldn't be deleted.`;
  }
});

document.getElementById("media-rename-cancel").addEventListener("click", () => {
  renamePanel.style.display = "none";
});

document.getElementById("media-rename-confirm").addEventListener("click", async () => {
  const newFilename = renameInput.value.trim();
  if (!newFilename) {
    renameStatus.textContent = "Enter a filename first.";
    return;
  }
  renameStatus.textContent = "Renaming...";
  try {
    await invoke("rename_shared_image", {
      oldKey: renamePanel.dataset.key,
      source: renamePanel.dataset.source,
      newFilename,
    });
    renamePanel.style.display = "none";
    await loadMedia();
  } catch (err) {
    renameStatus.textContent = "";
    showError(err);
  }
});

document.getElementById("media-alt-text-close").addEventListener("click", () => {
  altTextPanel.style.display = "none";
});

document.getElementById("media-alt-text-save").addEventListener("click", async () => {
  const key = altTextPanel.dataset.key;
  const source = altTextPanel.dataset.source;
  altTextStatus.textContent = "Saving...";
  let failed = 0;
  for (const input of altTextList.querySelectorAll("input[data-content-file]")) {
    try {
      await invoke("set_image_alt_text", {
        contentFile: input.dataset.contentFile,
        key,
        source,
        newAlt: input.value,
      });
    } catch {
      failed += 1;
    }
  }
  altTextPanel.style.display = "none";
  if (failed > 0) showError(`${failed} usage${failed === 1 ? "" : "s"} couldn't be saved.`);
});

document.addEventListener("beedance:page-changed", (e) => {
  if (e.detail.page === "media" && !mediaLoaded) {
    mediaLoaded = true;
    loadMedia();
  }
});
// Review mode can toggle while the Media page happens to already be open -
// re-render so every card's Delete button (and the bulk-select controls)
// pick up the disabled state immediately.
document.addEventListener("beedance:tab-changed", () => {
  if (mediaLoaded && document.getElementById("media-page").style.display !== "none") render();
});

wirePanelKeys(reviewPanel, "media-delete-review-confirm", "media-delete-review-cancel");
wirePanelKeys(renamePanel, "media-rename-confirm", "media-rename-cancel");
wirePanelKeys(altTextPanel, "media-alt-text-save", "media-alt-text-close");
