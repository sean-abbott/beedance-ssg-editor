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
