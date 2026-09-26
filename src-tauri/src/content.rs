//! Page/post creation, front-matter date editing, and the preview-jump URL
//! guess - the layer that combines frontmatter.rs's text parsing with
//! site.rs's knowledge of where the site actually lives.

use std::path::{Path, PathBuf};

use crate::frontmatter::{
    content_slug, front_matter_block, front_matter_field, front_matter_lines, reassemble, stamp_top_level_field,
};
use crate::site::{resolve_site_path, site_dir};
use crate::zola;

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

/// Finds the site's "posts" section: whichever content/ section has
/// `sort_by = "date"` in its `_index.md` front matter. This is Zola's own
/// native convention for a dated/chronological listing, not something this
/// app invented - reusing it means "New post" has an unambiguous, existing
/// signal for where posts go instead of guessing at a folder name like
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
                    if let Some(block) = front_matter_block(&raw) {
                        if front_matter_field(block, "sort_by").as_deref() == Some("date") {
                            *found = path.parent().map(Path::to_path_buf);
                        }
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
pub fn create_post(title: String, datetime: String) -> Result<String, String> {
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
        let block = raw.as_deref().and_then(front_matter_block);

        // A "blog heading" (a dated, chronological section like Blog) isn't
        // a valid destination for a free-form page - only "page headings"
        // are offered here. Posts still go through create_post/
        // find_post_section, which uses this same sort_by convention.
        if block.and_then(|b| front_matter_field(b, "sort_by")).as_deref() == Some("date") {
            continue;
        }

        let slug = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let title = block.and_then(|b| front_matter_field(b, "title")).unwrap_or_else(|| slug.clone());
        sections.push(ContentSection { slug, title });
    }
    sections.sort_by(|a, b| a.title.cmp(&b.title));
    sections
}

/// Creates a new page nested under an existing top-level section (e.g. a new
/// page under "Biodiversity") rather than as its own top-level section -
/// this site's nav is hardcoded in the template, so a brand-new top-level
/// section has no way to become reachable from the menu until the nav is
/// rebuilt on a data-driven convention (e.g. a `[[extra.menu]]` array read by
/// the base template, instead of literal `<a>` tags). Nesting under an
/// existing section instead works today: the default section.html template
/// already lists section.pages automatically.
///
/// Stamps `date` as a creation timestamp the same way create_post does, even
/// though a page's section isn't a "blog heading" - safe to do because
/// whether that date actually gets DISPLAYED in a section listing is
/// controlled separately (section.extra.show_dates in templates/
/// section.html), so a page picking up a creation date here doesn't make
/// non-blog sections start showing dates they shouldn't.
#[tauri::command]
pub fn create_page(title: String, section: String, datetime: String) -> Result<String, String> {
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
    std::fs::write(&full, front_matter).map_err(|e| e.to_string())?;

    full.strip_prefix(site_dir())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}
