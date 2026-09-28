//! Media library (pws-ply7): browsing and deleting SHARED images only -
//! anywhere under static/ locally, and R2. A page-bundle image ("with this
//! page only" placement, see images.rs) is deliberately excluded - it's
//! physically 1:1 with the one page whose directory it lives in, so a
//! "usage count" for it is meaningless (always "1, itself"), and it already
//! gets cleaned up automatically when delete_content removes that bundle.
//! The real problem this module exists for - a stray upload nothing
//! references anymore - only happens to a shared image.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;
use tauri::State;

use crate::content::extract_image_urls;
use crate::r2::{
    delete_from_r2, r2_bucket, r2_fully_configured, r2_key_from_url, r2_public_url_base, upload_to_r2, R2PersonalConfigState,
    R2SiteConfig, R2SiteConfigState,
};
use crate::site::{collect_files_with_ext, collect_template_files, resolve_site_path, site_dir, SelfWriteTracker};
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
    // Canonical key: for Local, the path relative to static/ itself (e.g.
    // "images/foo.jpg" for anything this app uploaded, but just as often
    // something else - "img/logo.png", "uploads/2019/photo.jpg" - for a
    // real site's pre-existing images, from before this app or migrated in
    // from elsewhere); for R2, the object key (e.g. "images/1700000000-
    // foo.jpg", see images.rs's own upload key format). The same shape
    // scan_image_usage's map is keyed by, so the frontend can join the two
    // on this field alone.
    key: String,
    filename: String,
    // "local" | "r2"
    source: String,
    width: Option<u32>,
    height: Option<u32>,
    size_bytes: u64,
}

