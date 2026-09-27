// Image insert (file picker + drag/drop), insert-by-URL, the contextual
// alignment toolbar, resize, and localize - everything to do with images in
// content, per pws-zg1h's module split.

import {
  editorEl,
  fileSelect,
  tabs,
  activeTab,
  setActiveTab,
  renderTabBar,
  refreshFileList,
  withActiveTab,
  wirePanelKeys,
  emitEdited,
  currentSiteDir,
} from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

// Inserts plain text at the cursor without wrapping a selection - used for
// splicing in the final image markdown.
const insertAtCursor = (text) => {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const value = editorEl.value;
  editorEl.value = value.slice(0, start) + text + value.slice(end);
  editorEl.focus();
  const pos = start + text.length;
  editorEl.setSelectionRange(pos, pos);
  emitEdited();
};

// Image insert flow: a file path (from the picker or a drag/drop) opens
// this panel for size/placement/alt-text choice before anything is
// written to disk. The actual normalize+store work happens in the Rust
// insert_image command - this is just the picker/preview/confirm UI.
//
// Size is width/height (linked to preserve the source's aspect ratio),
// not a fixed choice of two tiers - "Web standard"/"High detail" are
// quick-fill presets (from Settings-adjustable saved values), not the
// only options, since a fixed binary choice is exactly what this was
// before and it wasn't enough.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
let pendingImagePath = null;
let pendingImageDims = null; // {width, height} of the chosen source file
// The same panel doubles as the "localize a remote image" flow (reusing
// its alt/size/placement fields rather than building a second one) -
// this tracks which mode is active and, for localize, the existing
// reference's span in the editor to replace on success.
let insertMode = "file";
let pendingLocalizeTarget = null; // {start, end, src} of the remote reference being localized

const imagePanel = document.getElementById("insert-image-panel");
const imagePanelTitle = document.getElementById("insert-panel-title");
const imagePreview = document.getElementById("insert-image-preview");
const imageAltInput = document.getElementById("insert-image-alt");
const imageStatus = document.getElementById("insert-image-status");
const insertCurrentSizeEl = document.getElementById("insert-image-current-size");
const insertWidthInput = document.getElementById("insert-image-width");
const insertHeightInput = document.getElementById("insert-image-height");
const insertQualityInput = document.getElementById("insert-image-quality");
const insertPlacementStaticLabel = document.getElementById("insert-placement-static-label");

const refreshPlacementLabel = async () => {
  try {
    const r2 = await invoke("get_r2_personal_config");
    insertPlacementStaticLabel.textContent = r2.enabled
      ? "Shared images folder (uploads to Cloudflare R2)"
      : "Shared images folder (reusable across pages)";
  } catch {
    insertPlacementStaticLabel.textContent = "Shared images folder (reusable across pages)";
  }
};

const looksLikeImagePath = (path) => {
  const ext = path.split(".").pop().toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
};

const filenameStem = (path) => {
  const base = path.split(/[\\/]/).pop();
  return base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
};

// Scales {srcW, srcH} down to fit within a cap x cap box, preserving
// aspect ratio - never upscales, matching the backend's own behavior.
const fitWithinCap = (srcW, srcH, cap) => {
  if (srcW <= cap && srcH <= cap) return { width: srcW, height: srcH };
  const scale = cap / Math.max(srcW, srcH);
  return { width: Math.round(srcW * scale), height: Math.round(srcH * scale) };
};

const TIER_FIELDS = {
  web: ["webCap", "webQuality"],
  high: ["highCap", "highQuality"],
  "post-internal": ["postInternalCap", "postInternalQuality"],
};

const applyInsertPreset = async (which) => {
  if (!pendingImageDims) return;
  const tiers = await invoke("get_tier_settings");
  const [capField, qualityField] = TIER_FIELDS[which];
  const fit = fitWithinCap(pendingImageDims.width, pendingImageDims.height, tiers[capField]);
  insertWidthInput.value = fit.width;
  insertHeightInput.value = fit.height;
  insertQualityInput.value = tiers[qualityField];
};

document.getElementById("insert-preset-web").addEventListener("click", () => applyInsertPreset("web"));
document.getElementById("insert-preset-high").addEventListener("click", () => applyInsertPreset("high"));
document.getElementById("insert-preset-post-internal").addEventListener("click", () => applyInsertPreset("post-internal"));

