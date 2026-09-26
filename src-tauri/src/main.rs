#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod zola;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::{imageops::FilterType, ImageFormat, ImageReader};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const PREVIEW_LABEL: &str = "preview";
// "idiomatic average web page" desktop viewport, and a common phone reference size.
const DESKTOP_PREVIEW_SIZE: (f64, f64) = (1280.0, 800.0);
const PHONE_PREVIEW_SIZE: (f64, f64) = (390.0, 844.0);

/// Tracks when this app last wrote each path itself, per-path (not a single
/// global timestamp - with multiple tabs open, saving one file must not
/// suppress a genuine external-edit notification for a different one), so the
/// file watcher can tell "the user's own save" apart from a real external edit.
struct SelfWriteTracker(Mutex<HashMap<PathBuf, Instant>>);

/// Every file currently open in a tab, so the watcher (which covers the whole
/// site, not just content/) knows which changed paths are worth telling the
/// frontend about - anything not open in some tab is irrelevant to it.
struct OpenFiles(Mutex<HashSet<PathBuf>>);

struct ServeState(Mutex<Option<CommandChild>>);

/// The live content watcher, shared so `set_site_dir` can retarget it (unwatch
/// the old site, watch the new one) instead of it silently continuing to
/// watch a directory the app no longer edits.
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

const CONFIG_FILE_NAME: &str = "site_dir";

/// Platform-correct config dir (XDG_CONFIG_HOME/.config on Linux, ~/Library/
/// Application Support on macOS, %APPDATA% on Windows), not a hardcoded
/// ~/.config - this app runs on all three.
fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("beedance-ssg-editor"))
}

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(750);

