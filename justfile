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

# Build the Docker image used by docker-check/docker-build (see build.Dockerfile)
docker-image:
    docker build -t beedance-tauri-check -f build.Dockerfile .

# cargo check against src-tauri/ inside Docker (for a host without the Tauri
# system deps installed) - always run with --user matching this host user, or
# every file it writes ends up root-owned and blocks a plain host-side cargo
# afterward.
docker-check: docker-image
    mkdir -p .docker-cargo-cache/registry .docker-cargo-cache/git
    docker run --rm \
        --user "$(id -u):$(id -g)" \
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
        -v "$(pwd):/work" \
        -v "$(pwd)/.docker-cargo-cache/registry:/usr/local/cargo/registry" \
        -v "$(pwd)/.docker-cargo-cache/git:/usr/local/cargo/git" \
        -w /work/src-tauri \
        beedance-tauri-check \
        cargo build
