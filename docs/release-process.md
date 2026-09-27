# Cutting a release

Admin/maintainer process for publishing a new installable build. Not needed
just to develop or use the app - see the top-level README for that.

## Versioning

The version number lives in exactly one place: `src-tauri/Cargo.toml`'s
`package.version`. `tauri.conf.json` has no `version` field of its own -
Tauri falls back to the Cargo package version automatically when it's
absent, so there's nothing to keep in sync by hand.

To cut a new version, bump `version` in `src-tauri/Cargo.toml` (and run
`just docker-check` or `cargo check` to confirm `Cargo.lock` picks it up).

## Triggering a build

The release workflow (`.github/workflows/release.yml`) only runs on a push
to the `release` branch (not `main`, so routine commits don't trigger a full
macOS/Windows/Linux build every time) or a manual run via `workflow_dispatch`.

```
git checkout release          # first time: git checkout -b release main
git merge --ff-only main
git push github release       # remote is "github", not "origin" - see below
```

This repo has two remotes: `origin` points at the local gitserver used for
day-to-day work, `github` points at github.com. The release workflow only
exists on GitHub, so the push has to go to `github` specifically for
anything to actually trigger.

## What happens automatically

GitHub Actions builds native installers for all five targets (macOS
aarch64 + x86_64, Windows, Linux) and uploads them to a **draft** GitHub
Release named after the Cargo version (e.g. `app-v0.1.0`) - a draft release
isn't publicly visible, and re-running the workflow for the same version
updates that same draft rather than creating duplicates.

Everything free on GitHub-hosted runners for a public repo, including
macOS/Windows.

## Publishing it

Nothing goes public until a human reviews and publishes the draft - on
purpose, so a bad build never becomes visible to a real user by accident.

```
gh release view app-v<version> --web    # opens it in a browser to review
```

Then click **"Publish release"** on that page. (Or use `gh release edit
app-v<version> --draft=false` from the CLI instead, if you'd rather skip the
browser.)

While a release is still a draft, its own download links can show up under
a placeholder `untagged-<hash>` URL rather than the real version tag -
that's normal, expected GitHub behavior for an unpublished draft, not a
sign anything's wrong. It resolves to the real `app-v<version>` tag/URLs as
soon as you publish it.

## Known gap: the app icon

`src-tauri/icons/` currently holds a real, correctly-formatted icon set
(`.ico`, `.icns`, the PNG sizes), but it was generated from a 1x1 placeholder
pixel, not real artwork - every installer's icon is a blank square right
now. Replace `src-tauri/icons/icon.png` with real square artwork (1024x1024
recommended) and regenerate the set before actually publishing a release
anyone's meant to take seriously:

```
cargo tauri icon src-tauri/icons/icon.png -o src-tauri/icons
```
