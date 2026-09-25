# Roadmap

A lightweight, living list of where the project is headed. Not a commitment
or a schedule.

## Done

- Image insert pipeline: file picker and drag/drop, EXIF-stripping
  normalize, page-bundle vs. site-wide `static/` placement (with correct
  `index.md`/`_index.md` bundle detection). Generalized past the original
  "pick a size tier" idea into direct, aspect-ratio-linked width/height/
  quality fields, with "Web standard"/"High detail" as Settings-adjustable
  quick-fill presets rather than the only choices. Picked up along the way:
  shrink-only resize-in-place for an already-inserted image, and a
  contextual alignment toolbar (left/center/right via raw `<img style>`
  tags - CommonMark-guaranteed to render regardless of SSG).
- Zola-specific conventions (directory layout, the `index.md`/`_index.md`
  distinction, the sidecar binary details) centralized in
  `src-tauri/src/zola.rs` instead of scattered inline - not a multi-SSG
  plugin system, just a named boundary around the one SSG this app actually
  supports today, so the next SSG-aware feature has one place to extend
  rather than re-deriving conventions from scratch.

## What's next

In rough build order.

1. Insert an image by URL: fetches the image once to confirm it's usable and
   show a local preview, but keeps the reference as a live external link -
   no download, no reprocessing, since an externally-hosted image is
   whatever size and quality it already is.
2. Localize an existing remote image reference: reuses the insert pipeline,
   just sourced from a URL fetch instead of a file dialog, for content that
   currently points at images hosted elsewhere and needs to stop depending
   on that host staying up.
3. Pluggable image storage backend: committing into the site's own repo is
   the zero-config default; an S3-compatible object store (Cloudflare R2,
   AWS S3, etc.) is an alternate backend for sites that outgrow that. Note
   that a static site generator's own responsive-image processing generally
   still needs a local copy of the original at build time, regardless of
   where it's archived long-term.
4. Pluggable per-SSG image-embed adapter: plain markdown image syntax as the
   universal fallback, upgrading to a theme's own image shortcode/component
   when the site defines one, so the generator's own build-time image
   processing actually gets used.
5. Menu / site-structure editing: not just page content. A menu isn't just a
   syntax difference per SSG the way links/images are - it's a different
   data shape (Zola has no native menu concept at all; Hugo has a real
   structured one) - likely needs its own opinionated internal model
   (`{label, target, children, weight}` or similar) with a Zola-specific
   serializer as the only implementation today, following the same
   centralization pattern as `zola.rs`.
6. An in-app version-control client for non-technical authors: review what
   changed and commit it, and sync with the remote, entirely through the
   app - no terminal, no separate tool to learn.

## Unprioritized future work

Real ideas, not yet ordered or scheduled.

- SSG-aware internal link insertion: an "Add internal link" button that lets
  an author pick another page in the site and have the editor emit whatever
  internal-link syntax that site's actual static site generator needs (e.g.
  Zola's content-relative paths, Hugo's `ref`/`relref` shortcodes), rather
  than requiring the author to know or hand-type SSG-specific link syntax.
- Insert an image via clipboard paste (a screenshot, or an image copied from
  a browser), as a third source alongside the file picker and drag/drop.
- Windows build support: this app currently only builds on Linux/macOS. A
  Windows build needs its own documented prerequisites (Visual Studio Build
  Tools, WebView2, the Rust MSVC target) and a Windows-target variant of the
  Zola sidecar fetch, plus real testing on a Windows machine.
