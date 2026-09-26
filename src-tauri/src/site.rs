//! Site directory resolution/config, the file-open/save/list commands, and
//! the live filesystem watcher - everything about locating and moving bytes
//! for whichever site this app currently points at.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager};

use crate::frontmatter::{front_matter_block, front_matter_field};
use crate::zola;

/// Tracks when this app last wrote each path itself, per-path (not a single
/// global timestamp - with multiple tabs open, saving one file must not
/// suppress a genuine external-edit notification for a different one), so the
/// file watcher can tell "the user's own save" apart from a real external edit.
pub struct SelfWriteTracker(pub Mutex<HashMap<PathBuf, Instant>>);

/// Every file currently open in a tab, so the watcher (which covers the whole
/// site, not just content/) knows which changed paths are worth telling the
/// frontend about - anything not open in some tab is irrelevant to it.
pub struct OpenFiles(pub Mutex<HashSet<PathBuf>>);

/// The live content watcher, shared so `set_site_dir` can retarget it (unwatch
/// the old site, watch the new one) instead of it silently continuing to
/// watch a directory the app no longer edits.
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

const CONFIG_FILE_NAME: &str = "site_dir";
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(750);

/// Platform-correct config dir (XDG_CONFIG_HOME/.config on Linux, ~/Library/
/// Application Support on macOS, %APPDATA% on Windows), not a hardcoded
/// ~/.config - this app runs on all three.
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("beedance-ssg-editor"))
}

/// Resolves which site this app edits: $BEEDANCE_SITE_DIR env var if set (quick
/// override for testing), else the path recorded by `just set-site` /
/// scripts/set-site.sh / the in-app "Change site" picker (see config_dir()),
/// else the bundled sample-site/ so the existing dev/spike workflow keeps
/// working with no setup.
pub fn site_dir() -> PathBuf {
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
pub fn get_site_dir() -> String {
    site_dir().to_string_lossy().to_string()
}

/// Lets the frontend ask whether a content path is already a Zola bundle
/// page/section (see zola::is_bundle_page) instead of hand-copying that
/// convention in JS - a duplicated copy of exactly this check is what caused
/// the site-root-renaming bug found while testing image insertion.
#[tauri::command]
pub fn is_bundle_page(path: String) -> Result<bool, String> {
    let full = resolve_site_path(&path)?;
    Ok(zola::is_bundle_page(&full))
}

/// Points the app at a different site directory from the in-app folder
/// picker, mirroring scripts/set-site.sh (same config file, same
/// missing-config.toml warning) but also retargeting the live content
/// watcher, which scripts/set-site.sh never had to worry about since it only
/// ever ran before the app started.
#[tauri::command]
pub fn set_site_dir(
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

/// Resolves a site-relative path (e.g. "content/_index.md",
/// "templates/index.html") to a real path under the current site directory,
/// rejecting anything absolute or containing ".." components. Lexical only
/// (not canonicalize-based symlink-proof) - adequate for a local single-user
/// spike, not a hardening guarantee.
pub fn resolve_site_path(relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("invalid path: {}", relative));
    }
    Ok(site_dir().join(rel))
}