insertWidthInput.addEventListener("input", () => {
  if (!pendingImageDims) return;
  const w = Number(insertWidthInput.value);
  if (w > 0) insertHeightInput.value = Math.round((w * pendingImageDims.height) / pendingImageDims.width);
});
insertHeightInput.addEventListener("input", () => {
  if (!pendingImageDims) return;
  const h = Number(insertHeightInput.value);
  if (h > 0) insertWidthInput.value = Math.round((h * pendingImageDims.width) / pendingImageDims.height);
});

const openInsertImagePanel = async (path) => {
  insertMode = "file";
  imagePanelTitle.textContent = "Insert image";
  pendingImagePath = path;
  imageAltInput.value = filenameStem(path).replace(/[-_]+/g, " ");
  imageStatus.textContent = "";
  imagePreview.src = "";
  insertCurrentSizeEl.textContent = "";
  imagePanel.style.display = "flex";
  refreshPlacementLabel();
  try {
    imagePreview.src = await invoke("read_image_preview", { path });
  } catch (err) {
    imageStatus.textContent = "Couldn't preview this file: " + err;
  }
  try {
    const [width, height] = await invoke("get_image_dimensions", { path });
    pendingImageDims = { width, height };
    insertCurrentSizeEl.textContent = `Original size: ${width} x ${height}px`;
    await applyInsertPreset("web");
  } catch (err) {
    pendingImageDims = null;
    insertCurrentSizeEl.textContent = "Couldn't read this image's size: " + err;
  }
};

// A plain <img src="https://..."> loads and reports its natural size
// without any Tauri round-trip - unlike a local file, a URL isn't
// subject to the asset-protocol scope restriction that read_image_preview
// and get_image_dimensions exist to work around in the file-insert flow.
const loadRemoteImageDims = (url) =>
  new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new Error("couldn't load this image"));
    probe.src = url;
  });

const openLocalizePanel = async (found) => {
  insertMode = "localize";
  imagePanelTitle.textContent = "Localize image";
  pendingLocalizeTarget = found;
  imageAltInput.value = found.alt;
  imageStatus.textContent = "";
  insertCurrentSizeEl.textContent = "";
  imagePreview.src = found.src;
  imagePanel.style.display = "flex";
  refreshPlacementLabel();
  try {
    const { width, height } = await loadRemoteImageDims(found.src);
    pendingImageDims = { width, height };
    insertCurrentSizeEl.textContent = `Original size: ${width} x ${height}px`;
    await applyInsertPreset("web");
  } catch (err) {
    pendingImageDims = null;
    insertCurrentSizeEl.textContent = "Couldn't read this image's size: " + err;
  }
};

const closeInsertImagePanel = () => {
  imagePanel.style.display = "none";
  pendingImagePath = null;
  pendingImageDims = null;
  pendingLocalizeTarget = null;
};

