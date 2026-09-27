//! Image insert/resize pipeline: normalize (downscale + re-encode, dropping
//! EXIF), place (site-wide static/ or a page bundle, or upload to R2 if
//! configured), and the smaller supporting commands (dimensions, preview,
//! in-place resize) the frontend's insert/resize panels use.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use image::codecs::jpeg::JpegEncoder;
use image::{imageops::FilterType, ImageFormat, ImageReader};

use crate::r2::{
    delete_from_r2, r2_fully_configured, r2_key_from_url, r2_public_url_base, upload_to_r2, R2PersonalConfigState,
    R2SiteConfigState,
};
use crate::site::{resolve_site_path, site_config_dir, site_dir, OpenFiles, SelfWriteTracker};
use crate::zola;

// Saved presets the frontend offers when inserting an image - not the only
// choice available there (insert_image below takes an explicit width/height/
// quality, so any custom size works), just a quick-fill starting point.
// Three presets: close-up nature/macro photography (this app's first real
// site is a bee/pollinator committee blog) genuinely needs more resolution
// than a typical web photo, and a small "post internal" size exists
// separately from "web standard" because an image meant to float left/right
// with text wrapping around it needs to be noticeably smaller than a
// full-width photo, or the float looks wrong (a giant image with a sliver of
// text next to it, not a photo alongside a paragraph). User-adjustable (see
// get_tier_settings/set_tier_settings) since the right tradeoff depends on
// the site's own photos - SITE config (site_config_dir(), committed, shared
// by everyone who edits this site), not personal, since it's a property of
// the site's own photos/layout, not of who happens to be editing right now.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierSettings {
    web_cap: u32,
    web_quality: u8,
    high_cap: u32,
    high_quality: u8,
    post_internal_cap: u32,
    post_internal_quality: u8,
}

impl Default for TierSettings {
    fn default() -> Self {
        // 1600 vs. an original 2000px cap: JPEG size roughly tracks pixel
        // area, so a 20% smaller linear dimension is ~36% smaller output.
        // post_internal is a guess (240px) at "small enough for a
        // meaningful left/right float", not measured against a real theme -
        // adjust once it's actually used against real content.
        TierSettings {
            web_cap: 1600,
            web_quality: 80,
            high_cap: 4800,
            high_quality: 90,
            post_internal_cap: 240,
            post_internal_quality: 82,
        }
    }
}

const TIER_SETTINGS_FILE: &str = "image-tiers.json";

pub struct TierSettingsState(pub Mutex<TierSettings>);

