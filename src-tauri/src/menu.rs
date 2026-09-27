//! Reads/writes the `[[extra.menu]]` array-of-tables in a site's config.toml -
//! plain text-level surgery (like frontmatter.rs, for the same reason: a real
//! TOML parser round-trip would drop every comment and could reformat/
//! reorder everything else in the file), not a real TOML parser. Field names
//! (`name`, `url`) deliberately match the Abridge theme's own [[extra.menu]]
//! convention (see sample-site/themes/abridge/templates/base.html) rather
//! than inventing a different shape - one editor works whether or not the
//! site's actual theme happens to be Abridge. `url` is either an absolute
//! `http(s)://` link or a Zola content-relative `@/path/_index.md` reference,
//! resolved through `get_url()` in the site's own base template.

use crate::site::site_dir;
use crate::zola;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MenuEntry {
    pub name: String,
    pub url: String,
}

fn config_path() -> std::path::PathBuf {
    site_dir().join(zola::SITE_CONFIG_FILE)
}

/// True if `line` (already trimmed) is a table header - `[extra.menu]`
/// entries run until the next one of these, or end of file.
fn is_table_header(line: &str) -> bool {
    line.starts_with('[')
}

/// Parses every `[[extra.menu]]` block in `content`, in file order.
fn parse_menu(content: &str) -> Vec<MenuEntry> {
    let lines: Vec<&str> = content.lines().collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "[[extra.menu]]" {
            let mut name = String::new();
            let mut url = String::new();
            let mut j = i + 1;
            while j < lines.len() && !is_table_header(lines[j].trim_start()) {
                if let Some((key, value)) = lines[j].split_once('=') {
                    let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    match key.trim() {
                        "name" => name = value,
                        "url" => url = value,
                        _ => {}
                    }
                }
                j += 1;
            }
            entries.push(MenuEntry { name, url });
            i = j;
        } else {
            i += 1;
        }
    }
    entries
}

/// Replaces every existing `[[extra.menu]]` block with freshly written ones
/// for `entries`, in order - everything else in the file (comments,
/// base_url, taxonomies, etc.) is left completely untouched, byte for byte.
/// Appends the new blocks at the end of the file if none existed yet (a
/// brand-new site with no menu configured at all).
fn write_menu(content: &str, entries: &[MenuEntry]) -> String {
    let lines: Vec<&str> = content.lines().collect();

    let mut first_idx = None;
    let mut end_idx = lines.len();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "[[extra.menu]]" {
            first_idx.get_or_insert(i);
            let mut j = i + 1;
            while j < lines.len() && !is_table_header(lines[j].trim_start()) {
                j += 1;
            }
            end_idx = j;
            i = j;
        } else {
            i += 1;
        }
    }

    let mut new_block: Vec<String> = Vec::new();
    for entry in entries {
        new_block.push("[[extra.menu]]".to_string());
        new_block.push(format!("name = \"{}\"", entry.name.replace('"', "\\\"")));
        new_block.push(format!("url = \"{}\"", entry.url.replace('"', "\\\"")));
        new_block.push(String::new());
    }
    // No trailing blank line needed after the very last entry when nothing
    // follows it in the file.
    if end_idx >= lines.len() && new_block.last().is_some_and(String::is_empty) {
        new_block.pop();
    }

    let mut result: Vec<String> = Vec::new();
    match first_idx {
        Some(start) => {
            result.extend(lines[..start].iter().map(|l| l.to_string()));
            result.extend(new_block);
            result.extend(lines[end_idx..].iter().map(|l| l.to_string()));
        }
        None => {
            result.extend(lines.iter().map(|l| l.to_string()));
            if result.last().is_some_and(|l| !l.is_empty()) {
                result.push(String::new());
            }
            result.extend(new_block);
        }
    }

    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let mut joined = result.join(newline);
    if content.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

#[tauri::command]
pub fn get_site_menu() -> Result<Vec<MenuEntry>, String> {
    let content = std::fs::read_to_string(config_path())
        .map_err(|e| format!("Couldn't read {}: {e}", zola::SITE_CONFIG_FILE))?;
    Ok(parse_menu(&content))
}

#[tauri::command]
pub fn set_site_menu(entries: Vec<MenuEntry>) -> Result<(), String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", zola::SITE_CONFIG_FILE))?;
    std::fs::write(&path, write_menu(&content, &entries)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, url: &str) -> MenuEntry {
        MenuEntry { name: name.to_string(), url: url.to_string() }
    }

    #[test]
    fn parses_the_real_site_shape() {
        let content = "base_url = \"https://example.com\"\n\
             title = \"Example\"\n\
             \n\
             taxonomies = [\n    { name = \"tags\", render = false },\n]\n\
             \n\
             # a comment above the menu\n\
             [[extra.menu]]\n\
             name = \"Home\"\n\
             url = \"@/_index.md\"\n\
             \n\
             [[extra.menu]]\n\
             name = \"About\"\n\
             url = \"@/about/_index.md\"\n";
        let entries = parse_menu(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Home");
        assert_eq!(entries[0].url, "@/_index.md");
        assert_eq!(entries[1].name, "About");
        assert_eq!(entries[1].url, "@/about/_index.md");
    }

    #[test]
    fn write_then_parse_round_trips_and_preserves_everything_else() {
        let content = "base_url = \"https://example.com\"\n\
             \n\
             [[extra.menu]]\n\
             name = \"Home\"\n\
             url = \"@/_index.md\"\n\
             \n\
             [[extra.menu]]\n\
             name = \"About\"\n\
             url = \"@/about/_index.md\"\n";
        let updated = write_menu(content, &[entry("About", "@/about/_index.md"), entry("Home", "@/_index.md")]);
        assert!(updated.starts_with("base_url = \"https://example.com\"\n"));
        let reparsed = parse_menu(&updated);
        assert_eq!(reparsed.len(), 2);
        assert_eq!(reparsed[0].name, "About");
        assert_eq!(reparsed[1].name, "Home");
    }

    #[test]
    fn write_menu_preserves_a_table_that_follows_it() {
        let content = "[[extra.menu]]\nname = \"Home\"\nurl = \"@/_index.md\"\n\n[extra.other]\nkeep = true\n";
        let updated = write_menu(content, &[entry("Home", "@/_index.md"), entry("About", "@/about/_index.md")]);
        assert!(updated.contains("[extra.other]\nkeep = true"));
        let reparsed = parse_menu(&updated);
        assert_eq!(reparsed.len(), 2);
        assert_eq!(reparsed[1].name, "About");
    }

    #[test]
    fn write_menu_appends_when_none_exists_yet() {
        let content = "base_url = \"https://example.com\"\ntitle = \"Example\"\n";
        let updated = write_menu(content, &[entry("Home", "@/_index.md")]);
        assert!(updated.starts_with("base_url = \"https://example.com\"\ntitle = \"Example\"\n\n[[extra.menu]]"));
        assert_eq!(parse_menu(&updated), vec![entry("Home", "@/_index.md")].into_iter().collect::<Vec<_>>());
    }

    #[test]
    fn escapes_quotes_in_written_values() {
        let updated = write_menu("", &[entry("Sean\"s Page", "@/x/_index.md")]);
        assert!(updated.contains("name = \"Sean\\\"s Page\""));
    }

    impl std::fmt::Debug for MenuEntry {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MenuEntry {{ name: {:?}, url: {:?} }}", self.name, self.url)
        }
    }
    impl PartialEq for MenuEntry {
        fn eq(&self, other: &Self) -> bool {
            self.name == other.name && self.url == other.url
        }
    }
}
