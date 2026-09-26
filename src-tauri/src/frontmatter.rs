//! Pure text-level front matter parsing/editing helpers - no site.rs/tauri
//! dependency at all, deliberately: everything here operates on a string
//! that's handed in (a file's contents, or the live editor buffer), not a
//! path. Not a real TOML/YAML parser, just enough to read/write the few
//! fields (title, date, slug, path, sort_by) this app actually needs.

/// Best-effort front matter block (the text between the opening and closing
/// `+++`/`---` delimiter).
pub fn front_matter_block(raw: &str) -> Option<&str> {
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

pub fn front_matter_field(block: &str, field: &str) -> Option<String> {
    for line in block.lines() {
        if let Some((key, value)) = line.split_once('=').or_else(|| line.split_once(':')) {
            if key.trim() == field {
                return Some(value.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    None
}

/// Splits `content` into owned lines plus the reassembly newline style, and
/// finds the front matter block's opening delimiter and closing line index -
/// the shared groundwork set_front_matter_date/remove_front_matter_date (in
/// content.rs) both need before they touch the `date` line specifically.
pub fn front_matter_lines(content: &str) -> Result<(Vec<String>, &'static str, usize), String> {
    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<String> = content.lines().map(str::to_string).collect();

    let opening = lines.first().map(|l| l.trim().to_string()).unwrap_or_default();
    if opening != "+++" && opening != "---" {
        return Err("This file has no front matter block to set a date in.".to_string());
    }

    let closing_idx = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.trim() == opening)
        .map(|(i, _)| i)
        .ok_or_else(|| "Front matter block has no closing delimiter.".to_string())?;

    Ok((lines, newline, closing_idx))
}

pub fn reassemble(lines: Vec<String>, newline: &str, original: &str) -> String {
    let mut result = lines.join(newline);
    if original.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Sets (or inserts right after the opening delimiter) a top-level
/// `field = value` line within the front matter block. None if there's no
/// front matter block at all (e.g. a template file) - a silent "can't do
/// this" signal for a caller like write_file's auto-`updated` stamp, which
/// covers both content and template saves and must not fail the whole write
/// just because a template has nothing to stamp.
pub fn stamp_top_level_field(content: &str, field: &str, value: &str) -> Option<String> {
    let (mut lines, newline, closing_idx) = front_matter_lines(content).ok()?;

    let new_line = format!("{field} = {value}");
    let existing = lines
        .iter_mut()
        .take(closing_idx)
        .skip(1)
        .find(|l| l.split_once('=').map(|(k, _)| k.trim()) == Some(field));

    match existing {
        Some(line) => *line = new_line,
        // Right after the opening delimiter (like title) - no need to
        // understand TOML table nesting since this is always a top-level key.
        None => lines.insert(1, new_line),
    }

    Some(reassemble(lines, newline, content))
}

/// Like stamp_top_level_field, but for a key that belongs INSIDE a specific
/// TOML table (e.g. `tags` under `[taxonomies]`, or `created_by` under
/// `[extra]`) rather than at the top level. A table's lines run from its
/// `[name]` header until the next `[`-prefixed header line or the closing
/// delimiter, whichever comes first - creates the table (appended right
/// before the closing delimiter, since TOML doesn't care about table order)
/// if it doesn't exist yet.
pub fn stamp_table_field(content: &str, table: &str, field: &str, value: &str) -> Option<String> {
    let (mut lines, newline, closing_idx) = front_matter_lines(content).ok()?;

    let table_header = format!("[{table}]");
    let table_start = lines.iter().take(closing_idx).position(|l| l.trim() == table_header);

    match table_start {
        Some(start) => {
            let table_end = lines
                .iter()
                .enumerate()
                .skip(start + 1)
                .take(closing_idx - start - 1)
                .find(|(_, l)| l.trim_start().starts_with('['))
                .map(|(i, _)| i)
                .unwrap_or(closing_idx);

            let new_line = format!("{field} = {value}");
            let existing = lines
                .iter_mut()
                .take(table_end)
                .skip(start + 1)
                .find(|l| l.split_once('=').map(|(k, _)| k.trim()) == Some(field));

            match existing {
                Some(line) => *line = new_line,
                None => lines.insert(table_end, new_line),
            }
        }
        None => {
            lines.insert(closing_idx, format!("{field} = {value}"));
            lines.insert(closing_idx, table_header);
        }
    }

    Some(reassemble(lines, newline, content))
}

/// A single-line TOML string array (`["a", "b"]`) is all the tags/authors
/// front matter this app ever writes actually uses - not a general TOML
/// value parser, just enough to round-trip that one shape.
pub fn parse_toml_string_array(raw: &str) -> Vec<String> {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn format_toml_string_array(items: &[String]) -> String {
    let quoted: Vec<String> = items.iter().map(|s| format!("\"{}\"", s.replace('"', "\\\""))).collect();
    format!("[{}]", quoted.join(", "))
}

/// Appends `name` to the front matter's `extra.authors` list if it isn't
/// already there (case-insensitive) - a no-op if `name` is None/empty, or
/// already present. Builds a running "who has contributed to this page"
/// record rather than overwriting a single "last touched by" value, since on
/// a small volunteer team attribution should accumulate, not churn - every
/// save (or the initial create) just adds the current person if they're new
/// to this particular page. Shared by content.rs (create_post/create_page)
/// and site.rs (write_file), so it lives here rather than in either.
pub fn append_author(content: &str, name: Option<String>) -> String {
    let Some(name) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) else {
        return content.to_string();
    };

    let current = front_matter_block(content)
        .and_then(|b| front_matter_field(b, "authors"))
        .map(|raw| parse_toml_string_array(&raw))
        .unwrap_or_default();

    if current.iter().any(|a| a.eq_ignore_ascii_case(&name)) {
        return content.to_string();
    }

    let mut updated = current;
    updated.push(name);
    stamp_table_field(content, "extra", "authors", &format_toml_string_array(&updated)).unwrap_or_else(|| content.to_string())
}

/// A URL/filename-safe slug: unlike `slugify` (git.rs - used for git branch
/// names, where a run of dashes or a trailing one doesn't matter), this
/// collapses consecutive separators and trims the ends so it reads cleanly
/// as both a filename and the page's actual public URL segment.
pub fn content_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            slug.push(c);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_end_matches('-').to_string()
}
