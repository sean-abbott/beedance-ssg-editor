# Roadmap

A lightweight, living list of where the project is headed. Not a commitment
or a schedule.

## What's next

In rough build order.

1. Image insert pipeline: a file picker and drag/paste both feed the same
   flow - normalize (strip metadata, recompress) and let the author choose
   page-bundle vs. site-wide `static/` placement. Normalization is not a
   single fixed size cap: it offers selectable size/quality tiers, since
   close-up nature or product photography genuinely needs more resolution
   than a typical web photo, while still keeping raw multi-MB originals from
   ever being committed unbounded.
2. Insert an image by URL: fetches the image once to confirm it's usable and
   show a local preview, but keeps the reference as a live external link -
   no download, no reprocessing, since an externally-hosted image is
   whatever size and quality it already is.
3. Localize an existing remote image reference: reuses the same insert
   pipeline from (1), just sourced from a URL fetch instead of a file dialog,
   for content that currently points at images hosted elsewhere and needs to
   stop depending on that host staying up.
4. Pluggable image storage backend: committing into the site's own repo is
   the zero-config default; an S3-compatible object store (Cloudflare R2,
   AWS S3, etc.) is an alternate backend for sites that outgrow that. Note
   that a static site generator's own responsive-image processing generally
   still needs a local copy of the original at build time, regardless of
   where it's archived long-term.
5. Pluggable per-SSG image-embed adapter: plain markdown image syntax as the
   universal fallback, upgrading to a theme's own image shortcode/component
   when the site defines one, so the generator's own build-time image
   processing actually gets used.
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
