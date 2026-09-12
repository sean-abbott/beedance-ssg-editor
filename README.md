Desktop app (Tauri) for editing a markdown-and-frontmatter, git-backed static
site, driving an existing static site generator (Hugo/Zola) as a bundled
sidecar process instead of reimplementing a render pipeline.

Currently a walking-skeleton spike (bd epic `pws-fgf`) validating: Tauri
sidecar process spawning, an SSG as sidecar, git as the content backend, and
detecting external edits to open files (e.g. from an agent editing in the
background) while the app is running.

# Build

See `~/tmp/validate-beedance-tauri-shell.txt` for local setup/run steps.