document.getElementById("fmt-image").addEventListener("click", withActiveTab(async () => {
  try {
    const path = await window.__TAURI__.dialog.open({
      multiple: false,
      title: "Choose an image",
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (path) await openInsertImagePanel(path);
  } catch (err) {
    imageStatus.textContent = "ERROR: " + err;
    imagePanel.style.display = "flex";
  }
}));

document.getElementById("insert-image-cancel").addEventListener("click", closeInsertImagePanel);

document.getElementById("insert-image-confirm").addEventListener("click", async () => {
  if (!activeTab) return;
  if (insertMode === "file" && !pendingImagePath) return;
  if (insertMode === "localize" && !pendingLocalizeTarget) return;
  const width = Number(insertWidthInput.value);
  const height = Number(insertHeightInput.value);
  const quality = Number(insertQualityInput.value);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    imageStatus.textContent = "Width and height must be whole numbers greater than 0.";
    return;
  }
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    imageStatus.textContent = "Quality must be a whole number between 1 and 100.";
    return;
  }
  const placement = document.querySelector('input[name="insert-image-placement"]:checked').value;
  const alt = imageAltInput.value;

  // Ask the backend rather than re-deriving the bundle-page convention
  // here - a hand-copied version of this exact check (missing _index.md)
  // is what caused the site-root-renaming bug found while testing.
  const isAlreadyBundle = await invoke("is_bundle_page", { path: activeTab });
  if (placement === "bundle" && !isAlreadyBundle) {
    const newPath = activeTab.replace(/\.md$/, "") + "/index.md";
    const proceed = confirm(
      `"${activeTab}" isn't a page bundle yet. Placing an image with this page will convert it to "${newPath}" so the image can live alongside it. Continue?`
    );
    if (!proceed) return;
  }

  const confirmBtn = document.getElementById("insert-image-confirm");
  const cancelBtn = document.getElementById("insert-image-cancel");
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  imageStatus.innerHTML = '<span class="spinner"></span>Processing image…';
  try {
    const result =
      insertMode === "localize"
        ? await invoke("localize_remote_image", {
            url: pendingLocalizeTarget.src,
            width,
            height,
            quality,
            placement,
            currentContentPath: activeTab,
          })
        : await invoke("insert_image", {
            sourcePath: pendingImagePath,
            width,
            height,
            quality,
            placement,
            currentContentPath: activeTab,
          });

    if (result.renamedContentPath) {
      // Bundle placement converted the current leaf page into
      // content/foo/index.md - move this tab to follow it, and tell the
      // backend to track the new path instead of the one that no longer
      // exists on disk.
      const oldPath = activeTab;
      const tab = tabs.get(oldPath);
      tabs.delete(oldPath);
      tabs.set(result.renamedContentPath, tab);
      setActiveTab(result.renamedContentPath);
      invoke("close_file", { path: oldPath }).catch(() => {});
      invoke("read_file", { path: result.renamedContentPath }).catch(() => {});
      await refreshFileList();
      fileSelect.value = result.renamedContentPath;
      renderTabBar();
    }

    const newReference = `![${alt}](${result.markdownReference})`;
    if (insertMode === "localize") {
      // Replace the original remote reference's exact span rather than
      // inserting at the cursor, which may have moved since the panel
      // opened - this is a replacement, not a fresh insert.
      const { start, end } = pendingLocalizeTarget;
      const value = editorEl.value;
      editorEl.value = value.slice(0, start) + newReference + value.slice(end);
      editorEl.focus();
      const pos = start + newReference.length;
      editorEl.setSelectionRange(pos, pos);
      emitEdited();
    } else {
      insertAtCursor(newReference);
    }
    closeInsertImagePanel();
    updateImageAlignToolbar();
  } catch (err) {
    imageStatus.textContent = "ERROR: " + err;
  } finally {
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

// Drag/drop a file straight onto the editor as an alternative to the
// file picker - core Tauri functionality, no separate plugin.
window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop" || !activeTab) return;
  const path = event.payload.paths[0];
  if (path && looksLikeImagePath(path)) openInsertImagePanel(path);
});

// Insert an image by URL - deliberately does NOT go through
// insert_image_impl/localize_remote_image: nothing is downloaded,
// normalized, or stored in the site. This is for a photo that already
// lives somewhere on the web (e.g. cheap object storage a committee
// member uploaded to directly) and should just be linked to as-is. The
// fetch here is purely a client-side <img> load, to confirm the URL is
// actually a working image before committing to using it - no Rust
// command needed since a plain <img src> isn't subject to the asset-
// protocol scoping that local-file paths need read_image_preview for.
const urlImagePanel = document.getElementById("insert-url-image-panel");
const urlImageInput = document.getElementById("url-image-url");
const urlImagePreview = document.getElementById("url-image-preview");
const urlImageAltInput = document.getElementById("url-image-alt");
const urlImageStatus = document.getElementById("url-image-status");
let urlImageValid = false;

const openUrlImagePanel = () => {
  urlImageInput.value = "";
  urlImageAltInput.value = "";
  urlImageStatus.textContent = "";
  urlImagePreview.style.display = "none";
  urlImageValid = false;
  urlImagePanel.style.display = "flex";
  urlImageInput.focus();
};

const closeUrlImagePanel = () => {
  urlImagePanel.style.display = "none";
};

let urlPreviewDebounce = null;
urlImageInput.addEventListener("input", () => {
  clearTimeout(urlPreviewDebounce);
  urlImageValid = false;
  urlImageStatus.textContent = "";
  urlPreviewDebounce = setTimeout(() => {
    const url = urlImageInput.value.trim();
    if (!url) {
      urlImagePreview.style.display = "none";
      return;
    }
    urlImageStatus.textContent = "Checking…";
    const probe = new Image();
    probe.onload = () => {
      if (urlImageInput.value.trim() !== url) return; // superseded by a later edit
      urlImageValid = true;
      urlImageStatus.textContent = "";
      urlImagePreview.src = url;
      urlImagePreview.style.display = "block";
      if (!urlImageAltInput.value) {
        urlImageAltInput.value = filenameStem(url.split("?")[0]).replace(/[-_]+/g, " ");
      }
    };
    probe.onerror = () => {
      if (urlImageInput.value.trim() !== url) return;
      urlImageValid = false;
      urlImageStatus.textContent = "Couldn't load an image from this URL.";
      urlImagePreview.style.display = "none";
    };
    probe.src = url;
  }, 400);
});

document.getElementById("fmt-image-url").addEventListener("click", withActiveTab(openUrlImagePanel));
document.getElementById("url-image-cancel").addEventListener("click", closeUrlImagePanel);

document.getElementById("url-image-confirm").addEventListener("click", () => {
  if (!activeTab) return;
  const url = urlImageInput.value.trim();
  if (!url || !urlImageValid) {
    urlImageStatus.textContent = "Enter a URL that successfully loads as an image first.";
    return;
  }
  insertAtCursor(`![${urlImageAltInput.value}](${url})`);
  closeUrlImagePanel();
  updateImageAlignToolbar();
});

// Contextual image-alignment toolbar: shown whenever the cursor sits
// inside an image reference (markdown ![]() or the raw <img> this app
// emits once an alignment has been applied), regardless of where
// onscreen that reference happens to be - this toolbar lives in one
// fixed spot rather than following the caret. Textareas have no native
// "caret pixel position" API; the usual workaround (a hidden mirror div
// replicating font/wrapping) wasn't worth it for what this needs, and a
// fixed location works just as well.
//
// Plain CommonMark has no alignment concept at all, so rather than
// inventing bracket-attribute syntax on top of ![]() and hoping Zola's
// markdown renderer supports it, alignment is expressed as a raw <img>
// tag with an inline style - CommonMark guarantees raw HTML passthrough,
// so this renders correctly regardless of SSG-specific extensions.
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const HTML_IMAGE_RE = /<img src="([^"]*)" alt="([^"]*)"(?: style="([^"]*)")?\s*\/?>/g;

const alignFromStyle = (style) => {
  if (!style) return "none";
  if (/float:\s*right/.test(style)) return "right";
  if (/float:\s*left/.test(style)) return "left";
  if (/margin:\s*0 auto/.test(style)) return "center";
  return "none";
};

const styleForAlign = (align) => {
  switch (align) {
    case "right":
      return "float:right; margin:0 0 1em 1em;";
    case "left":
      return "float:left; margin:0 1em 1em 0;";
    case "center":
      return "display:block; margin:0 auto 1em;";
    default:
      return null;
  }
};

// Scans the whole textarea for image references and returns the one
// (markdown or this app's own <img> form) containing the current cursor
// position, or null if the cursor isn't inside one.
const findImageAtCursor = () => {
  const value = editorEl.value;
  const cursor = editorEl.selectionStart;

  for (const re of [MD_IMAGE_RE, HTML_IMAGE_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value))) {
      const start = match.index;
      const end = start + match[0].length;
      if (cursor >= start && cursor <= end) {
        return re === MD_IMAGE_RE
          ? { start, end, alt: match[1], src: match[2], align: "none" }
          : { start, end, src: match[1], alt: match[2], align: alignFromStyle(match[3]) };
      }
    }
  }
  return null;
};

