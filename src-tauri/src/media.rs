//! Media library (pws-ply7): browsing and deleting SHARED images only -
//! static/images/ locally, and R2. A page-bundle image ("with this page
//! only" placement, see images.rs) is deliberately excluded - it's
//! physically 1:1 with the one page whose directory it lives in, so a
//! "usage count" for it is meaningless (always "1, itself"), and it already
//! gets cleaned up automatically when delete_content removes that bundle.
//! The real problem this module exists for - a stray upload nothing
//! references anymore - only happens to a shared image.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::content::extract_image_urls;
use crate::r2::{delete_from_r2, r2_fully_configured, r2_key_from_url, R2PersonalConfigState, R2SiteConfigState};
use crate::site::{collect_files_with_ext, collect_template_files, site_dir};
use crate::zola;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg"];

fn is_image_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

fn collect_images(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, out);
        } else if is_image_file(&path) {
            out.push(path);
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaImage {
    // Canonical key: for Local, the path under static/ (e.g.
    // "images/foo.jpg"); for R2, the object key (e.g.
    // "images/1700000000-foo.jpg", see images.rs's own upload key format) -
    // the same shape scan_image_usage's map is keyed by, so the frontend
    // can join the two on this field alone.
    key: String,
    filename: String,
    // "local" | "r2"
    source: String,
    width: Option<u32>,
    height: Option<u32>,
    size_bytes: u64,
}

/// Every shared image physically stored in static/images/ - NOT a recursive
/// scan of all of static/ (that also holds non-image assets, favicons, CSS,
/// etc. this page has no business listing).
#[tauri::command]
pub fn list_local_shared_images() -> Vec<MediaImage> {
    let dir = site_dir().join(zola::STATIC_DIR).join("images");
    let mut paths = Vec::new();
    collect_images(&dir, &mut paths);

    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(filename) = path.file_name().and_then(|f| f.to_str()) else { continue };
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let (width, height) = image::image_dimensions(&path).map(|(w, h)| (Some(w), Some(h))).unwrap_or((None, None));
        out.push(MediaImage {
            key: format!("images/{filename}"),
            filename: filename.to_string(),
            source: "local".to_string(),
            width,
            height,
            size_bytes,
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    out
}

/// Empty (not an error) when R2 isn't configured/enabled for this
/// installation - the Media page just shows nothing from that source, same
/// as how the R2 upload placement option quietly falls back to local
/// storage when it isn't configured (see images.rs's own use_r2 check).
#[tauri::command]
pub fn list_r2_images(
    r2_site: State<R2SiteConfigState>,
    r2_personal: State<R2PersonalConfigState>,
) -> Result<Vec<MediaImage>, String> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let personal_cfg = r2_personal.0.lock().unwrap().clone();
    if !r2_fully_configured(&site_cfg, &personal_cfg) {
        return Ok(Vec::new());
    }

    let bucket = crate::r2::r2_bucket(&site_cfg, &personal_cfg)?;
    let pages = bucket.list("images/".to_string(), None).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for page in pages {
        for obj in page.contents {
            let filename = obj.key.rsplit('/').next().unwrap_or(&obj.key).to_string();
            out.push(MediaImage {
                key: obj.key,
                filename,
                source: "r2".to_string(),
                width: None,
                height: None,
                size_bytes: obj.size,
            });
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageUsage {
    // Content files (posts/pages) referencing this image - informational,
    // shown as "Used on N pages".
    content_refs: Vec<String>,
    // Template files referencing this image - a hardcoded logo/header image
    // a content-only scan would never see. Any entry here means "Required":
    // the same hard-block treatment as a protected tag, see
    // find_taxonomy_term_template_refs.
    template_refs: Vec<String>,
}

/// A canonical key (matching MediaImage's own, above) for whichever shared
/// image `url` resolves to, or None if `url` isn't a shared image at all -
/// a page-bundle-relative path, or a genuinely external URL ("Insert image
/// from a web link"), neither of which this page tracks.
fn canonical_key_for_url(url: &str, r2_site_cfg: &crate::r2::R2SiteConfig) -> Option<String> {
    if let Some(rest) = url.strip_prefix("/images/") {
        return Some(format!("images/{rest}"));
    }
    r2_key_from_url(r2_site_cfg, url)
}

/// The one piece of logic the whole Media page's "Unused"/"Required"
/// distinction depends on: generalizes delete_content's own extract_image_
/// urls (content-only, one file at a time) into a site-wide index across
/// EVERY content file AND EVERY template file. Skipping the template half
/// would make "Unused" actively unsafe rather than just incomplete - a
/// template-hardcoded logo would falsely show as deletable.
#[tauri::command]
pub fn scan_image_usage(r2_site: State<R2SiteConfigState>) -> HashMap<String, ImageUsage> {
    let r2_site_cfg = r2_site.0.lock().unwrap().clone();
    let dir = site_dir();
    let mut usage: HashMap<String, ImageUsage> = HashMap::new();

    let mut content_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut content_paths);
    for rel in content_paths {
        let Ok(text) = std::fs::read_to_string(dir.join(&rel)) else { continue };
        for url in extract_image_urls(&text) {
            if let Some(key) = canonical_key_for_url(&url, &r2_site_cfg) {
                usage.entry(key).or_default().content_refs.push(rel.clone());
            }
        }
    }

    for rel in collect_template_files() {
        let Ok(text) = std::fs::read_to_string(dir.join(&rel)) else { continue };
        for url in extract_image_urls(&text) {
            if let Some(key) = canonical_key_for_url(&url, &r2_site_cfg) {
                usage.entry(key).or_default().template_refs.push(rel.clone());
            }
        }
    }

    usage
}

/// Deletes a LOCAL shared image by filename - deliberately scoped to just
/// static/images/, not a generic "delete anything" path like delete_content
/// is for content. `filename` only (not a path) since that's exactly what
/// list_local_shared_images's own key implies, and rules out any
/// directory-traversal surprise from a crafted path.
#[tauri::command]
pub fn delete_local_shared_image(filename: String) -> Result<(), String> {
    if filename.contains('/') || filename.contains('\\') || filename == ".." {
        return Err("Not a valid image filename.".to_string());
    }
    let path = site_dir().join(zola::STATIC_DIR).join("images").join(&filename);
    if !path.exists() {
        return Err("That image doesn't exist.".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Deletes an R2 image by its bare object key (the Media page already has
/// this from list_r2_images's own MediaImage.key) - a thin wrapper since
/// images.rs's existing delete_r2_image_by_url takes a full URL instead,
/// reconstructed from an inserted image's markdown reference, which this
/// page never has.
#[tauri::command]
pub fn delete_r2_shared_image(key: String, r2_site: State<R2SiteConfigState>, r2_personal: State<R2PersonalConfigState>) -> Result<(), String> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let personal_cfg = r2_personal.0.lock().unwrap().clone();
    delete_from_r2(&site_cfg, &personal_cfg, &key)
}
