//! Page/post creation, front-matter date editing, and the preview-jump URL
//! guess - the layer that combines frontmatter.rs's text parsing with
//! site.rs's knowledge of where the site actually lives.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use regex::Regex;

use crate::frontmatter::{
    append_author, content_slug, format_toml_string_array, front_matter_block, front_matter_field, front_matter_lines,
    parse_toml_string_array, reassemble, stamp_table_field, stamp_top_level_field,
};
use crate::r2::{R2PersonalConfigState, R2SiteConfigState};
use crate::site::{collect_files_with_ext, config_dir, resolve_site_path, site_dir, OpenFiles, SelfWriteTracker};
use crate::zola;

/// A plain "who am I" display name, appended into `extra.authors` (see
/// frontmatter::append_author) when set - the frontend supplies it into
/// create_post/create_page/write_file the same way it supplies `datetime`,
/// rather than those commands reaching into this state themselves, so this
/// module stays the only thing that needs to know AuthorSettings exists at
/// all.
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorSettings {
    display_name: String,
}

const AUTHOR_SETTINGS_FILE: &str = "author-settings.json";

pub struct AuthorSettingsState(pub Mutex<AuthorSettings>);

pub fn load_author_settings() -> AuthorSettings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(AUTHOR_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_author_settings(state: tauri::State<AuthorSettingsState>) -> AuthorSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_author_settings(settings: AuthorSettings, state: tauri::State<AuthorSettingsState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(AUTHOR_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// Guesses the URL a content file resolves to under Zola's default routing
/// (content path mirrors the URL path, `index.md`/`_index.md` drop out of
/// it) so "Start preview" can jump straight to the page being edited. Only
/// handles a `slug`/`path` front matter override on top of that - not
/// taxonomies, pagination, or a custom `[[extra]]`-driven routing scheme, so
/// an unusual page may still land on the wrong URL. Only used internally by
/// zola_serve (preview.rs) - not registered as its own Tauri command.
pub fn resolve_preview_path(content_path: String) -> Option<String> {
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

/// Finds the site's "posts" section: whichever content/ section is
/// classified `heading_kind = "blog"` (or, lacking that, has
/// `sort_by = "date"` - Zola's own native convention for a dated/
/// chronological listing, and the fallback zola::heading_kind_of already
/// applies). Reusing an existing signal means "New post" has an
/// unambiguous place to look instead of guessing at a folder name like
/// "blog", which isn't guaranteed to exist or be named that.
fn find_post_section() -> Option<PathBuf> {
    fn walk(dir: &Path, found: &mut Option<PathBuf>) {
        if found.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.file_name().is_some_and(|f| f == "_index.md") {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if zola::heading_kind_of(&raw) == Some(zola::HeadingKind::Blog) {
                        *found = path.parent().map(Path::to_path_buf);
                    }
                }
            }
        }
    }

    let mut found = None;
    walk(&site_dir().join(zola::CONTENT_DIR), &mut found);
    found
}

/// Reads the `date` front-matter field straight out of the given text (the
/// live editor buffer, not necessarily what's on disk) - used to prefill the
/// date/time picker with whatever's actually in the tab right now, including
/// unsaved edits.
#[tauri::command]
pub fn get_front_matter_date(content: String) -> Option<String> {
    front_matter_field(front_matter_block(&content)?, "date")
}

/// Reads the `title` front-matter field straight out of the given text - used
/// to prefill the rename dialog with the page's actual current title rather
/// than guessing from its filename.
#[tauri::command]
pub fn get_front_matter_title(content: String) -> Option<String> {
    front_matter_field(front_matter_block(&content)?, "title")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentInfo {
    /// Some(name) if `template` overrides Zola's own default (page.html for
    /// a leaf page, section.html for a section index) - that template's own
    /// code, not this file's body, drives most or all of what actually
    /// renders (e.g. events/calendar.md: an empty body, template =
    /// "events-calendar.html" does all the real work).
    custom_template: Option<String>,
    /// A <script> tag pasted directly into the body (e.g. plant-safari's
    /// embedded widget) - real, editable text, but easy to break by editing
    /// it as if it were just prose.
    has_script_tag: bool,
}

/// Detects the two ways a content file's actual rendered page can be driven
/// by something other than what's visibly in this buffer - see pws-who's
/// investigation of events/calendar.md (empty body, all logic in its
/// template) and plant-safari/_index.md (a real embedded HTML/JS widget) on
/// the live site for the two real cases this covers.
#[tauri::command]
pub fn detect_external_content(content: String) -> ExternalContentInfo {
    let custom_template = front_matter_block(&content)
        .and_then(|b| front_matter_field(b, "template"))
        .filter(|t| t != "page.html" && t != "section.html");
    ExternalContentInfo {
        custom_template,
        has_script_tag: content.contains("<script"),
    }
}

/// Zola's own date parsing is strict enough that a hand-typed value in a
/// format Zola doesn't recognize (verified empirically: "2026-9-26",
/// "09/26/2026", and "September 26, 2026" all fail) doesn't just break that
/// one page - it fails the ENTIRE site build, so nothing new deploys until
/// it's fixed. That's the whole reason this exists as a real command instead
/// of leaving date-editing to raw front-matter text: the frontend only ever
/// feeds this a value built from plain number inputs, which can't produce a
/// malformed string in the first place.
#[tauri::command]
pub fn set_front_matter_date(content: String, datetime: String) -> Result<String, String> {
    stamp_top_level_field(&content, "date", &datetime)
        .ok_or_else(|| "This file has no front matter block to set a date in.".to_string())
}

/// Drops the `date` front-matter field entirely (a no-op if there wasn't
/// one) - for a page that shouldn't be dated at all rather than dated
/// "now" by mistake.
#[tauri::command]
pub fn remove_front_matter_date(content: String) -> Result<String, String> {
    let (mut lines, newline, closing_idx) = front_matter_lines(&content)?;

    let date_idx = lines
        .iter()
        .enumerate()
        .take(closing_idx)
        .skip(1)
        .find(|(_, l)| l.split_once('=').map(|(k, _)| k.trim()) == Some("date"))
        .map(|(i, _)| i);

    if let Some(i) = date_idx {
        lines.remove(i);
    }

    Ok(reassemble(lines, newline, &content))
}

/// Creates a new dated post in whichever section find_post_section finds -
/// see that function's doc comment for why "the posts section" is
/// determined by a `sort_by = "date"` front-matter convention rather than a
/// hardcoded folder name.
///
/// `datetime` comes from the frontend's own local clock (see nowForZola in
/// index.html), not computed here - Rust getting the local timezone offset
/// safely needs the `time` crate's "local-offset" feature, which that crate
/// itself warns is unsound to enable in a multi-threaded process (which a
/// Tauri app always is). The browser has no such problem, and this also
/// keeps auto-stamped and manually-set (see set_front_matter_date) dates
/// consistent with each other.
#[tauri::command]
pub fn create_post(title: String, datetime: String, author: Option<String>) -> Result<String, String> {
    let section_dir = find_post_section().ok_or_else(|| {
        "No section is marked as the posts section yet - add `sort_by = \"date\"` to a section's \
         _index.md front matter (e.g. content/blog/_index.md) to mark it as where posts go."
            .to_string()
    })?;

    let slug = content_slug(&title);
    if slug.is_empty() {
        return Err("Title can't be empty".to_string());
    }

    let full = section_dir.join(format!("{slug}.md"));
    if full.exists() {
        return Err(format!("A post already exists at \"{slug}.md\" - choose a different title."));
    }

    let front_matter = format!("+++\ntitle = \"{}\"\ndate = {datetime}\n+++\n\n", title.replace('"', "\\\""));
    let front_matter = append_author(&front_matter, author);
    std::fs::write(&full, front_matter).map_err(|e| e.to_string())?;

    full.strip_prefix(site_dir())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSection {
    slug: String,
    title: String,
}

/// Every existing top-level content/ section (has its own _index.md) that a
/// new page could nest under - not recursive, since "New page" only offers
/// one level of nesting for now (see create_page).
#[tauri::command]
pub fn list_page_sections() -> Vec<ContentSection> {
    let content_root = site_dir().join(zola::CONTENT_DIR);
    let mut sections = Vec::new();
    let Ok(entries) = std::fs::read_dir(&content_root) else { return sections };
    for entry in entries.flatten() {
        let path = entry.path();
        let index = path.join("_index.md");
        if !path.is_dir() || !index.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&index).ok();

        // Only a "page heading" is a valid destination for a free-form page.
        // A "blog heading" (Blog) isn't - posts go through create_post/
        // find_post_section instead. A "filtered-view heading" (Events: an
        // algorithmic tag-filtered listing) or a "widget heading" (Plant
        // Safari: a single bespoke embedded page) aren't containers at all -
        // neither a page nor a post has anywhere real to nest under them.
        // Unclassified (no explicit heading_kind, no sort_by = "date")
        // defaults permissively to Page, matching every section that
        // predates this convention.
        let excluded = matches!(
            raw.as_deref().and_then(zola::heading_kind_of),
            Some(zola::HeadingKind::Blog) | Some(zola::HeadingKind::FilteredView) | Some(zola::HeadingKind::Widget)
        );
        if excluded {
            continue;
        }

        let block = raw.as_deref().and_then(front_matter_block);
        let slug = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let title = block.and_then(|b| front_matter_field(b, "title")).unwrap_or_else(|| slug.clone());
        sections.push(ContentSection { slug, title });
    }
    sections.sort_by(|a, b| a.title.cmp(&b.title));
    sections
}

/// Creates a new page nested under an existing top-level section (e.g. a new
/// page under "Biodiversity") - see create_section for a brand-new top-level
/// section instead. The default section.html template already lists
/// section.pages automatically, so nesting under an existing section needs
/// nothing further to become visible there.
///
/// Stamps `date` as a creation timestamp the same way create_post does, even
/// though a page's section isn't a "blog heading" - safe to do because
/// whether that date actually gets DISPLAYED in a section listing is
/// controlled separately (section.extra.show_dates in templates/
/// section.html), so a page picking up a creation date here doesn't make
/// non-blog sections start showing dates they shouldn't.
#[tauri::command]
pub fn create_page(title: String, section: String, datetime: String, author: Option<String>) -> Result<String, String> {
    let slug = content_slug(&title);
    if slug.is_empty() {
        return Err("Title can't be empty".to_string());
    }

    let section_dir = resolve_site_path(&format!("{}/{}", zola::CONTENT_DIR, section))?;
    if !section_dir.join("_index.md").exists() {
        return Err(format!("\"{section}\" isn't an existing section."));
    }

    let full = section_dir.join(format!("{slug}.md"));
    if full.exists() {
        return Err("A page already exists at this location - choose a different title.".to_string());
    }

    let front_matter = format!("+++\ntitle = \"{}\"\ndate = {datetime}\n+++\n\n", title.replace('"', "\\\""));
    let front_matter = append_author(&front_matter, author);
    std::fs::write(&full, front_matter).map_err(|e| e.to_string())?;

    full.strip_prefix(site_dir())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

/// Creates a brand-new TOP-LEVEL section (its own content/<slug>/_index.md),
/// a sibling of About/Biodiversity/etc. rather than nested under one of them
/// - unlike create_page's target, becoming reachable from the site's actual
/// nav is no longer blocked on a hardcoded template (see menu.rs's
/// [[extra.menu]] and the Site menu editor): a new section just needs adding
/// to the menu like anything else.
///
/// No `date` field in the front matter at all - unlike create_page's target
/// (a Page), a Section's front-matter schema has no `date` field, and
/// writing one is a hard Zola build error (see zola::is_section_index's own
/// doc comment for the real error text that surfaced this).
#[tauri::command]
pub fn create_section(title: String, author: Option<String>) -> Result<String, String> {
    let slug = content_slug(&title);
    if slug.is_empty() {
        return Err("Title can't be empty".to_string());
    }

    let section_dir = site_dir().join(zola::CONTENT_DIR).join(&slug);
    if section_dir.exists() {
        return Err(format!("A section already exists at \"{slug}\" - choose a different title."));
    }

    std::fs::create_dir_all(&section_dir).map_err(|e| e.to_string())?;
    let full = section_dir.join("_index.md");

    let front_matter = format!("+++\ntitle = \"{}\"\n+++\n\n", title.replace('"', "\\\""));
    let front_matter = append_author(&front_matter, author);
    std::fs::write(&full, front_matter).map_err(|e| e.to_string())?;

    full.strip_prefix(site_dir())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

// Same two forms images.js's own MD_IMAGE_RE/HTML_IMAGE_RE match on the
// frontend (alignment toolbar) - only the URL capture group is needed here,
// not alt text/style. Compiled once (LazyLock, stable since Rust 1.80) since
// unlike that frontend scan, which runs on every cursor movement,
// extract_image_urls only runs on content deletion - still no reason to
// recompile the same pattern per call.
static MD_IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\(([^)\s]+)\)").unwrap());
static HTML_IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<img src="([^"]*)""#).unwrap());

/// Finds every image URL referenced in `content`, both markdown (`![alt](url)`)
/// and this app's own raw `<img src="url" ...>` form (used for alignment).
fn extract_image_urls(content: &str) -> Vec<String> {
    MD_IMAGE_RE
        .captures_iter(content)
        .chain(HTML_IMAGE_RE.captures_iter(content))
        .map(|c| c[1].to_string())
        .collect()
}

/// True if `dir` (a section's own directory) contains nothing besides
/// `index_file` itself - no sibling pages, no nested subsections, no
/// co-located assets.
fn section_is_empty(dir: &Path, index_file: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().all(|entry| entry.path() == index_file)
}

/// Deletes a content file (or, for a page bundle, its whole directory - a
/// bundle's co-located assets have nowhere else to go). A section index
/// (_index.md) can only be deleted if its section is otherwise completely
/// empty (section_is_empty) - deleting a NON-empty section would take every
/// page nested under it with it, a much bigger blast radius than "delete
/// this one page" implies, and isn't supported here; a real "delete this
/// whole section, including everything in it" action would need its own,
/// more deliberate confirmation flow.
#[tauri::command]
pub fn delete_content(
    path: String,
    tracker: tauri::State<SelfWriteTracker>,
    open_files: tauri::State<OpenFiles>,
    r2_site: tauri::State<R2SiteConfigState>,
    r2_personal: tauri::State<R2PersonalConfigState>,
) -> Result<(), String> {
    let full = resolve_site_path(&path)?;
    if !full.exists() {
        return Err("That file doesn't exist.".to_string());
    }

    let file_name = full.file_name().and_then(|f| f.to_str()).unwrap_or_default();
    let is_section_index = file_name == "_index.md";
    if is_section_index {
        let dir = full.parent().ok_or_else(|| "invalid content path".to_string())?;
        if !section_is_empty(dir, &full) {
            return Err(
                "This section still has pages (or other files) in it - delete those first. An \
                 empty section (just its own _index.md, nothing else) can be deleted directly."
                    .to_string(),
            );
        }
    }

    // Best-effort R2 cleanup - a failure here should never block deleting
    // the page itself, which is what the user actually asked for. Silently
    // ignoring individual delete failures (e.g. a network hiccup) is
    // preferable to losing the ability to delete the page over it.
    if let Ok(text) = std::fs::read_to_string(&full) {
        let site_cfg = r2_site.0.lock().unwrap().clone();
        let personal_cfg = r2_personal.0.lock().unwrap().clone();
        for url in extract_image_urls(&text) {
            if let Some(key) = crate::r2::r2_key_from_url(&site_cfg, &url) {
                let _ = crate::r2::delete_from_r2(&site_cfg, &personal_cfg, &key);
            }
        }
    }

    tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
    open_files.0.lock().unwrap().remove(&full);

    if file_name == "index.md" || is_section_index {
        // The directory IS the page/section - a page bundle's co-located
        // assets, or an (empty, checked above) section's own directory.
        let dir = full.parent().ok_or_else(|| "invalid content path".to_string())?;
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&full).map_err(|e| e.to_string())
    }
}

/// Renames a content file's slug (and, for a bundle or section, its whole
/// directory) in place, WITHOUT moving it to a different section - that's a
/// separate, bigger operation than a rename, not offered here. Registers the
/// old and new paths as self-writes before the actual rename the same way
/// images.rs's bundle-conversion rename does, so the live content watcher
/// doesn't mistake this app's own rename for an external edit landing on a
/// tab that's still open under its old path.
#[tauri::command]
pub fn rename_content(
    path: String,
    new_title: String,
    tracker: tauri::State<SelfWriteTracker>,
    open_files: tauri::State<OpenFiles>,
) -> Result<String, String> {
    let full = resolve_site_path(&path)?;
    if !full.exists() {
        return Err("That file doesn't exist.".to_string());
    }

    let new_slug = content_slug(&new_title);
    if new_slug.is_empty() {
        return Err("Title can't be empty".to_string());
    }

    let file_name = full.file_name().and_then(|f| f.to_str()).unwrap_or_default();
    let is_bundle_or_section = file_name == "index.md" || file_name == "_index.md";

    let new_full = if is_bundle_or_section {
        // The directory IS the page/section - renaming it carries every
        // co-located asset (and, for a section, every nested page) along for
        // free, as one atomic move.
        let dir = full.parent().ok_or_else(|| "invalid content path".to_string())?;
        let new_dir = dir
            .parent()
            .ok_or_else(|| "invalid content path".to_string())?
            .join(&new_slug);
        if new_dir.exists() {
            return Err("Something already exists at that name - choose a different title.".to_string());
        }
        std::fs::rename(dir, &new_dir).map_err(|e| e.to_string())?;
        new_dir.join(file_name)
    } else {
        let new_path = full
            .parent()
            .ok_or_else(|| "invalid content path".to_string())?
            .join(format!("{new_slug}.md"));
        if new_path.exists() {
            return Err("A page already exists at that name - choose a different title.".to_string());
        }

        {
            let mut t = tracker.0.lock().unwrap();
            t.insert(full.clone(), Instant::now());
            t.insert(new_path.clone(), Instant::now());
        }
        std::fs::rename(&full, &new_path).map_err(|e| e.to_string())?;
        new_path
    };

    if is_bundle_or_section {
        // The directory rename above already moved index.md/_index.md itself
        // (and everything else in the directory) - only the tracker/open-tab
        // bookkeeping is still needed, keyed on the file's final path.
        let mut t = tracker.0.lock().unwrap();
        t.insert(full.clone(), Instant::now());
        t.insert(new_full.clone(), Instant::now());
    }
    open_files.0.lock().unwrap().remove(&full);

    // The file/directory move above only changes the slug - the front
    // matter's own `title` field is a separate piece of text that has to be
    // rewritten to match, or the page would show its old title everywhere
    // (nav listings, the browser tab, etc.) despite having a "renamed" URL.
    let raw = std::fs::read_to_string(&new_full).map_err(|e| e.to_string())?;
    let quoted_title = format!("\"{}\"", new_title.replace('"', "\\\""));
    if let Some(updated) = stamp_top_level_field(&raw, "title", &quoted_title) {
        std::fs::write(&new_full, updated).map_err(|e| e.to_string())?;
    }

    new_full
        .strip_prefix(site_dir())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

/// Every distinct tag currently used anywhere on the site, so the tag picker
/// can suggest reusing an existing one instead of inviting a near-duplicate
/// - this site's real content already has both "Newsletter" and "newsletter"
/// as separate tags. Case-preserving but de-duplicated case-INsensitively -
/// first-seen casing wins.
#[tauri::command]
pub fn list_all_tags() -> Vec<String> {
    let dir = site_dir();
    let mut content_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut content_paths);
    content_paths.sort();

    let mut seen_lower = HashSet::new();
    let mut tags = Vec::new();
    for rel in content_paths {
        let Ok(raw) = std::fs::read_to_string(dir.join(&rel)) else { continue };
        let Some(block) = front_matter_block(&raw) else { continue };
        let Some(raw_tags) = front_matter_field(block, "tags") else { continue };
        for tag in parse_toml_string_array(&raw_tags) {
            if seen_lower.insert(tag.to_lowercase()) {
                tags.push(tag);
            }
        }
    }
    tags.sort_by_key(|t| t.to_lowercase());
    tags
}

/// Reads the current page's tags straight out of the given text (the live
/// editor buffer) - same "operate on the buffer, not disk" reasoning as
/// get_front_matter_date/get_front_matter_title.
#[tauri::command]
pub fn get_content_tags(content: String) -> Vec<String> {
    front_matter_block(&content)
        .and_then(|b| front_matter_field(b, "tags"))
        .map(|raw| parse_toml_string_array(&raw))
        .unwrap_or_default()
}

/// Sets the current page's tags, replacing whatever's there. An empty list
/// still writes `tags = []` rather than removing the field entirely - one
/// code path for "has tags" and "has none" instead of two, since Zola treats
/// an empty taxonomy array the same as not having the field at all.
#[tauri::command]
pub fn set_content_tags(content: String, tags: Vec<String>) -> Result<String, String> {
    stamp_table_field(&content, "taxonomies", "tags", &format_toml_string_array(&tags))
        .ok_or_else(|| "This file has no front matter block to set tags in.".to_string())
}

/// The pure, testable core of rewrite_tag: computes this ONE file's updated
/// tag list, or None if `from` isn't present at all (nothing to do). Case-
/// insensitive matching/de-duplication throughout, the same convention
/// list_all_tags and the per-post tag picker already use - this site's real
/// content already has both "Newsletter" and "newsletter" as separate tags
/// on some posts, which this also quietly cleans up whenever either one is
/// the rename/merge target.
fn rewritten_tags(tags: &[String], from: &str, to: Option<&str>) -> Option<Vec<String>> {
    if !tags.iter().any(|t| t.eq_ignore_ascii_case(from)) {
        return None;
    }
    let mut updated: Vec<String> = Vec::new();
    for t in tags {
        if t.eq_ignore_ascii_case(from) {
            if let Some(new_tag) = to {
                if !updated.iter().any(|u: &String| u.eq_ignore_ascii_case(new_tag)) {
                    updated.push(new_tag.to_string());
                }
            }
            // to == None: drop it entirely (delete).
        } else if !updated.iter().any(|u| u.eq_ignore_ascii_case(t)) {
            updated.push(t.clone());
        }
    }
    Some(updated)
}

/// Deletes (`to: None`) or renames/merges (`to: Some(new)`) a tag across
/// EVERY content file that has it - delete and rename/merge are the exact
/// same underlying rewrite (see rewritten_tags), just with a different
/// target; whether `to` already exists on some other page (a merge) or is
/// brand new everywhere (a plain rename) doesn't change what this actually
/// does. Returns how many files were actually changed.
#[tauri::command]
pub fn rewrite_tag(from: String, to: Option<String>, tracker: tauri::State<SelfWriteTracker>) -> Result<usize, String> {
    let dir = site_dir();
    let mut content_paths = Vec::new();
    collect_files_with_ext(&dir.join(zola::CONTENT_DIR), &dir, zola::CONTENT_EXT, &mut content_paths);

    let mut changed = 0;
    for rel in content_paths {
        let full = dir.join(&rel);
        let Ok(raw) = std::fs::read_to_string(&full) else { continue };
        let Some(block) = front_matter_block(&raw) else { continue };
        let Some(raw_tags) = front_matter_field(block, "tags") else { continue };
        let tags = parse_toml_string_array(&raw_tags);

        let Some(updated_tags) = rewritten_tags(&tags, &from, to.as_deref()) else { continue };

        let updated = stamp_table_field(&raw, "taxonomies", "tags", &format_toml_string_array(&updated_tags))
            .ok_or_else(|| format!("{rel}: no front matter block to update tags in"))?;

        // Registered as a self-write (like write_file/delete_content already
        // do for their own out-of-band writes) so the live content watcher
        // doesn't mistake this for an external edit landing on a tab that
        // happens to still be open on this exact file.
        tracker.0.lock().unwrap().insert(full.clone(), Instant::now());
        std::fs::write(&full, updated).map_err(|e| e.to_string())?;
        changed += 1;
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("beedance-content-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn section_is_empty_true_for_just_its_own_index() {
        let dir = temp_dir("empty");
        let index = dir.join("_index.md");
        std::fs::write(&index, "+++\ntitle = \"News\"\n+++\n").unwrap();
        assert!(section_is_empty(&dir, &index));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn section_is_empty_false_with_a_sibling_page() {
        let dir = temp_dir("sibling");
        let index = dir.join("_index.md");
        std::fs::write(&index, "+++\ntitle = \"News\"\n+++\n").unwrap();
        std::fs::write(dir.join("some-post.md"), "+++\ntitle = \"Post\"\n+++\n").unwrap();
        assert!(!section_is_empty(&dir, &index));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn section_is_empty_false_with_a_subsection() {
        let dir = temp_dir("subsection");
        let index = dir.join("_index.md");
        std::fs::write(&index, "+++\ntitle = \"News\"\n+++\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(!section_is_empty(&dir, &index));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn tags(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rewritten_tags_none_when_from_absent() {
        assert_eq!(rewritten_tags(&tags(&["a", "b"]), "c", None), None);
    }

    #[test]
    fn rewritten_tags_deletes_when_to_is_none() {
        assert_eq!(rewritten_tags(&tags(&["a", "b", "c"]), "b", None), Some(tags(&["a", "c"])));
    }

    #[test]
    fn rewritten_tags_renames_to_a_new_name() {
        assert_eq!(rewritten_tags(&tags(&["a", "b"]), "a", Some("z")), Some(tags(&["z", "b"])));
    }

    #[test]
    fn rewritten_tags_merges_into_an_existing_tag_without_duplicating() {
        // "urgent" merged into "volunteer", which the post already has.
        assert_eq!(rewritten_tags(&tags(&["urgent", "volunteer"]), "urgent", Some("volunteer")), Some(tags(&["volunteer"])));
    }

    #[test]
    fn rewritten_tags_matching_is_case_insensitive() {
        assert_eq!(rewritten_tags(&tags(&["Newsletter"]), "newsletter", Some("News")), Some(tags(&["News"])));
    }

    #[test]
    fn rewritten_tags_cleans_up_an_existing_case_duplicate_on_rename() {
        // A post that already has both casings of the same real-world tag -
        // renaming/merging either one into the canonical spelling should
        // collapse them to a single entry, not leave a duplicate.
        assert_eq!(
            rewritten_tags(&tags(&["Newsletter", "newsletter", "news"]), "Newsletter", Some("newsletter")),
            Some(tags(&["newsletter", "news"]))
        );
    }

    #[test]
    fn rewritten_tags_leaves_unrelated_tags_untouched() {
        assert_eq!(rewritten_tags(&tags(&["a", "b", "c"]), "b", Some("z")), Some(tags(&["a", "z", "c"])));
    }
}
