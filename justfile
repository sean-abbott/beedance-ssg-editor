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