pub fn collect_files_with_ext(dir: &Path, root: &Path, ext: &str, out: &mut Vec<String>) {
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
pub fn list_editable_files() -> Vec<String> {
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

pub fn read_title(full: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(full).ok()?;
    let block = front_matter_block(&raw)?;
    front_matter_field(block, "title")
}

fn read_date(full: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(full).ok()?;
    let block = front_matter_block(&raw)?;
    front_matter_field(block, "date")
}

/// Whether the section at `section_index` (its _index.md) is a "blog
/// heading" - the same sort_by = "date" convention content.rs's
/// find_post_section/list_page_sections use to tell a dated, chronological
/// section (like Blog) apart from a free-form one (like Biodiversity).
fn section_is_blog_heading(section_index: &Path) -> bool {
    std::fs::read_to_string(section_index)
        .ok()
        .and_then(|raw| front_matter_block(&raw).and_then(|b| front_matter_field(b, "sort_by")))
        .as_deref()
        == Some("date")
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableFile {
    /// Site-relative path (unchanged) - what read_file/write_file/openTab
    /// actually use. The friendly label/group below are display-only.
    path: String,
    label: String,
    group: String,
    is_section_index: bool,
    date: Option<String>,
    /// True if this entry's section is a "blog heading" - the frontend uses
    /// this to sort a blog-heading group by date (matching the real site's
    /// own order) instead of alphabetically by title like every other group.
    is_blog_heading: bool,
}

/// Same files as list_editable_files, but with a friendly label (the page's
/// own title, falling back to its filename) and a group (its section's
/// title, or "Templates") for the file browser's "page titles" view, so
/// browsing feels like the site's real structure instead of raw content/
/// paths. Raw-path mode still uses list_editable_files directly; this is
/// purely additive.
#[tauri::command]
pub fn list_editable_files_detailed() -> Vec<EditableFile> {
    let dir = site_dir();
    let content_dir = dir.join(zola::CONTENT_DIR);

    let mut content_paths = Vec::new();
    collect_files_with_ext(&content_dir, &dir, zola::CONTENT_EXT, &mut content_paths);
    content_paths.sort();

    let mut out = Vec::with_capacity(content_paths.len());
    for rel in &content_paths {
        let full = dir.join(rel);
        let is_section_index = Path::new(rel).file_name().is_some_and(|f| f == "_index.md");
        let title = read_title(&full);

        let rel_to_content = Path::new(rel).strip_prefix(zola::CONTENT_DIR).unwrap_or(Path::new(rel));
        let parent = rel_to_content.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let section_index = content_dir.join(&parent).join("_index.md");

        let (group, label) = if is_section_index {
            let group = if parent.is_empty() { "Home".to_string() } else { title.clone().unwrap_or_else(|| parent.clone()) };
            (group, title.unwrap_or_else(|| format!("({parent})")))
        } else {
            let section_title = read_title(&section_index);
            let group = section_title.unwrap_or_else(|| if parent.is_empty() { "Home".to_string() } else { parent.clone() });
            let label = title.unwrap_or_else(|| {
                Path::new(rel).file_stem().map(|s| s.to_string_lossy().replace(['-', '_'], " ")).unwrap_or_else(|| rel.clone())
            });
            (group, label)
        };

        out.push(EditableFile {
            path: rel.clone(),
            label,
            group,
            is_section_index,
            date: read_date(&full),
            is_blog_heading: section_is_blog_heading(&section_index),
        });
    }

    let mut template_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::TEMPLATES_DIR), &dir, zola::TEMPLATE_EXT, &mut template_paths);
    if let Ok(entries) = std::fs::read_dir(dir.join(zola::THEMES_DIR)) {
        for entry in entries.flatten() {
            collect_files_with_ext(&entry.path().join(zola::TEMPLATES_DIR), &dir, zola::TEMPLATE_EXT, &mut template_paths);
        }
    }
    template_paths.sort();
    for rel in template_paths {
        out.push(EditableFile {
            label: rel.clone(),
            path: rel,
            group: "Templates".to_string(),
            is_section_index: false,
            date: None,
            is_blog_heading: false,
        });
    }

    out
}

#[tauri::command]
pub fn read_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    open_files.0.lock().unwrap().insert(full);
    Ok(content)
}

/// Called when a tab closes, so the watcher stops caring about that path -
/// otherwise an external edit to a file with no open tab would still (and
/// shouldn't) trigger a change notification.
#[tauri::command]
pub fn close_file(path: String, open_files: tauri::State<OpenFiles>) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    open_files.0.lock().unwrap().remove(&full);
    Ok(())
}

/// `datetime` (the frontend's local clock, same as create_post/
/// set_front_matter_date) stamps a Zola-native `updated` front-matter field
/// on every save - a silent no-op via stamp_top_level_field if the file has
/// no front matter block at all (e.g. a template), since this command saves
/// both content and template files. Returns the actual bytes written so the
/// frontend can reflect the stamp back into its buffer.
#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    datetime: String,
    tracker: tauri::State<SelfWriteTracker>,
) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    let content = crate::frontmatter::stamp_top_level_field(&content, "updated", &datetime).unwrap_or(content);

    // Mark the self-write window for THIS path BEFORE writing, not after: the
    // watcher thread runs concurrently and must never be able to observe the
    // resulting fs event before this timestamp is in place, or it reads as
    // external. Keyed per-path so saving one open tab never suppresses a
    // genuine external-edit notification for a different one.
    tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
    std::fs::write(&full, &content).map_err(|e| e.to_string())?;
    Ok(content)
}

/// Watches the whole site tree and emits "content-file-changed" (with the
/// changed path as payload) whenever a file that's open in some tab (per
/// OpenFiles) is touched from outside the app (e.g. an agent editing in the
/// background, or another editor). Detection only for this spike - no
/// auto-reload or merge, that's future work.
pub fn spawn_content_watcher(app: tauri::AppHandle) {
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
