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

Writes `~/.config/beedance-ssg-editor/site_dir`, which the app reads on every
launch (a `BEEDANCE_SITE_DIR` env var overrides this if set). Remove that file
to fall back to `sample-site/` again.

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
