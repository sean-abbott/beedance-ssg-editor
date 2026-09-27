//! Zola-specific conventions, isolated in one place so nothing else in this
//! app has to re-derive them from scratch. This app only supports Zola today
//! - this module is not a plugin system, just a named boundary around the
//! one SSG it actually knows about. If a second SSG is ever added for real,
//! this is the shape a sibling module would mirror.
//!
//! Centralizing this is what the image-insert bug from testing (a section
//! index getting renamed into a broken nested bundle) argued for: the
//! index.md/_index.md distinction used to live as an inline check in one
//! Rust function and a separately hand-copied check in the frontend JS -
//! two places that had to agree and didn't. Now there's one.

use std::path::Path;

pub const CONTENT_DIR: &str = "content";
pub const STATIC_DIR: &str = "static";
pub const TEMPLATES_DIR: &str = "templates";
pub const THEMES_DIR: &str = "themes";
pub const CONTENT_EXT: &str = "md";
pub const TEMPLATE_EXT: &str = "html";
pub const SITE_CONFIG_FILE: &str = "config.toml";

/// True if `path`'s filename is one of Zola's two "this directory can
/// already colocate assets" conventions: `index.md` (a leaf page turned into
/// a page bundle) or `_index.md` (a section index - sections can ALWAYS
/// colocate assets in their own directory, so they never need converting
/// into a nested bundle the way a plain leaf page does).
pub fn is_bundle_page(path: &Path) -> bool {
    path.file_name().is_some_and(|f| f == "index.md" || f == "_index.md")
}

/// True if `path` is specifically a SECTION index (`_index.md`), as opposed
/// to a plain page or a page bundle's `index.md`. Matters beyond is_bundle_page
/// because Zola's Section front matter schema is a genuinely different,
/// smaller set of recognized fields than Page's - `updated` (and `date`)
/// belong to Page only. Stamping `updated` onto a section's front matter
/// isn't just redundant, it's a hard TOML parse error ("unknown field
/// `updated`") that breaks the whole build - found the hard way testing on
/// a real site's content/_index.md.
pub fn is_section_index(path: &Path) -> bool {
    path.file_name().is_some_and(|f| f == "_index.md")
}

/// Looks like a real Zola site directory (has the SSG's own config file) -
/// used only to warn, not to gate, since a brand-new/empty site directory is
/// a legitimate thing to point the editor at.
pub fn looks_like_site(dir: &Path) -> bool {
    dir.join(SITE_CONFIG_FILE).exists()
}