const imageAlignToolbar = document.getElementById("image-align-toolbar");
const imageLocalizeButton = document.getElementById("image-localize-button");
const imageAlignStatus = document.getElementById("image-align-status");

const isRemoteUrl = (src) => /^https?:\/\//i.test(src);

const updateImageAlignToolbar = () => {
  const found = activeTab ? findImageAtCursor() : null;
  if (!found) {
    imageAlignToolbar.style.display = "none";
    return;
  }
  imageAlignToolbar.style.display = "flex";
  imageAlignToolbar.querySelectorAll("button[data-align]").forEach((btn) => {
    btn.classList.toggle("align-active", btn.dataset.align === found.align);
  });
  // Resize acts on a local file; localize is the opposite case (a
  // reference this app doesn't own the bytes for yet) - never both.
  const remote = isRemoteUrl(found.src);
  imageLocalizeButton.hidden = !remote;
  document.getElementById("image-resize-button").hidden = remote;
  imageAlignStatus.textContent = "";
};

// Other modules (editor-core.js) can't call this directly without a
// circular import - they dispatch this custom event instead whenever the
// open buffer changes in a way that might invalidate whatever's at the
// cursor (a tab opened, switched, or closed down to none).
document.addEventListener("beedance:tab-changed", updateImageAlignToolbar);

imageAlignToolbar.querySelectorAll("button[data-align]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const found = findImageAtCursor();
    if (!found) return;

    const style = styleForAlign(btn.dataset.align);
    const replacement = style
      ? `<img src="${found.src}" alt="${found.alt}" style="${style}">`
      : `![${found.alt}](${found.src})`;

    const value = editorEl.value;
    editorEl.value = value.slice(0, found.start) + replacement + value.slice(found.end);
    editorEl.focus();
    const pos = found.start + replacement.length;
    editorEl.setSelectionRange(pos, pos);
    emitEdited();
    updateImageAlignToolbar();
  });
});

