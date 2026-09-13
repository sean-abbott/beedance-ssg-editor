Desktop app (Tauri) for editing a markdown-and-frontmatter, git-backed static
site, driving an existing static site generator (Zola, via a bundled sidecar)
instead of reimplementing a render pipeline. See `docs/theme-architecture.md`
for the theme-compatibility and cross-backend design thinking.

# Setup

```
just dev
```

Fetches the pinned Zola sidecar binary automatically on first run (and on any
later version bump). Needs `libwebkit2gtk-4.1-dev`, `build-essential`,
`libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (Linux) and the
Tauri CLI (`cargo install tauri-cli --locked`) installed first.

By default this edits the bundled `sample-site/` (a minimal Zola site, useful
for trying things out). To work on a real site instead:

```
just set-site /path/to/your/site
```

Writes a `site_dir` pointer file to this platform's standard config directory
(e.g. `~/.config/beedance-ssg-editor/` on Linux, `~/Library/Application
Support/beedance-ssg-editor/` on macOS), which the app reads on every launch
(a `BEEDANCE_SITE_DIR` env var overrides this if set). The same directory can
also be switched from inside the app via the "Change site…" button. Remove
that file to fall back to `sample-site/` again.

# What's actually built

- **Tabbed multi-file editing.** The "Open file" dropdown opens a file as a
  new tab (or switches to it if already open); each tab has its own buffer,
  dirty indicator, and independent debounced autosave (~1.2s after typing
  stops). Switching tabs is instant (in-memory), only the first open of a
  file reads from disk. Closing a tab flushes any pending autosave first, so
  in-progress edits are never silently lost.
- **External-edit detection**, per open tab. If a file that's open in some
  tab changes on disk from outside the app (an agent editing in the
  background, another editor), a banner appears - immediately if that tab is
  active, as a colored dot on the tab otherwise. "Reload" discards the
  editor's content and takes the disk version (not a merge); "Ignore"
  dismisses without reloading. The app's own saves are never mistaken for
  external changes (matched per-file, not globally).
- **Live preview**, in a separate window (not embedded), with a Back/
  Forward/Reload browser-style toolbar and a phone-size toggle. Backed by
  the SSG's own dev server (`zola serve`), so hot-reload comes from the SSG
  itself, not anything this app does.
- **Git integration**: the site directory is its own repo (auto-`git init`
  if it doesn't have one yet), separate from this app's own repo. "Start a
  draft" cuts a real `draft/<slug>` branch. `git status`/`git commit` operate
  against the site, not this app.
- **Theme vendoring** (`just add-theme`) and **configurable site directory**
  (`just set-site`) - see below and the Setup section.

# Vendoring a theme

```
just add-theme <name> <git-url>
```

Copies a Zola theme (e.g. `just add-theme abridge https://github.com/jieiku/abridge`)
into `<site>/themes/<name>` - a plain copy, not a git submodule. Set
`theme = "<name>"` in the site's `config.toml` to activate it, and remove any
site-level `templates/` files with the same name as ones the theme provides,
or they'll shadow the theme's own.

# Build

```
just build
```
