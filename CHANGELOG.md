# Changelog

## 0.2.0 - 2026-09-27

### Changed

- Major visual redesign: left-sidebar layout (site switcher; Editor/Pages/Media/Tags/Settings
  nav) replaces the old header-plus-toolbar-row stack. New typography/spacing/shadow/color
  design tokens, an inline SVG icon set, and dropdown "app menus" (File/Insert/branch) in
  place of a flat row of buttons.
- Tags, Pages, Media, and Settings are now full pages reached from the sidebar, not modals.
  The site navigation editor moved from its own "Site menu..." modal into a section of the
  Pages page.
- Settings splits into "This installation" (personal, local-only) and "This site" (shared,
  committed) sections, visually set apart.
- Start/Stop preview, Phone preview, and Preview log moved into a persistent header so
  they're available from every page, not just the Editor.
- "Review a PR..." renamed to "Review someone's draft...", "Preview Server Log" renamed to
  "Preview log" - avoids introducing PR/git jargon for non-technical users.
- Settings has a working Blue/Bee theme switcher; Bee stays visually distinct (yellow/black/
  green) regardless of the OS's light/dark setting.

### Added

- Media library: real thumbnails, a per-image "..." menu (Rename, Edit alt text, Move between
  Local and R2), bulk "select all unused" plus a review-and-delete checklist, and detection +
  one-click (or bulk) localization of image references still pointing at an external host.
- Pages page: a browsable, filterable list of every page/post (by kind, title, and tag), with
  a tag-count click-through from the Tags page and a "used on N pages" click-through from the
  Media page, each landing here pre-filtered.
- Tags page: a persistent "Required" badge that hard-blocks rename/delete for any tag
  referenced by name in a template, and a search filter.
- Escape cancels an in-progress tag rename.

### Fixed

- Dropdown and kebab menus no longer get invisibly clipped inside a rounded, overflow:hidden
  container (e.g. Media's per-card menu) - they position against the viewport instead of the
  nearest positioned ancestor.
- Disabled buttons and inputs are visibly greyed out app-wide, instead of looking identical
  to enabled ones.
- The Media library now scans all of `static/`, not just `static/images/`, so images stored
  elsewhere under `static/` actually show up.

## 0.1.0

- Initial release.