// Resolves an image reference's src (a bare filename for a page-bundle
// image, or a site-root-relative "/images/..." path for static/images/)
// to the site-relative file path the backend needs - the same mapping
// insert_image itself uses in reverse when it first placed the file.
const resolveImageFilePath = (src) => {
  if (src.startsWith("/")) {
    return "static" + src;
  }
  const dir = activeTab.includes("/") ? activeTab.slice(0, activeTab.lastIndexOf("/")) : "";
  return dir ? `${dir}/${src}` : src;
};

// Resize panel: opened from the alignment toolbar's "Resize..." button.
// Percentage presets (of the image's CURRENT on-disk size) plus linked
// width/height inputs, rather than a single ambiguous number - the
// warning text + a clearly-labeled action button serve as the
// confirmation step, instead of stacking a native confirm() on top.
const resizePanel = document.getElementById("resize-image-panel");
const resizeCurrentSizeEl = document.getElementById("resize-current-size");
const resizeWidthInput = document.getElementById("resize-width");
const resizeHeightInput = document.getElementById("resize-height");
const resizeStatus = document.getElementById("resize-status");
let pendingResizePath = null; // site-relative path passed to resize_image_in_place
let pendingResizeDims = null; // {width, height} of the image's CURRENT on-disk size

document.getElementById("image-localize-button").addEventListener("click", async () => {
  const found = findImageAtCursor();
  if (!found || !isRemoteUrl(found.src)) return;
  await openLocalizePanel(found);
});

document.getElementById("image-resize-button").addEventListener("click", async () => {
  const found = findImageAtCursor();
  if (!found) return;

  pendingResizePath = resolveImageFilePath(found.src);
  resizeStatus.textContent = "";
  resizeCurrentSizeEl.textContent = "";
  resizePanel.style.display = "flex";

  try {
    const absolutePath = `${currentSiteDir}/${pendingResizePath}`;
    const [width, height] = await invoke("get_image_dimensions", { path: absolutePath });
    pendingResizeDims = { width, height };
    resizeCurrentSizeEl.textContent = `Current size: ${width} x ${height}px`;
    resizeWidthInput.value = width;
    resizeHeightInput.value = height;
  } catch (err) {
    pendingResizeDims = null;
    resizeCurrentSizeEl.textContent = "Couldn't read this image's size: " + err;
  }
});

resizeWidthInput.addEventListener("input", () => {
  if (!pendingResizeDims) return;
  const w = Number(resizeWidthInput.value);
  if (w > 0) resizeHeightInput.value = Math.round((w * pendingResizeDims.height) / pendingResizeDims.width);
});
resizeHeightInput.addEventListener("input", () => {
  if (!pendingResizeDims) return;
  const h = Number(resizeHeightInput.value);
  if (h > 0) resizeWidthInput.value = Math.round((h * pendingResizeDims.width) / pendingResizeDims.height);
});

resizePanel.querySelectorAll("button[data-resize-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!pendingResizeDims) return;
    const pct = Number(btn.dataset.resizePreset);
    resizeWidthInput.value = Math.round(pendingResizeDims.width * pct);
    resizeHeightInput.value = Math.round(pendingResizeDims.height * pct);
  });
});

document.getElementById("resize-cancel").addEventListener("click", () => {
  resizePanel.style.display = "none";
  pendingResizePath = null;
  pendingResizeDims = null;
});

document.getElementById("resize-confirm").addEventListener("click", async () => {
  if (!pendingResizePath) return;
  const width = Number(resizeWidthInput.value);
  const height = Number(resizeHeightInput.value);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    resizeStatus.textContent = "Width and height must be whole numbers greater than 0.";
    return;
  }

  resizeStatus.textContent = "Resizing…";
  try {
    await invoke("resize_image_in_place", { path: pendingResizePath, width, height });
    resizeStatus.textContent = "Resized.";
    setTimeout(() => {
      resizePanel.style.display = "none";
    }, 600);
  } catch (err) {
    resizeStatus.textContent = "ERROR: " + err;
  }
});

editorEl.addEventListener("click", updateImageAlignToolbar);
editorEl.addEventListener("keyup", updateImageAlignToolbar);

wirePanelKeys(imagePanel, "insert-image-confirm", "insert-image-cancel");
wirePanelKeys(urlImagePanel, "url-image-confirm", "url-image-cancel");
wirePanelKeys(resizePanel, "resize-confirm", "resize-cancel");
