Desktop app (Tauri) for editing a markdown-and-frontmatter, git-backed static
site, driving an existing static site generator (Zola, via a bundled sidecar)
instead of reimplementing a render pipeline. See `docs/theme-architecture.md`
for the theme-compatibility and cross-backend design thinking.

# Setup

```
just dev
```

Fetches the pinned Zola sidecar binary for your OS/architecture automatically
on first run (and on any later version bump) - macOS (Intel or Apple
Silicon), Linux (x86_64 or aarch64), and Windows under a bash environment
(Git Bash/MSYS/WSL) are all auto-detected.

Needs the Tauri CLI (`cargo install tauri-cli --locked`) and, per platform:

- **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Microsoft C++ Build Tools ("Desktop development with C++"),
  WebView2 (bundled since Windows 10 v1803+), and the MSVC Rust toolchain as
  default host triple

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

# Site config vs. personal config

Settings live in one of two places, and the app's own Settings dialog is
split into matching tabs:

- **Site config** (`<site>/.beedance/`) - committed to the site's own repo,
  shared by everyone who edits it: image size presets, and the R2 bucket/
  public URL a site uploads shared images to. Nothing here is ever secret -
  it has to be safe to assume that repo is public, whether or not it
  actually is.
- **Personal config** (this platform's standard config directory, same one
  `site_dir` lives in, above) - per-installation, never committed: your
  display name, the network-serve toggle, your own R2 credentials
  (including the account ID, which grants no access by itself but still
  isn't something to commit), and your own GitHub personal access token for
  syncing the site (a fine-grained token, scoped to just that one
  repository, with Contents read/write - each collaborator creates their own
  via GitHub's own token settings UI, since unlike R2 credentials one person
  can't mint a GitHub token for someone else).

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

# Admin tooling: beedance-cli

A separate binary (`cli/`, its own Cargo workspace member - no GTK/webkit
dependency, meant for an admin's terminal, not for every non-technical user
to install) for issuing scoped per-person storage credentials, so a
committee member never has to touch a hosting provider's own dashboard:

```
cargo run -p beedance-cli -- config set-admin-token   # your own top-level Cloudflare API token, once
cargo run -p beedance-cli -- create-user-key           # issues one scoped R2 credential to hand off
```

Only knows how to talk to Cloudflare R2 today - see `src-tauri/src/zola.rs`
for the same "one real implementation, named boundary, no speculative
plugin system" reasoning applied to storage providers instead of SSGs.
