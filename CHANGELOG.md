# Changelog

## 0.3.0 - 2026-10-05

### Added

- Drafts pane: a dedicated sidebar destination for switching between local drafts, with a
  persistent header indicator showing which one you're on (or "Live (main)" when you're not).
- Full review workflow: open a pull request from a draft, review someone else's draft
  read-only with inline feedback comments, approve it, and publish (merge) your own back to
  the live site - all without leaving the app or touching git directly.
- Reviews page, separate from Drafts, for reviewing someone else's work; a Reviews-specific
  banner shows if the draft you're reviewing gets published while you're still looking at it.
- Feedback: leave and read comments on a draft directly in the app, backed by GitHub PR
  comments.
- Publish to live site: merge your own draft's pull request with one click - author-only,
  enforced by the GitHub API itself, not just hidden in the UI; falls back to "Open on
  GitHub" for anything more complicated than a clean merge.
- Detects a draft that was already published (merged) outside the app and offers to clean up
  the stale local branch; also supports deleting a draft you've simply abandoned.
- Frontmatter box: a page's title/date/tags/authors/template/etc. show de-emphasized and
  read-only above the body text instead of mixed into one editable block. A "manually edit"
  toggle still lets you touch the raw block directly, and any field the app doesn't have a
  dedicated label for still lists (never hidden) below a divider.
- First-use guided tour, highlighting the sidebar, Start preview, the header's draft
  indicator, and Settings - re-triggerable anytime from the compass button in the header,
  with a Settings toggle to turn off the automatic first-launch popup.
- Internal link autocomplete: the Link toolbar button can search this site's own pages by
  title or path and insert a correct link, instead of requiring a hand-typed path; clicking
  Link while already inside an existing link now re-opens it for editing instead of
  inserting a duplicate next to it.
- Multi-editor safety: an optional per-site setting (auto-detected once more than one author
  has ever saved a page, or set manually) warns before checkpointing or sending changes
  directly to the live branch, with a real choice (start a draft instead, or proceed
  anyway) rather than just blocking you. A one-click option sets up real GitHub branch
  protection (or links to GitHub's own settings to do it by hand) requiring a pull request
  before anything reaches the live site.
- GitHub personal access token validation in Settings - checks the token is actually valid
  and has the permissions this app needs, rather than finding out the hard way later.
- Phone-preview size is now a standing preference that persists across restarts and applies
  whether or not a preview window happens to be open, instead of only working while one
  already was.
- A real app icon (a bumblebee + flight trail, CC0-licensed art), replacing the placeholder.

### Changed

- In-app template (Tera/HTML) editing removed - this app is content-only now. Template,
  CSS, and JS changes belong in a dedicated code editor; the file picker and Open-file
  search only ever show content files.
- "Commit" renamed to "checkpoint" throughout the user-facing text, to avoid git jargon.
- The live branch is labeled "Live (main)" everywhere it used to just show the raw branch
  name; editing it directly with unsaved changes (not a draft) gets its own warning-colored
  indicator instead of looking identical to a clean live site.
- The header's draft indicator is a real dropdown (Review & checkpoint, Publish, Go to
  Drafts) on every page except the Editor, which already has its own banner for those same
  actions.

### Fixed

- The preview window navigates directly to the site instead of using an embedded iframe -
  fixes back/forward/reload, which never reliably worked under the old design.
- Autosaving a brand-new post, before it has any frontmatter stamped yet, no longer moves
  the cursor elsewhere in the document mid-typing.
- Discarding an uncommitted change to a file now properly reverts it on disk and no longer
  leaves branch-switching blocked afterward.
- Reviewing someone else's draft no longer lets your own pull requests show up as
  reviewable.
- Switching branches (or discarding a file) no longer triggers a false "changed on disk
  externally" notification for a file that was only changed by that same action.
- The Pages list's tag "+N" overflow count now always matches what's actually hidden,
  instead of occasionally being off by a couple.

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
