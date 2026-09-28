default:
    @just --list

# Fetch the Zola sidecar binary (skips if already present; pass --force to re-fetch)
fetch-zola *ARGS:
    ./scripts/fetch-zola-sidecar.sh {{ARGS}}

# Run the app in dev mode (fetches the sidecar first if missing)
dev: fetch-zola
    cargo tauri dev

# Build the app (fetches the sidecar first if missing)
build: fetch-zola
    cargo tauri build

# Build the admin CLI (beedance-cli) - cargo tauri build above only builds the app target, not other workspace members
build-cli:
    cargo build -p beedance-cli --release

# Build both the app and the CLI
build-all: build build-cli

# Vendor a Zola theme from a git repo into <site>/themes/<name>
add-theme name url:
    ./scripts/add-theme.sh {{name}} {{url}}

# Point the app at a real site directory instead of the bundled sample-site
set-site path:
    ./scripts/set-site.sh {{path}}

# Remove this app's personal config (site pointer, author name, R2/GitHub
# credentials) - backed up by default; pass --no-backup to skip that.
# Never touches a site's own content or repo.
uninstall *ARGS:
    ./scripts/uninstall.sh {{ARGS}}

# Build the Docker image used by docker-check/docker-build (see build.Dockerfile)
docker-image:
    docker build -t beedance-tauri-check -f build.Dockerfile .

# cargo check against src-tauri/ inside Docker (for a host without the Tauri
# system deps installed) - always run with --user matching this host user, or
# every file it writes ends up root-owned and blocks a plain host-side cargo
# afterward. --cap-add=DAC_OVERRIDE is a HACK working around a permission
# error Tauri's own build script hits processing capabilities/*.json under
# this bind mount when NOT running as root - root cause not understood (the
# files/dirs involved have completely normal ownership and permissions).
# Reviewed 2026-09-27: scoped tightly enough to be acceptable for now (see
# pws-y8t's notes for the full writeup), but it's still a bypass of normal
# permission checks, not a real fix - next time this is touched, try
# dropping it first and see if it's still needed (a Tauri/Docker version
# bump may have fixed the underlying bug by then).
docker-check: docker-image
    mkdir -p .docker-cargo-cache/registry .docker-cargo-cache/git
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        --cap-add=DAC_OVERRIDE \
        -v "$(pwd):/work" \
        -v "$(pwd)/.docker-cargo-cache/registry:/usr/local/cargo/registry" \
        -v "$(pwd)/.docker-cargo-cache/git:/usr/local/cargo/git" \
        -w /work/src-tauri \
        beedance-tauri-check \
        cargo check

# Same as docker-check, but also verifies linking
docker-build: docker-image
    mkdir -p .docker-cargo-cache/registry .docker-cargo-cache/git
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        --cap-add=DAC_OVERRIDE \
        -v "$(pwd):/work" \
        -v "$(pwd)/.docker-cargo-cache/registry:/usr/local/cargo/registry" \
        -v "$(pwd)/.docker-cargo-cache/git:/usr/local/cargo/git" \
        -w /work/src-tauri \
        beedance-tauri-check \
        cargo build

# Cut a release: fast-forwards the "release" branch to main and pushes it
# to whichever remote is actually GitHub. That push is the ENTIRE release
# trigger - .github/workflows/release.yml fires on it, reads src-tauri/
# Cargo.toml's version, creates the matching "app-v<version>" tag itself,
# and builds+drafts the GitHub Release for macOS/Windows/Linux (see that
# workflow's own header comment). There's no separate manual `git tag`
# step despite this recipe's name being about tagging - the tag is a side
# effect of the push, not something done here.
#
# This repo has two remotes (a private git server as "origin", GitHub as
# "github" - see `git remote -v`) and only the one actually pointing at
# github.com can trigger Actions - looked up by URL, not assumed to be
# named "github", in case that ever changes.
#
# Bump the version in src-tauri/Cargo.toml (and let Cargo.lock pick it up
# via a normal `cargo check`/`just docker-check`) and commit that on main
# FIRST - this recipe only moves branches and pushes, it never edits or
# commits anything itself.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "$(git status --porcelain)" ]; then
        echo "Working tree isn't clean - commit or stash first." >&2
        exit 1
    fi
    current_branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$current_branch" != "main" ]; then
        echo "Not on main (on '$current_branch') - switch to main first." >&2
        exit 1
    fi
    gh_remote="$(git remote -v | awk '$3 == "(push)" && $2 ~ /github\.com/ {print $1}' | sort -u)"
    if [ -z "$gh_remote" ]; then
        echo "No remote points at github.com (checked 'git remote -v') - can't find the one Actions runs from." >&2
        exit 1
    fi
    if [ "$(echo "$gh_remote" | wc -l)" -gt 1 ]; then
        echo "More than one remote points at github.com - not sure which to use:" >&2
        echo "$gh_remote" >&2
        exit 1
    fi
    repo_path="$(git remote get-url "$gh_remote" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
    git fetch "$gh_remote" main release
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$gh_remote/main")" ]; then
        echo "Local main isn't in sync with $gh_remote/main - pull/push there first." >&2
        exit 1
    fi
    version="$(grep -m1 '^version' src-tauri/Cargo.toml | sed -E 's/version *= *"([^"]+)"/\1/')"
    echo "About to release version $version:"
    echo "  - fast-forward 'release' to main (@ $(git rev-parse --short HEAD))"
    echo "  - push 'release' to '$gh_remote' ($repo_path), triggering the Release workflow"
    echo "  - CI creates tag app-v$version and a draft GitHub Release"
    read -r -p "Proceed? [y/N] " reply
    if [ "$reply" != "y" ] && [ "$reply" != "Y" ]; then
        echo "Aborted."
        exit 1
    fi
    git checkout release
    git merge --ff-only "$gh_remote/release"
    git merge --ff-only main
    git push "$gh_remote" release
    git checkout main
    echo "Pushed app-v$version to release. Watch it build:"
    echo "  https://github.com/$repo_path/actions/workflows/release.yml"