/// Every shared image physically stored ANYWHERE under static/, not just
/// this app's own upload convention (static/images/) - a real site
/// commonly has images that predate this app entirely (hand-authored, or
/// migrated from somewhere else) living in a differently-named or nested
/// subfolder. Found the hard way: an earlier version of this only looked
/// in static/images/ and quietly showed nothing for a real site with
/// images living elsewhere under static/. Non-image assets (CSS, JS,
/// fonts, favicons also living under static/) are naturally excluded by
/// the extension allowlist, not by only walking one subfolder.
#[tauri::command]
pub fn list_local_shared_images() -> Vec<MediaImage> {
    let static_dir = site_dir().join(zola::STATIC_DIR);
    let mut paths = Vec::new();
    collect_images(&static_dir, &mut paths);

    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(rel) = path.strip_prefix(&static_dir) else { continue };
        let key = rel.to_string_lossy().replace('\\', "/");
        let Some(filename) = path.file_name().and_then(|f| f.to_str()) else { continue };
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let (width, height) = image::image_dimensions(&path).map(|(w, h)| (Some(w), Some(h))).unwrap_or((None, None));
        out.push(MediaImage {
            key,
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
    if let Some(key) = r2_key_from_url(r2_site_cfg, url) {
        return Some(key);
    }
    // Any other site-root-relative path is served straight out of static/
    // at that same path (Zola convention) - not just this app's own
    // "images/" upload subfolder, since a real site's pre-existing images
    // can live anywhere under static/ (see list_local_shared_images).
    // Excludes a protocol-relative ("//") or genuinely external URL, and a
    // page-bundle-relative reference (which never starts with "/" at all).
    if url.starts_with('/') && !url.starts_with("//") {
        return Some(url.trim_start_matches('/').to_string());
    }
    None
}

/// The reverse of canonical_key_for_url - the actual reference string this
/// image's key resolves to in content/templates, for a given source. Local
/// keys are always "images/<filename>", served at site-root-relative
/// "/images/<filename>" (see images.rs's own "static" placement); R2 keys
/// are already the literal object key, served at the site's configured
/// public_url_base.
fn url_for_key(source: &str, key: &str, r2_site_cfg: &R2SiteConfig) -> String {
    if source == "r2" {
        format!("{}/{}", r2_public_url_base(r2_site_cfg).trim_end_matches('/'), key)
    } else {
        format!("/{key}")
    }
}

/// Whether ANY template (this site's own, or any vendored theme's)
/// references `key` by name - the same signal scan_image_usage's
/// template_refs already carries, but computed standalone (no content-file
/// pass needed) for rename_shared_image/move_shared_image, which only care
/// about this one boolean before deciding whether to proceed at all.
fn is_template_referenced(key: &str, r2_site_cfg: &R2SiteConfig) -> bool {
    let dir = site_dir();
    for rel in collect_template_files() {
        let Ok(text) = std::fs::read_to_string(dir.join(&rel)) else { continue };
        for url in extract_image_urls(&text) {
            if canonical_key_for_url(&url, r2_site_cfg).as_deref() == Some(key) {
                return true;
            }
        }
    }
    false
}

/// Replaces every occurrence of `old_url` with `new_url` across every
/// content file that has it - the same "find every content file, rewrite
/// it, register a self-write" shape as content.rs's rewrite_tag, applied to
/// an image reference instead of a tag string. A plain string replace
/// (not a regex-scoped one) is safe here since a real image URL/path is
/// specific enough not to collide with unrelated text, matching how
/// rewrite_tag itself doesn't need anything fancier either.
fn rewrite_image_references(old_url: &str, new_url: &str, tracker: &State<SelfWriteTracker>) -> Result<usize, String> {
    let dir = site_dir();
    let mut content_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut content_paths);

    let mut changed = 0;
    for rel in content_paths {
        let full = dir.join(&rel);
        let Ok(text) = std::fs::read_to_string(&full) else { continue };
        if !text.contains(old_url) {
            continue;
        }
        let updated = text.replace(old_url, new_url);
        tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
        std::fs::write(&full, updated).map_err(|e| e.to_string())?;
        changed += 1;
    }
    Ok(changed)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocateResult {
    new_key: String,
    files_updated: usize,
}

/// Renames a shared image in place (same source, new filename) - blocked
/// only when a template references it by name, since a template can't be
/// safely auto-edited the way a content file can (see rewrite_image_
/// references). Every content-file reference is updated as part of the
/// same operation, the same guarantee a tag rename already gives.
#[tauri::command]
pub fn rename_shared_image(
    old_key: String,
    source: String,
    new_filename: String,
    r2_site: State<R2SiteConfigState>,
    r2_personal: State<R2PersonalConfigState>,
    tracker: State<SelfWriteTracker>,
) -> Result<RelocateResult, String> {
    if new_filename.is_empty() || new_filename.contains('/') || new_filename.contains('\\') {
        return Err("Not a valid filename.".to_string());
    }
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let personal_cfg = r2_personal.0.lock().unwrap().clone();

    if is_template_referenced(&old_key, &site_cfg) {
        return Err(
            "This image is referenced by name in a template - rename or edit that template's \
             reference first, or leave this image's name as-is."
                .to_string(),
        );
    }

    let old_url = url_for_key(&source, &old_key, &site_cfg);
    let new_key = if source == "r2" {
        let new_key = format!("images/{new_filename}");
        let bucket = r2_bucket(&site_cfg, &personal_cfg)?;
        let bytes = bucket.get_object(&old_key).map_err(|e| e.to_string())?;
        upload_to_r2(&site_cfg, &personal_cfg, &new_key, bytes.as_slice())?;
        delete_from_r2(&site_cfg, &personal_cfg, &old_key)?;
        new_key
    } else {
        let static_dir = site_dir().join(zola::STATIC_DIR);
        let old_path = static_dir.join(&old_key);
        // Same subfolder the image was already in, just a new filename -
        // not necessarily static/images/, since a real site's images can
        // live anywhere under static/ (see list_local_shared_images).
        let parent = old_path.parent().ok_or_else(|| "invalid image path".to_string())?;
        let new_path = parent.join(&new_filename);
        if new_path.exists() {
            return Err(format!("A local image named \"{new_filename}\" already exists in that same folder."));
        }
        std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
        new_path
            .strip_prefix(&static_dir)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(new_filename.clone())
    };

    let new_url = url_for_key(&source, &new_key, &site_cfg);
    let files_updated = rewrite_image_references(&old_url, &new_url, &tracker)?;
    Ok(RelocateResult { new_key, files_updated })
}

/// Moves a shared image between local storage and R2, keeping its filename
/// (erroring rather than silently overwriting if that name is already
/// taken at the destination) - same template-referenced hard-block and
/// automatic content-reference rewrite as rename_shared_image, since a
/// move is really "rename to a different location kind".
#[tauri::command]
pub fn move_shared_image(
    old_key: String,
    source: String,
    r2_site: State<R2SiteConfigState>,
    r2_personal: State<R2PersonalConfigState>,
    tracker: State<SelfWriteTracker>,
) -> Result<RelocateResult, String> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let personal_cfg = r2_personal.0.lock().unwrap().clone();

    if is_template_referenced(&old_key, &site_cfg) {
        return Err(
            "This image is referenced by name in a template - it can't be moved without \
             breaking that reference."
                .to_string(),
        );
    }

    let old_url = url_for_key(&source, &old_key, &site_cfg);
    let filename = old_key.rsplit('/').next().unwrap_or(&old_key).to_string();
    let new_source = if source == "r2" { "local" } else { "r2" };

    let new_key = if source == "local" {
        if !r2_fully_configured(&site_cfg, &personal_cfg) {
            return Err(
                "R2 isn't configured for this installation yet (Settings \u{2192} This \
                 installation \u{2192} Image uploads)."
                    .to_string(),
            );
        }
        // old_key is already the full path relative to static/ (e.g.
        // "img/logo.png" for something that predates this app, not
        // necessarily "images/..."), so it's read from exactly where
        // list_local_shared_images found it, not assumed to live in
        // static/images/.
        let path = site_dir().join(zola::STATIC_DIR).join(&old_key);
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        // R2 has no real subfolder-browsing concept the way static/ does -
        // every upload this app makes to R2 already uses the "images/"
        // prefix (see images.rs), so moving TO R2 adopts that same
        // convention regardless of which local subfolder the original
        // lived in.
        let new_key = format!("images/{filename}");
        upload_to_r2(&site_cfg, &personal_cfg, &new_key, &bytes)?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        new_key
    } else {
        // Mirrors the R2 key's own structure locally (an "images/..." key,
        // which is what every R2 upload this app makes already uses,
        // lands in static/images/) rather than hardcoding that subfolder
        // independently of what old_key actually says.
        let static_dir = site_dir().join(zola::STATIC_DIR);
        let dest_path = static_dir.join(&old_key);
        let parent = dest_path.parent().ok_or_else(|| "invalid image path".to_string())?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if dest_path.exists() {
            return Err(format!("A local image named \"{filename}\" already exists - rename one of them first."));
        }
        let bucket = r2_bucket(&site_cfg, &personal_cfg)?;
        let bytes = bucket.get_object(&old_key).map_err(|e| e.to_string())?;
        std::fs::write(&dest_path, bytes.as_slice()).map_err(|e| e.to_string())?;
        delete_from_r2(&site_cfg, &personal_cfg, &old_key)?;
        old_key.clone()
    };

    let new_url = url_for_key(new_source, &new_key, &site_cfg);
    let files_updated = rewrite_image_references(&old_url, &new_url, &tracker)?;
    Ok(RelocateResult { new_key, files_updated })
}

// Markdown `![alt](url)` and this app's own `<img src="url" alt="alt" ...>`
// form, WITH alt text captured (unlike content.rs's own MD_IMAGE_RE/
// HTML_IMAGE_RE, which deliberately only capture the URL - see that
// module's own comment on why). Kept separate rather than changing those:
// their only other caller (scan_image_usage, via extract_image_urls) has
// no use for alt text, and changing their capture-group shape would be a
// silent footgun for that call site.
static MD_IMAGE_ALT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\(([^)\s]+)\)").unwrap());
static HTML_IMAGE_ALT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<img src="([^"]*)" alt="([^"]*)""#).unwrap());

/// The alt text of the FIRST occurrence of `url` in `text`, checking the
/// markdown form before the HTML form - None if `url` isn't referenced in
/// this text at all.
fn alt_text_for_url(text: &str, url: &str) -> Option<String> {
    for m in MD_IMAGE_ALT_RE.captures_iter(text) {
        if &m[2] == url {
            return Some(m[1].to_string());
        }
    }
    for m in HTML_IMAGE_ALT_RE.captures_iter(text) {
        if &m[1] == url {
            return Some(m[2].to_string());
        }
    }
    None
}

/// Splices `new_alt` into the FIRST occurrence of `url` in `text`, touching
/// only that occurrence's alt-text span - everything else in the file
/// (including any other occurrence of the same image, if it somehow
/// appears twice) is left byte-for-byte untouched. None if `url` isn't
/// referenced in this text at all.
fn replace_alt_for_url(text: &str, url: &str, new_alt: &str) -> Option<String> {
    for m in MD_IMAGE_ALT_RE.captures_iter(text) {
        if &m[2] == url {
            let span = m.get(1).unwrap();
            return Some(format!("{}{}{}", &text[..span.start()], new_alt, &text[span.end()..]));
        }
    }
    for m in HTML_IMAGE_ALT_RE.captures_iter(text) {
        if &m[1] == url {
            let span = m.get(2).unwrap();
            return Some(format!("{}{}{}", &text[..span.start()], new_alt, &text[span.end()..]));
        }
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAltUsage {
    content_file: String,
    alt: String,
}

/// Every content file that references this image, each with its own alt
/// text - alt text lives per usage in the markdown, not as one property of
/// the file, so a shared image used on several pages can (and often
/// should) describe itself differently in each place. Empty when the
/// image has no content-file usages at all (the frontend disables "Edit
/// alt text" in that case, per pws-ply7's design).
#[tauri::command]
pub fn list_image_alt_text_usages(key: String, source: String, r2_site: State<R2SiteConfigState>) -> Vec<ImageAltUsage> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let url = url_for_key(&source, &key, &site_cfg);
    let dir = site_dir();

    let mut content_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut content_paths);

    let mut out = Vec::new();
    for rel in content_paths {
        let Ok(text) = std::fs::read_to_string(dir.join(&rel)) else { continue };
        if let Some(alt) = alt_text_for_url(&text, &url) {
            out.push(ImageAltUsage { content_file: rel, alt });
        }
    }
    out
}

/// Rewrites just one content file's alt text for this image - not a
/// site-wide rewrite like rewrite_image_references, since alt text is
/// meant to differ per usage (see list_image_alt_text_usages).
#[tauri::command]
pub fn set_image_alt_text(
    content_file: String,
    key: String,
    source: String,
    new_alt: String,
    r2_site: State<R2SiteConfigState>,
    tracker: State<SelfWriteTracker>,
) -> Result<(), String> {
    let site_cfg = r2_site.0.lock().unwrap().clone();
    let url = url_for_key(&source, &key, &site_cfg);
    let full = resolve_site_path(&content_file)?;
    let text = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let updated = replace_alt_for_url(&text, &url, &new_alt)
        .ok_or_else(|| "Couldn't find that image's reference in this file - it may have changed.".to_string())?;
    tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
    std::fs::write(&full, updated).map_err(|e| e.to_string())
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

/// Deletes a LOCAL shared image by its key (the path relative to static/ -
/// list_local_shared_images's own MediaImage.key, e.g. "images/foo.jpg" or
/// "img/logo.png") - deliberately scoped to inside static/ specifically,
/// not a generic "delete anything" path like delete_content is for
/// content. Rejects any ".." path component so a crafted key can't escape
/// static/ itself, while still allowing the real subfolder nesting a
/// site's pre-existing images can have (see list_local_shared_images).
#[tauri::command]
pub fn delete_local_shared_image(key: String) -> Result<(), String> {
    if Path::new(&key).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Not a valid image path.".to_string());
    }
    let path = site_dir().join(zola::STATIC_DIR).join(&key);
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
