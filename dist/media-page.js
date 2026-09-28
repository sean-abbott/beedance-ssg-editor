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

import { askConfirm, currentSiteDir, reviewModeActive, showError } from "./editor-core.js";
import { makeIcon } from "./icons.js";

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

let allImages = []; // {key, filename, source, width, height, sizeBytes, contentRefs, templateRefs}
let r2PublicUrlBase = "";
let sourceFilter = "all";
let unusedOnly = false;
let mediaLoaded = false;
const selectedKeys = new Set();

const isUnused = (img) => img.contentRefs.length === 0 && img.templateRefs.length === 0;
const isProtected = (img) => img.templateRefs.length > 0;

const formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const viewImage = (img) => {
  const url =
    img.source === "r2" && r2PublicUrlBase
      ? `${r2PublicUrlBase.replace(/\/+$/, "")}/${img.key}`
      : `file://${currentSiteDir}/static/${img.key}`;
  window.__TAURI__.shell.open(url).catch((err) => showError(err));
};

const deleteImage = async (img) => {
  if (img.source === "r2") {
    await invoke("delete_r2_shared_image", { key: img.key });
  } else {
    await invoke("delete_local_shared_image", { filename: img.filename });
  }
};

const updateSelectionBar = () => {
  const count = selectedKeys.size;
  actionBar.classList.toggle("visible", count > 0);
  selectionCountEl.textContent = `${count} unused selected`;
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

  grid.innerHTML = "";
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px; color: var(--muted); font-size: 13px;";
    empty.textContent = allImages.length === 0 ? "No shared images yet." : "Nothing matches that filter.";
    grid.appendChild(empty);
    return;
  }

  for (const img of visible) {
    const card = document.createElement("div");
    card.className = "media-card";

    const thumb = document.createElement("div");
    thumb.className = "media-thumb";
    const thumbIcon = makeIcon("image");
    thumbIcon.style.width = "28px";
    thumbIcon.style.height = "28px";
    thumbIcon.style.color = "var(--muted)";
    thumb.appendChild(thumbIcon);
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
    badge.className = "media-source-badge" + (img.source === "r2" ? " r2" : "");
    badge.textContent = img.source === "r2" ? "R2" : "Local";
    meta.appendChild(badge);
    const dims = document.createElement("span");
    const dimsText = img.width && img.height ? `${img.width}×${img.height} · ` : "";
    dims.textContent = `${dimsText}${formatBytes(img.sizeBytes)}`;
    meta.appendChild(dims);
    body.appendChild(meta);

    if (isProtected(img)) {
      const req = document.createElement("span");
      req.className = "tag-manage-protected-badge";
      req.style.marginTop = "2px";
      req.title = `Referenced by name in ${img.templateRefs.join(", ")} - every page using that template needs this exact image, not just one post.`;
      req.appendChild(makeIcon("lock"));
      req.appendChild(document.createTextNode("Required"));
      body.appendChild(req);
    } else if (isUnused(img)) {
      const usage = document.createElement("span");
      usage.className = "media-usage unused";
      usage.textContent = "Unused";
      body.appendChild(usage);
    } else {
      const usage = document.createElement("span");
      usage.className = "media-usage";
      usage.title = img.contentRefs.join(", ");
      usage.textContent = `Used on ${img.contentRefs.length} page${img.contentRefs.length === 1 ? "" : "s"}`;
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

    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary btn-icon danger";
    const blocked = !isUnused(img) || isReviewing;
    del.disabled = blocked;
    del.title = isProtected(img)
      ? "Can't delete - required by a template"
      : blocked
        ? `Used on ${img.contentRefs.length} page${img.contentRefs.length === 1 ? "" : "s"} - remove those references first`
        : "Delete this image";
    del.appendChild(makeIcon("trash"));
    del.addEventListener("click", async () => {
      const proceed = await askConfirm("Delete this image?", `Delete "${img.filename}"? This can't be undone.`, "Delete");
      if (!proceed) return;
      try {
        await deleteImage(img);
        await loadMedia();
      } catch (err) {
        showError(err);
      }
    });
    actions.appendChild(del);

    card.appendChild(actions);
    grid.appendChild(card);
  }
};

const loadMedia = async () => {
  statusEl.textContent = "Loading...";
  try {
    const [local, r2, usage, r2Site] = await Promise.all([
      invoke("list_local_shared_images"),
      invoke("list_r2_images"),
      invoke("scan_image_usage"),
      invoke("get_r2_site_config"),
    ]);
    r2PublicUrlBase = r2Site.publicUrlBase || "";
    allImages = [...local, ...r2].map((img) => {
      const u = usage[img.key] || { contentRefs: [], templateRefs: [] };
      return { ...img, contentRefs: u.contentRefs, templateRefs: u.templateRefs };
    });
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
