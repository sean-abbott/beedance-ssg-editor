#!/usr/bin/env bash
# Downloads the pinned Zola release and places it as a Tauri sidecar binary
# under src-tauri/binaries/, named per Tauri's <name>-<target-triple> convention.
#
# Run from the repo root. Adjust ZOLA_VERSION/ZOLA_ASSET below for other
# platforms/architectures - this defaults to Linux x86_64.
set -euo pipefail

ZOLA_VERSION="0.23.6"
ZOLA_ASSET="zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
TARGET_TRIPLE="x86_64-unknown-linux-gnu"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
DEST="$BIN_DIR/zola-${TARGET_TRIPLE}"

if [[ -x "$DEST" ]]; then
    installed_version="$("$DEST" --version 2>/dev/null | awk '{print $2}')"
    if [[ "$installed_version" == "$ZOLA_VERSION" && "${1:-}" != "--force" ]]; then
        echo "Already present: $DEST ($installed_version, matches pinned version)"
    else
        echo "Installed sidecar is $installed_version, pinned version is $ZOLA_VERSION - re-fetching."
        FETCHED=1
    fi
else
    FETCHED=1
fi

if [[ "${FETCHED:-}" == "1" ]]; then
    mkdir -p "$BIN_DIR"

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/${ZOLA_ASSET}" -o "$TMP_DIR/zola.tar.gz"
    tar -xzf "$TMP_DIR/zola.tar.gz" -C "$TMP_DIR"
    mv "$TMP_DIR/zola" "$DEST"
    chmod +x "$DEST"

    echo "Installed sidecar: $DEST"
fi

# Tauri's build.rs copies this into target/<profile>/zola, but only when
# cargo actually reruns the build script - which is keyed off cargo's own
# build-script caching, not off whether this file changed or whether the
# copied destination still exists. Deleting/editing the destination
# ourselves does nothing reliable. Force it by cleaning just this package
# (not its dependencies - fast) so the next `cargo tauri dev`/build is
# guaranteed to rerun build.rs and re-copy a fresh, correct sidecar.
cargo clean --manifest-path "$REPO_ROOT/src-tauri/Cargo.toml" -p beedance-ssg-editor 2>/dev/null || true

"$DEST" --version