/// Resolves which site this app edits: $BEEDANCE_SITE_DIR env var if set (quick
/// override for testing), else the path recorded by `just set-site` /
/// scripts/set-site.sh / the in-app "Change site" picker (see config_dir()),
/// else the bundled sample-site/ so the existing dev/spike workflow keeps
/// working with no setup.
fn site_dir() -> PathBuf {
    if let Ok(path) = std::env::var("BEEDANCE_SITE_DIR") {
        return PathBuf::from(path);
    }

    if let Some(dir) = config_dir() {
        let config_path = dir.join(CONFIG_FILE_NAME);
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sample-site")
}

#[tauri::command]
fn get_site_dir() -> String {
    site_dir().to_string_lossy().to_string()
}

/// Lets the frontend ask whether a content path is already a Zola bundle
/// page/section (see zola::is_bundle_page) instead of hand-copying that
/// convention in JS - a duplicated copy of exactly this check is what caused
/// the site-root-renaming bug found while testing image insertion.
#[tauri::command]
fn is_bundle_page(path: String) -> Result<bool, String> {
    let full = resolve_site_path(&path)?;
    Ok(zola::is_bundle_page(&full))
}

/// Best-effort front matter block (the text between the opening and closing
/// `+++`/`---` delimiter) - not a real TOML/YAML parser, just enough to read
/// a `slug`/`path` override for resolve_preview_path below.
fn front_matter_block(raw: &str) -> Option<&str> {
    let trimmed = raw.trim_start();
    for delim in ["+++", "---"] {
        if let Some(after) = trimmed.strip_prefix(delim) {
            let after = after.strip_prefix('\n').unwrap_or(after);
            if let Some(end) = after.find(&format!("\n{delim}")) {
                return Some(&after[..end]);
            }
        }
    }
    None
}

fn front_matter_field(block: &str, field: &str) -> Option<String> {
    for line in block.lines() {
        if let Some((key, value)) = line.split_once('=').or_else(|| line.split_once(':')) {
            if key.trim() == field {
                return Some(value.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    None
}

/// Guesses the URL a content file resolves to under Zola's default routing
/// (content path mirrors the URL path, `index.md`/`_index.md` drop out of
/// it) so "Start preview" can jump straight to the page being edited. Only
/// handles a `slug`/`path` front matter override on top of that - not
/// taxonomies, pagination, or a custom `[[extra]]`-driven routing scheme, so
/// an unusual page may still land on the wrong URL. Only used internally by
/// zola_serve - not registered as its own Tauri command.
fn resolve_preview_path(content_path: String) -> Option<String> {
    let content_prefix = format!("{}/", zola::CONTENT_DIR);
    let rel = content_path.strip_prefix(&content_prefix)?;
    let rel_path = Path::new(rel);

    let file_name = rel_path.file_name()?.to_str()?;
    let mut segments: Vec<String> = rel_path
        .parent()
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();

    if file_name != "index.md" && file_name != "_index.md" {
        segments.push(rel_path.file_stem()?.to_str()?.to_string());
    }

    if let Ok(full) = resolve_site_path(&content_path) {
        if let Ok(raw) = std::fs::read_to_string(&full) {
            if let Some(block) = front_matter_block(&raw) {
                if let Some(path_override) = front_matter_field(block, "path") {
                    return Some(format!("/{}/", path_override.trim_matches('/')));
                }
                if let Some(slug) = front_matter_field(block, "slug") {
                    if let Some(last) = segments.last_mut() {
                        *last = slug;
                    } else {
                        segments.push(slug);
                    }
                }
            }
        }
    }

    Some(if segments.is_empty() { "/".to_string() } else { format!("/{}/", segments.join("/")) })
}

/// Points the app at a different site directory from the in-app folder
/// picker, mirroring scripts/set-site.sh (same config file, same
/// missing-config.toml warning) but also retargeting the live content
/// watcher, which scripts/set-site.sh never had to worry about since it only
/// ever ran before the app started.
#[tauri::command]
fn set_site_dir(
    path: String,
    watcher_state: tauri::State<WatcherState>,
    open_files: tauri::State<OpenFiles>,
    tracker: tauri::State<SelfWriteTracker>,
) -> Result<String, String> {
    if std::env::var("BEEDANCE_SITE_DIR").is_ok() {
        return Err("BEEDANCE_SITE_DIR env var is set and overrides this - unset it to use the site switcher".to_string());
    }

    let new_dir = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !new_dir.is_dir() {
        return Err(format!("not a directory: {}", new_dir.display()));
    }

    let old_dir = site_dir();

    let config_dir = config_dir().ok_or_else(|| "could not resolve a config directory for this platform".to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    std::fs::write(config_dir.join(CONFIG_FILE_NAME), new_dir.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;

    if let Some(watcher) = watcher_state.0.lock().unwrap().as_mut() {
        let _ = watcher.unwatch(&old_dir);
        watcher.watch(&new_dir, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    }

    // Stale entries from the old site are harmless (their paths can't collide
    // with the new site's), but clearing them keeps these maps from growing
    // forever across repeated site switches.
    open_files.0.lock().unwrap().clear();
    tracker.0.lock().unwrap().clear();

    let mut message = new_dir.to_string_lossy().to_string();
    if !zola::looks_like_site(&new_dir) {
        message.push_str(" (warning: no config.toml found there - is this actually a Zola site directory?)");
    }
    Ok(message)
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = StdCommand::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// The site being edited is its own independent git repo, separate from this
/// app's repo - a "draft" is a branch on that repo, so cutting one must never
/// touch (or be confused with) beedance-ssg-editor's own source-controlled
/// branch. Also inits a fresh repo here if the site doesn't have one yet
/// (e.g. a brand-new site directory), so this is safe to call for either.
fn ensure_site_repo() -> Result<(), String> {
    let dir = site_dir();
    if dir.join(".git").exists() {
        return Ok(());
    }
    run_git(&dir, &["init"])?;
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", "Initial content"])?;
    Ok(())
}

/// Resolves a site-relative path (e.g. "content/_index.md",
/// "templates/index.html") to a real path under the current site directory,
/// rejecting anything absolute or containing ".." components. Lexical only
/// (not canonicalize-based symlink-proof) - adequate for a local single-user
/// spike, not a hardening guarantee.
fn resolve_site_path(relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("invalid path: {}", relative));
    }
    Ok(site_dir().join(rel))
}

fn collect_files_with_ext(dir: &Path, root: &Path, ext: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_with_ext(&path, root, ext, out);
        } else if path.extension().is_some_and(|e| e == ext) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Lists every .md file under content/ (every page/post in the site, however
/// many there are), plus every .html template under the site's own templates/
/// (if any) and any vendored theme's templates/ (themes/*/templates/), so the
/// editor's file switcher covers a real multi-page site, not just one file.
#[tauri::command]
fn list_editable_files() -> Vec<String> {
    let dir = site_dir();
    let mut files = Vec::new();

    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut files);
    collect_files_with_ext(&dir.join(zola::TEMPLATES_DIR), &dir, zola::TEMPLATE_EXT, &mut files);

    if let Ok(entries) = std::fs::read_dir(dir.join(zola::THEMES_DIR)) {
        for entry in entries.flatten() {
            collect_files_with_ext(&entry.path().join(zola::TEMPLATES_DIR), &dir, zola::TEMPLATE_EXT, &mut files);
        }
    }

    files.sort();
    files
}

#[tauri::command]
fn read_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    open_files.0.lock().unwrap().insert(full);
    Ok(content)
}

/// Called when a tab closes, so the watcher stops caring about that path -
/// otherwise an external edit to a file with no open tab would still (and
/// shouldn't) trigger a change notification.
#[tauri::command]
fn close_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    open_files.0.lock().unwrap().remove(&full);
    Ok(())
}

#[tauri::command]
fn write_file(path: String, content: String, tracker: tauri::State<SelfWriteTracker>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    // Mark the self-write window for THIS path BEFORE writing, not after: the
    // watcher thread runs concurrently and must never be able to observe the
    // resulting fs event before this timestamp is in place, or it reads as
    // external. Keyed per-path so saving one open tab never suppresses a
    // genuine external-edit notification for a different one.
    tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
    std::fs::write(full, content).map_err(|e| e.to_string())
}

// Saved presets the frontend offers when inserting an image - not the only
// choice available there (insert_image below takes an explicit width/height/
// quality, so any custom size works), just a quick-fill starting point.
// Deliberately two presets, not one: close-up nature/macro photography
// (this app's first real site is a bee/pollinator committee blog) genuinely
// needs more resolution than a typical web photo. User-adjustable (see
// get_tier_settings/set_tier_settings) since the right tradeoff depends on
// the site's own photos.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TierSettings {
    web_cap: u32,
    web_quality: u8,
    high_cap: u32,
    high_quality: u8,
}

impl Default for TierSettings {
    fn default() -> Self {
        // 1600 vs. an original 2000px cap: JPEG size roughly tracks pixel
        // area, so a 20% smaller linear dimension is ~36% smaller output.
        TierSettings {
            web_cap: 1600,
            web_quality: 80,
            high_cap: 4800,
            high_quality: 90,
        }
    }
}

const TIER_SETTINGS_FILE: &str = "image-tiers.json";

struct TierSettingsState(Mutex<TierSettings>);

fn load_tier_settings() -> TierSettings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(TIER_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_tier_settings(state: tauri::State<TierSettingsState>) -> TierSettings {
    *state.0.lock().unwrap()
}

#[tauri::command]
fn set_tier_settings(settings: TierSettings, state: tauri::State<TierSettingsState>) -> Result<(), String> {
    // Sane bounds so a typo can't produce a 0px image or a multi-hundred
    // megapixel one.
    if settings.web_cap == 0 || settings.high_cap == 0 || settings.web_cap > 10000 || settings.high_cap > 10000 {
        return Err("size must be between 1 and 10000px".to_string());
    }
    if !(1..=100).contains(&settings.web_quality) || !(1..=100).contains(&settings.high_quality) {
        return Err("quality must be between 1 and 100".to_string());
    }

    *state.0.lock().unwrap() = settings;

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(TIER_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }

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
struct InsertImageResult {
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
    r2_settings: tauri::State<'_, R2SettingsState>,
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
    let r2 = r2_settings.0.lock().unwrap().clone();
    let use_r2 = placement == "static" && r2.fully_configured();

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
            let r2 = r2.clone();
            let key = key.clone();
            let encoded_bytes = encoded_bytes.clone();
            move || upload_to_r2(&r2, &key, &encoded_bytes)
        };
        tauri::async_runtime::spawn_blocking(upload)
            .await
            .map_err(|e| e.to_string())??;

        format!("{}/{key}", r2.public_url_base.trim_end_matches('/'))
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
async fn insert_image(
    source_path: String,
    width: u32,
    height: u32,
    quality: u8,
    placement: String,
    current_content_path: String,
    tracker: tauri::State<'_, SelfWriteTracker>,
    open_files: tauri::State<'_, OpenFiles>,
    r2_settings: tauri::State<'_, R2SettingsState>,
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
        r2_settings,
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
async fn localize_remote_image(
    url: String,
    width: u32,
    height: u32,
    quality: u8,
    placement: String,
    current_content_path: String,
    tracker: tauri::State<'_, SelfWriteTracker>,
    open_files: tauri::State<'_, OpenFiles>,
    r2_settings: tauri::State<'_, R2SettingsState>,
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
        r2_settings,
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
async fn resize_image_in_place(path: String, width: u32, height: u32) -> Result<(), String> {
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
async fn get_image_dimensions(path: String) -> Result<(u32, u32), String> {
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
fn read_image_preview(path: String) -> Result<String, String> {
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

/// Watches the whole site tree and emits "content-file-changed" (with the
/// changed path as payload) whenever a file that's open in some tab (per
/// OpenFiles) is touched from outside the app (e.g. an agent editing in the
/// background, or another editor). Detection only for this spike - no
/// auto-reload or merge, that's future work.
fn spawn_content_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

        if watcher.watch(&site_dir(), RecursiveMode::Recursive).is_err() {
            return;
        }

        // Handed off to shared state so set_site_dir (running on a command
        // thread) can unwatch/rewatch when the edited site changes - this
        // thread only needs `rx` from here on.
        app.state::<WatcherState>().0.lock().unwrap().replace(watcher);

        for res in rx {
            let Ok(event) = res else { continue };
            let open_files = app.state::<OpenFiles>();
            let changed_open_paths: Vec<PathBuf> = {
                let open = open_files.0.lock().unwrap();
                event.paths.iter().filter(|p| open.contains(*p)).cloned().collect()
            };

            for path in changed_open_paths {
                let tracker = app.state::<SelfWriteTracker>();
                let is_self_write = tracker
                    .0
                    .lock()
                    .unwrap()
                    .get(&path)
                    .is_some_and(|t| t.elapsed() < SELF_WRITE_WINDOW);
                if !is_self_write {
                    if let Ok(rel) = path.strip_prefix(site_dir()) {
                        let _ = app.emit("content-file-changed", rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
    });
}

fn slugify(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

#[tauri::command]
async fn zola_version(app: tauri::AppHandle) -> Result<String, String> {
    let sidecar = app.shell().sidecar("zola").map_err(|e| e.to_string())?;
    let output = sidecar
        .args(["--version"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_status() -> Result<String, String> {
    ensure_site_repo()?;
    let text = run_git(&site_dir(), &["status", "--short", "."])?;
    Ok(if text.trim().is_empty() { "(clean)".to_string() } else { text })
}

#[tauri::command]
fn git_commit(message: String) -> Result<String, String> {
    ensure_site_repo()?;
    let dir = site_dir();
    run_git(&dir, &["add", "."])?;
    run_git(&dir, &["commit", "-m", &message])
}

#[tauri::command]
fn current_branch() -> Result<String, String> {
    ensure_site_repo()?;
    let branch = run_git(&site_dir(), &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(branch.trim().to_string())
}

#[tauri::command]
fn start_draft(name: String) -> Result<String, String> {
    ensure_site_repo()?;
    let branch = format!("draft/{}", slugify(&name));
    run_git(&site_dir(), &["checkout", "-b", &branch])?;
    Ok(format!("Switched to new branch '{}'", branch))
}

/// Polls the port zola serve binds to rather than guessing a fixed delay -
/// spawn() returns as soon as the process starts, well before it's actually
/// listening, which is what caused the "Connection refused" race.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn open_or_focus_preview_window(app: &tauri::AppHandle, target_path: Option<&str>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        win.set_focus().map_err(|e| e.to_string())?;
        // Window's already open (e.g. hitting "Start preview" again after
        // switching tabs) - navigate its iframe rather than needing it
        // reopened, since the initial nav script below only runs on creation.
        if let Some(target) = target_path {
            let _ = win.emit("preview-navigate", target);
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App("preview.html".into()))
        .title("Preview")
        .inner_size(DESKTOP_PREVIEW_SIZE.0, DESKTOP_PREVIEW_SIZE.1);

    if let Some(target) = target_path {
        let target_json = serde_json::to_string(target).map_err(|e| e.to_string())?;
        builder = builder.initialization_script(&format!("window.__BEEDANCE_PREVIEW_TARGET__ = {target_json};"));
    }

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn zola_serve(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServeState>,
    network: bool,
    current_content_path: Option<String>,
) -> Result<String, String> {
    // Stop any previous instance first so repeated clicks don't fight over the port.
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }

    let mut args = vec!["serve".to_string()];
    if network {
        // Binding 0.0.0.0 still answers on 127.0.0.1 too, so wait_for_port
        // below needs no change. base-url also needs to follow, or asset/
        // live-reload URLs Zola injects stay pinned to 127.0.0.1 and silently
        // fail to load from another device on the LAN (per Zola's own docs).
        let lan_ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;
        args.push("--interface".to_string());
        args.push("0.0.0.0".to_string());
        args.push("--base-url".to_string());
        args.push(format!("http://{lan_ip}:{}", zola::DEFAULT_SERVE_PORT));
    }

    let sidecar = app.shell().sidecar("zola").map_err(|e| e.to_string())?;
    let (mut rx, child) = sidecar
        .current_dir(site_dir())
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(child);

    // Forward zola's own stdout/stderr to the frontend instead of discarding
    // it - a failed start (e.g. a configured theme that was never vendored)
    // otherwise just looks like an unexplained connection-refused later.
    let log_app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    Some(String::from_utf8_lossy(&bytes).to_string())
                }
                CommandEvent::Error(err) => Some(format!("error: {err}")),
                CommandEvent::Terminated(payload) => Some(format!("zola serve exited: {payload:?}")),
                _ => None,
            };
            if let Some(line) = line {
                let _ = log_app.emit("zola-log", line);
            }
        }
    });

    // wait_for_port's polling loop uses a blocking std::thread::sleep - this
    // command runs on the main thread by default (it wasn't `async fn`
    // before), so that loop used to freeze the whole app's UI for up to 5s
    // every time preview started. spawn_blocking moves it off the main
    // thread; the command staying `async fn` is what makes that possible.
    let port_ready = tauri::async_runtime::spawn_blocking(|| wait_for_port(zola::DEFAULT_SERVE_PORT, Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?;
    if !port_ready {
        return Err(format!(
            "zola serve did not start listening on 127.0.0.1:{} within 5s - check the log panel below for the actual error",
            zola::DEFAULT_SERVE_PORT
        ));
    }
    let target_path = current_content_path.and_then(resolve_preview_path);
    open_or_focus_preview_window(&app, target_path.as_deref())?;

    if network {
        let lan_ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;
        Ok(format!(
            "zola serve started on http://127.0.0.1:{0} (also reachable on your network at http://{lan_ip}:{0})",
            zola::DEFAULT_SERVE_PORT
        ))
    } else {
        Ok(format!("zola serve started on http://127.0.0.1:{}", zola::DEFAULT_SERVE_PORT))
    }
}

/// Best-guess LAN IP for this machine, so the Settings panel can show a
/// clickable-looking address before the user even starts the preview server.
#[tauri::command]
fn get_lan_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn zola_stop(app: tauri::AppHandle, state: tauri::State<ServeState>) -> Result<String, String> {
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = win.close();
    }

    match state.0.lock().unwrap().take() {
        Some(child) => {
            child.kill().map_err(|e| e.to_string())?;
            Ok("stopped".to_string())
        }
        None => Ok("nothing running".to_string()),
    }
}

#[tauri::command]
fn set_preview_phone_mode(app: tauri::AppHandle, phone: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(PREVIEW_LABEL)
        .ok_or_else(|| "preview window is not open".to_string())?;
    let (w, h) = if phone { PHONE_PREVIEW_SIZE } else { DESKTOP_PREVIEW_SIZE };
    win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())
}

fn main() {
    // Both ureq and rust-s3 pull in rustls transitively; with more than one
    // in the dependency graph, rustls refuses to guess which crypto backend
    // to use and panics on first TLS use unless told explicitly, once, up
    // front - this must run before any HTTPS request anywhere in this app
    // (found the hard way via beedance-cli's own real-world test-upload run).
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServeState(Mutex::new(None)))
        .manage(SelfWriteTracker(Mutex::new(HashMap::new())))
        .manage(OpenFiles(Mutex::new(HashSet::new())))
        .manage(WatcherState(Mutex::new(None)))
        .manage(TierSettingsState(Mutex::new(load_tier_settings())))
        .manage(R2SettingsState(Mutex::new(load_r2_settings())))
        .setup(|app| {
            spawn_content_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window should take the preview (window + zola
            // serve process) down with it, not leave it orphaned.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<ServeState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                if let Some(preview) = app.get_webview_window(PREVIEW_LABEL) {
                    let _ = preview.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            zola_version,
            git_status,
            git_commit,
            current_branch,
            start_draft,
            zola_serve,
            zola_stop,
            set_preview_phone_mode,
            list_editable_files,
            get_site_dir,
            set_site_dir,
            read_file,
            close_file,
            write_file,
            insert_image,
            read_image_preview,
            get_lan_ip,
            is_bundle_page,
            get_tier_settings,
            set_tier_settings,
            resize_image_in_place,
            get_image_dimensions,
            localize_remote_image,
            get_r2_settings,
            set_r2_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// R2 (or any S3-compatible store, in principle) as an ADDITIONAL image
// placement alongside "static"/"bundle", not a replacement - see pws-vpb.
// Real, tested against a live account (not just a compile spike): put_object
// only correctly returns Err on a bad request when rust-s3's "fail-on-err"
// feature is enabled - found the hard way when a corrupted credential
// silently "succeeded" with fail-on-err missing from the feature set.
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct R2Settings {
    enabled: bool,
    account_id: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    // The URL a browser actually fetches the image from (a custom domain or
    // the bucket's r2.dev dev URL) - NOT the same host as the S3-compatible
    // API endpoint (<account>.r2.cloudflarestorage.com), which only accepts
    // authenticated requests.
    public_url_base: String,
}

impl R2Settings {
    fn fully_configured(&self) -> bool {
        self.enabled
            && !self.account_id.is_empty()
            && !self.bucket.is_empty()
            && !self.access_key_id.is_empty()
            && !self.secret_access_key.is_empty()
            && !self.public_url_base.is_empty()
    }
}

const R2_SETTINGS_FILE: &str = "r2-settings.json";

struct R2SettingsState(Mutex<R2Settings>);

fn load_r2_settings() -> R2Settings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(R2_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_r2_settings(state: tauri::State<R2SettingsState>) -> R2Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_r2_settings(settings: R2Settings, state: tauri::State<R2SettingsState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(R2_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn upload_to_r2(settings: &R2Settings, key: &str, content: &[u8]) -> Result<(), String> {
    use s3::bucket::Bucket;
    use s3::creds::Credentials;
    use s3::region::Region;

    let region = Region::Custom {
        region: "auto".to_string(),
        endpoint: format!("https://{}.r2.cloudflarestorage.com", settings.account_id),
    };
    let credentials = Credentials::new(
        Some(&settings.access_key_id),
        Some(&settings.secret_access_key),
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    let bucket = Bucket::new(&settings.bucket, region, credentials).map_err(|e| e.to_string())?;

    bucket.put_object(key, content).map_err(|e| e.to_string())?;
    Ok(())
}