pub fn load_tier_settings() -> TierSettings {
    std::fs::read_to_string(site_config_dir().join(TIER_SETTINGS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_tier_settings(state: tauri::State<TierSettingsState>) -> TierSettings {
    *state.0.lock().unwrap()
}

#[tauri::command]
pub fn set_tier_settings(settings: TierSettings, state: tauri::State<TierSettingsState>) -> Result<(), String> {
    // Sane bounds so a typo can't produce a 0px image or a multi-hundred
    // megapixel one.
    let caps = [settings.web_cap, settings.high_cap, settings.post_internal_cap];
    if caps.iter().any(|c| *c == 0 || *c > 10000) {
        return Err("size must be between 1 and 10000px".to_string());
    }
    let qualities = [settings.web_quality, settings.high_quality, settings.post_internal_quality];
    if qualities.iter().any(|q| !(1..=100).contains(q)) {
        return Err("quality must be between 1 and 100".to_string());
    }

    *state.0.lock().unwrap() = settings;

    let dir = site_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(TIER_SETTINGS_FILE), json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Appends "-1", "-2", ... before the extension until an unused filename is
/// found in `dir`, so inserting two images named the same never clobbers one.
fn unique_dest(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string());
    let ext = Path::new(filename).extension().map(|e| e.to_string_lossy().to_string());

    let mut n = 1;
    loop {
        let name = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

// Tauri's camelCase auto-conversion for invoke() only applies to command
// ARGUMENTS (JS -> Rust); a returned struct goes through plain serde, which
// uses the Rust field names as-is unless told otherwise - without this
// attribute the frontend's `result.markdownReference` reads undefined off a
// `markdown_reference` key and silently inserts `![alt](undefined)`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertImageResult {
    // What to write into the markdown at the cursor: a bare filename for a
    // page-bundle image, or a site-root-relative path for static/images/.
    markdown_reference: String,
    // Some(new site-relative path) if inserting as a page-bundle image
    // required converting the current leaf page into a bundle
    // (content/foo.md -> content/foo/index.md) - the frontend must move its
    // open tab to this new path, since the old one no longer exists on disk.
    renamed_content_path: Option<String>,
}

/// Shared core of insert_image and localize_remote_image: both end up with
/// image bytes sitting in a local file (a directly-picked file for one, a
/// freshly-downloaded temp file for the other) and just need it normalized
/// and placed - normalizes (downscale-only to the given width/height,
/// re-encoded so EXIF/metadata is dropped, original format preserved) and
/// writes it to either a site-wide static/images/ folder or alongside the
/// current page as a Zola page bundle. If the current page isn't a bundle
/// yet, bundle placement converts it in place - the caller is expected to
/// have already confirmed that with the user, since it's a content-structure
/// change (a file rename+move), not just an insert. `source_name` drives the
/// destination filename/extension - kept separate from `source_path` since a
/// downloaded temp file's own path is a meaningless generated name, not
/// something worth carrying into the site's actual file/URL.
async fn insert_image_impl(
    source_path: PathBuf,
    source_name: String,
    width: u32,
    height: u32,
    quality: u8,
    placement: String,
    current_content_path: String,
    tracker: tauri::State<'_, SelfWriteTracker>,
    open_files: tauri::State<'_, OpenFiles>,
    r2_site: tauri::State<'_, R2SiteConfigState>,
    r2_personal: tauri::State<'_, R2PersonalConfigState>,
) -> Result<InsertImageResult, String> {
    // Format is just a header read, cheap - fine on the main thread that
    // #[tauri::command] runs synchronous work on. Decoding/resizing/encoding
    // a real photo is not cheap, and is moved to spawn_blocking below so a
    // multi-megapixel insert doesn't freeze the whole app the way
    // zola_serve's blocking wait_for_port used to.
    let format = ImageReader::open(&source_path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .format()
        .ok_or_else(|| "could not determine image format".to_string())?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP) {
        return Err(format!("unsupported image format: {format:?} (supported: JPEG, PNG, WebP)"));
    }

    let site = site_dir();
    let mut renamed_content_path = None;

    // R2 stands in for "static" specifically (a shared, site-wide images
    // location - the same conceptual slot, just a different implementation)
    // when it's configured and enabled. "bundle" always stays local - a
    // page-bundle image is inherently tied to one specific page/commit, not
    // a shared asset, so diverting it to a shared bucket wouldn't make sense
    // even with R2 turned on.
    let r2_site_cfg = r2_site.0.lock().unwrap().clone();
    let r2_personal_cfg = r2_personal.0.lock().unwrap().clone();
    let use_r2 = placement == "static" && r2_fully_configured(&r2_site_cfg, &r2_personal_cfg);

    let (dest_dir, markdown_prefix) = match placement.as_str() {
        "static" if use_r2 => (PathBuf::new(), String::new()), // unused in this branch, see below
        "static" => {
            let dir = site.join(zola::STATIC_DIR).join("images");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            (dir, "/images/".to_string())
        }
        "bundle" => {
            let current_full = resolve_site_path(&current_content_path)?;
            let is_already_bundle = zola::is_bundle_page(&current_full);

            let bundle_dir = if is_already_bundle {
                current_full
                    .parent()
                    .ok_or_else(|| "invalid content path".to_string())?
                    .to_path_buf()
            } else {
                let stem = current_full
                    .file_stem()
                    .ok_or_else(|| "invalid content path".to_string())?;
                let new_dir = current_full
                    .parent()
                    .ok_or_else(|| "invalid content path".to_string())?
                    .join(stem);
                std::fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
                let new_index = new_dir.join("index.md");

                // The rename below is invisible to the frontend until it gets
                // this command's result back, but the content watcher runs
                // concurrently and covers the whole site - without this, it
                // sees a real fs event on `current_full` (which is still in
                // OpenFiles, since the frontend hasn't called close_file yet)
                // with no self-write record, and reports it as an external
                // change on a tab that's actually just being moved by us.
                {
                    let mut t = tracker.0.lock().unwrap();
                    t.insert(current_full.clone(), Instant::now());
                    t.insert(new_index.clone(), Instant::now());
                }

                std::fs::rename(&current_full, &new_index).map_err(|e| e.to_string())?;
                open_files.0.lock().unwrap().remove(&current_full);

                renamed_content_path = Some(
                    new_index
                        .strip_prefix(&site)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
                new_dir
            };
            (bundle_dir, String::new())
        }
        other => return Err(format!("unknown placement: {other}")),
    };

    // Encodes into memory regardless of destination - R2 needs bytes to PUT,
    // and a local write is just as happy taking bytes as a path, so this one
    // path serves both rather than duplicating the decode/resize/encode
    // logic per destination.
    let encode_image = {
        let source_path = source_path.clone();
        move || -> Result<Vec<u8>, String> {
            let img = ImageReader::open(&source_path)
                .map_err(|e| e.to_string())?
                .decode()
                .map_err(|e| e.to_string())?;
            let resized = if img.width() > width || img.height() > height {
                img.resize(width, height, FilterType::Lanczos3)
            } else {
                img
            };

            let mut buffer = Vec::new();
            match format {
                ImageFormat::Jpeg => {
                    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
                    encoder.encode_image(&resized).map_err(|e| e.to_string())?;
                }
                _ => {
                    resized
                        .write_to(&mut std::io::Cursor::new(&mut buffer), format)
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok(buffer)
        }
    };
    let encoded_bytes = tauri::async_runtime::spawn_blocking(encode_image)
        .await
        .map_err(|e| e.to_string())??;

    let markdown_reference = if use_r2 {
        // Timestamp prefix avoids collisions between different people's
        // same-named uploads - R2 has no equivalent to unique_dest's local
        // existence check, it would just silently overwrite a same-key object.
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let key = format!("images/{timestamp}-{source_name}");

        let upload = {
            let r2_site_cfg = r2_site_cfg.clone();
            let r2_personal_cfg = r2_personal_cfg.clone();
            let key = key.clone();
            let encoded_bytes = encoded_bytes.clone();
            move || upload_to_r2(&r2_site_cfg, &r2_personal_cfg, &key, &encoded_bytes)
        };
        tauri::async_runtime::spawn_blocking(upload)
            .await
            .map_err(|e| e.to_string())??;

        format!("{}/{key}", r2_public_url_base(&r2_site_cfg).trim_end_matches('/'))
    } else {
        let dest_path = unique_dest(&dest_dir, &source_name);
        let dest_filename = dest_path.file_name().unwrap().to_string_lossy().to_string();
        std::fs::write(&dest_path, &encoded_bytes).map_err(|e| e.to_string())?;
        format!("{markdown_prefix}{dest_filename}")
    };

    Ok(InsertImageResult {
        markdown_reference,
        renamed_content_path,
    })
}

#[tauri::command]
pub async fn insert_image(
    source_path: String,
    width: u32,
    height: u32,
    quality: u8,
    placement: String,
    current_content_path: String,
    tracker: tauri::State<'_, SelfWriteTracker>,
    open_files: tauri::State<'_, OpenFiles>,
    r2_site: tauri::State<'_, R2SiteConfigState>,
    r2_personal: tauri::State<'_, R2PersonalConfigState>,
) -> Result<InsertImageResult, String> {
    let source_name = Path::new(&source_path)
        .file_name()
        .ok_or_else(|| "invalid source filename".to_string())?
        .to_string_lossy()
        .to_string();
    insert_image_impl(
        PathBuf::from(source_path),
        source_name,
        width,
        height,
        quality,
        placement,
        current_content_path,
        tracker,
        open_files,
        r2_site,
        r2_personal,
    )
    .await
}

/// The last path segment of a URL, stripped of any query string - used as
/// the destination filename when localizing, since a downloaded temp file's
/// own generated name is meaningless. Falls back to a generic name if the
/// URL has no usable segment (e.g. ends in "/").
fn filename_from_url(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    without_query
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("image")
        .to_string()
}

/// Downloads a remote image and runs it through the exact same normalize+
/// place pipeline as a locally-picked file (see insert_image_impl) - the
/// only difference is where the bytes come from. Existing content that
/// points at images hosted elsewhere (e.g. easthamptonbees-ssg's WordPress-
/// migration images) can be localized without depending on that host
/// staying reachable.
#[tauri::command]
pub async fn localize_remote_image(
    url: String,
    width: u32,
    height: u32,
    quality: u8,
    placement: String,
    current_content_path: String,
    tracker: tauri::State<'_, SelfWriteTracker>,
    open_files: tauri::State<'_, OpenFiles>,
    r2_site: tauri::State<'_, R2SiteConfigState>,
    r2_personal: tauri::State<'_, R2PersonalConfigState>,
) -> Result<InsertImageResult, String> {
    let source_name = filename_from_url(&url);
    let temp_path = std::env::temp_dir().join(format!("beedance-localize-{}-{source_name}", std::process::id()));

    let download = {
        let url = url.clone();
        let temp_path = temp_path.clone();
        move || -> Result<(), String> {
            let bytes = ureq::get(&url)
                .header("User-Agent", "Mozilla/5.0 (compatible; beedance-ssg-editor)")
                .call()
                .map_err(|e| e.to_string())?
                .body_mut()
                .read_to_vec()
                .map_err(|e| e.to_string())?;
            std::fs::write(&temp_path, bytes).map_err(|e| e.to_string())
        }
    };
    tauri::async_runtime::spawn_blocking(download)
        .await
        .map_err(|e| e.to_string())??;

    let result = insert_image_impl(
        temp_path.clone(),
        source_name,
        width,
        height,
        quality,
        placement,
        current_content_path,
        tracker,
        open_files,
        r2_site,
        r2_personal,
    )
    .await;
    let _ = std::fs::remove_file(&temp_path);
    result
}

/// Shrinks an already-inserted image file in place - destructive (overwrites
/// the file) and downscale-only (never enlarges past its current size,
/// since upscaling only degrades quality further with no real benefit). The
/// frontend is responsible for warning the user before calling this; the
/// only guard enforced here is the shrink-only constraint itself. Doesn't
/// touch SelfWriteTracker/OpenFiles - image files are never registered as
/// open tabs in this app, so the content watcher never watches them.
#[tauri::command]
pub async fn resize_image_in_place(path: String, width: u32, height: u32) -> Result<(), String> {
    let full = resolve_site_path(&path)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let reader = ImageReader::open(&full)
            .map_err(|e| e.to_string())?
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let format = reader
            .format()
            .ok_or_else(|| "could not determine image format".to_string())?;

        let img = reader.decode().map_err(|e| e.to_string())?;
        if width >= img.width() && height >= img.height() {
            return Err(format!(
                "new size ({width}x{height}) isn't smaller than the current image ({}x{}) - this can only shrink, not enlarge",
                img.width(),
                img.height()
            ));
        }

        let resized = img.resize(width, height, FilterType::Lanczos3);
        match format {
            ImageFormat::Jpeg => {
                let mut out = std::fs::File::create(&full).map_err(|e| e.to_string())?;
                // Manual resizing is a one-off touch-up, not a fresh insert
                // through a chosen size/quality tier - a fixed, reasonably
                // high quality keeps this simple rather than asking the user
                // to also pick a quality number for a single shrink action.
                let mut encoder = JpegEncoder::new_with_quality(&mut out, 85);
                encoder.encode_image(&resized).map_err(|e| e.to_string())?;
            }
            _ => {
                resized.save_with_format(&full, format).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

/// Dimensions of an image file at an arbitrary path - unlike most other
/// commands here, NOT resolved against the site, since this serves two
/// callers: a not-yet-inserted source file (anywhere on disk, e.g.
/// ~/Downloads) and an already-inserted one (where the frontend passes the
/// full absolute path itself, having prefixed the site dir on). Read-only,
/// so accepting any path is low-risk - unlike resize_image_in_place, which
/// overwrites a file and stays constrained to the site via
/// resolve_site_path.
#[tauri::command]
pub async fn get_image_dimensions(path: String) -> Result<(u32, u32), String> {
    tauri::async_runtime::spawn_blocking(move || image::image_dimensions(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Reads an image file and returns it as a data: URL, purely so the frontend
/// can show a preview thumbnail before committing to an insert - a custom
/// command reading raw bytes sidesteps needing the source path (which can be
/// anywhere on disk, e.g. ~/Downloads, not just under the site) to fall
/// within any Tauri asset-protocol scope.
#[tauri::command]
pub fn read_image_preview(path: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match Path::new(&path).extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "gif" => "image/gif",
        _ => "image/jpeg",
    };
    let encoded = STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Explicitly deletes an R2-hosted image (the "Delete image" button in the
/// alignment toolbar, next to Resize/Localize) - conceived as the everyday
/// way to actually replace one: delete the old one here first (removing
/// both its storage and its reference in one action), then insert the new
/// one normally, rather than the app trying to infer "this was a replace"
/// from a freeform text edit. See pws-6ryi - this and delete_content's own
/// best-effort cleanup are the two places R2 objects actually get removed;
/// there's still no periodic sweep for anything that slips past both.
#[tauri::command]
pub fn delete_r2_image_by_url(
    url: String,
    r2_site: tauri::State<R2SiteConfigState>,
    r2_personal: tauri::State<R2PersonalConfigState>,
) -> Result<(), String> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let personal_cfg = r2_personal.0.lock().unwrap().clone();
    let key = r2_key_from_url(&site_cfg, &url)
        .ok_or_else(|| "This image isn't hosted in this site's R2 bucket - nothing to delete remotely.".to_string())?;
    delete_from_r2(&site_cfg, &personal_cfg, &key)
}
