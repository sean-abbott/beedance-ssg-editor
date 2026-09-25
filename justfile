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
