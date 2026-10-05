Desktop app (Tauri) for editing a markdown-and-frontmatter, git-backed static
site, driving an existing static site generator (Zola, via a bundled sidecar)
instead of reimplementing a render pipeline. See `docs/theme-architecture.md`
for the theme-compatibility and cross-backend design thinking, and
`docs/user-guide.md` for the full day-to-day user guide once it's installed.

> **Alpha.** Actively developed, used for real by a small group, but still
> rough in places - expect bugs, missing polish, and things that change
> between versions. Feedback and bug reports are genuinely useful at this
> stage - open one at
> [this repo's Issues page](https://github.com/sean-abbott/beedance-ssg-editor/issues).

# Install

Download the latest release for your OS from
[this repo's Releases page](https://github.com/sean-abbott/beedance-ssg-editor/releases) -
no build tools or command line needed.

- **macOS**: download the `.dmg` (`aarch64` for Apple Silicon Macs, `x86_64`
  for Intel), open it, and drag the app into Applications.
- **Windows**: download and run the `.msi` installer.
- **Linux**: download the `.deb` or `.rpm`, whichever matches your
  distribution.

## About the security warning on first launch

The first time you open it, macOS or Windows will likely show a warning -
macOS says it's "from an unidentified developer" (or won't offer to open it
at all); Windows says "Windows protected your PC". Both mean the same thing:
this app isn't signed with a paid developer certificate, not that anything's
actually wrong with it. Every unsigned app gets this same warning, regardless
of whether it's trustworthy - it's not a judgment about this app
specifically.

Why it's unsigned: Apple's developer program is $99/year, and Windows
code-signing certificates cost money too, recurring, indefinitely, for a free
open-source tool maintained on no particular budget. On top of the cost,
properly signing and notarizing a macOS build also effectively requires a
Mac to set up and maintain that pipeline on - this project doesn't have one.
Neither cost is worth it just to make a one-time warning disappear; the
sections below exist instead so you can get past that warning (or verify the
build yourself) without paying for either.

- **Windows**: click "More info", then "Run anyway".
- **macOS**: right-click (or Control-click) the app in Applications and
  choose "Open", then confirm "Open" in the dialog that appears - you only
  need to do this once. If right-clicking doesn't offer an "Open" option (or
  nothing happens), open System Settings → Privacy & Security, scroll to the
  Security section, and click "Open Anyway" next to the message about this
  app, then confirm in the dialog that follows. If that still doesn't work,
  the Terminal fallback is to clear the quarantine attribute Gatekeeper
  checks directly:
  ```
  xattr -cr /Applications/beedance-ssg-editor.app
  ```
  (adjust the path if you installed it somewhere else), then open the app
  normally.

If you'd rather not take any of that on trust: this project is open source
(see `LICENSE`), the release you downloaded was built directly from this
repository's own source by GitHub's public build servers (not hand-assembled
and uploaded), and you're always free to build it yourself from source
instead (see "Setup" below) - or, if you do have a paid Apple developer
account and want to sign/notarize your own build, see Tauri's own writeup on
macOS code signing and notarization:
[v2.tauri.app/distribute/sign/macos](https://v2.tauri.app/distribute/sign/macos/).

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

Settings live in one of two places, and the app's own Settings page is split
into matching sections (see `docs/user-guide.md` for the full reference):

- **Site config** (`<site>/.beedance/`) - committed to the site's own repo,
  shared by everyone who edits it: image size presets, the R2 bucket/public
  URL a site uploads shared images to, and whether this site is flagged as
  having more than one editor (gates the direct-push-to-live-branch
  warning). Nothing here is ever secret - it has to be safe to assume that
  repo is public, whether or not it actually is.
- **Personal config** (this platform's standard config directory, same one
  `site_dir` lives in, above) - per-installation, never committed: your
  display name, the feature-tour toggle, the network-serve/phone-preview
  toggles, your own R2 credentials (including the account ID, which grants
  no access by itself but still isn't something to commit), and your own
  GitHub personal access token for syncing the site (a fine-grained token,
  scoped to just that one repository, with Contents and Pull requests
  read/write - each collaborator creates their own via GitHub's own token
  settings UI, since unlike R2 credentials one person can't mint a GitHub
  token for someone else). Setting up real branch protection (see "What's
  actually built") additionally needs Administration access on that token.

# What's actually built

See `docs/user-guide.md` for the full walkthrough; this is the short version.

- **Content editing.** Tabbed multi-file editing (each tab has its own
  buffer, dirty indicator, and independent ~1.2s debounced autosave),
  external-edit detection per tab, a frontmatter block shown de-emphasized
  and read-only above the body (known fields like title/date/tags/authors
  laid out plainly, a raw-edit toggle for anything else), a formatting
  toolbar, image insertion, and an internal-link picker that searches the
  site's own pages by title or path instead of requiring a hand-typed path.
  Template (Tera/HTML), CSS, and JS files are deliberately out of scope -
  this app edits content only; use a regular code editor for those.
- **Live preview**, in a separate window (not embedded), with a Back/
  Forward/Reload browser-style toolbar and a phone-size toggle that persists
  as a standing preference. Backed by the SSG's own dev server (`zola
  serve`), so hot-reload comes from the SSG itself, not anything this app
  does.
- **Drafts, review, and publish.** A draft is a real git branch under the
  hood, but nothing about using one requires knowing git: start a draft,
  checkpoint (commit) your changes with a description, send them to GitHub,
  and open a pull request - all from the Drafts page. Review someone else's
  draft read-only with inline feedback and an approve action; publish your
  own draft (author-only, server-enforced) with one click once it's ready.
  A persistent header indicator always shows which draft you're on, or
  "Live (main)" when you're editing the live site directly.
- **Multi-editor safety**: an optional per-site setting (auto-detected once
  more than one author has saved a page, or set manually) that warns before
  checkpointing or sending changes directly to the live branch, plus a
  one-click way to set up real GitHub branch protection requiring review
  before anything reaches the live site - the only protection that can't be
  bypassed by a direct git push outside the app entirely.
- **A first-use guided tour** covering the sidebar, Preview, and the draft
  indicator, re-triggerable anytime, with a Settings toggle to suppress the
  automatic first-launch popup.
- **Git integration**: the site directory is its own repo (auto-`git init`
  if it doesn't have one yet), separate from this app's own repo. `git
  status`/commit/push/pull all operate against the site, not this app.
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
or they'll shadow the theme's own. Customizing the vendored theme's own
templates/CSS/JS afterward needs a regular code editor - this app only edits
content, not template files (see "What's actually built" above).

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
