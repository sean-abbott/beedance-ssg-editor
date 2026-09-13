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

if [[ -x "$DEST" && "${1:-}" != "--force" ]]; then
    echo "Already present: $DEST (pass --force to re-fetch)"
    "$DEST" --version
    exit 0
fi

mkdir -p "$BIN_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/${ZOLA_ASSET}" -o "$TMP_DIR/zola.tar.gz"
tar -xzf "$TMP_DIR/zola.tar.gz" -C "$TMP_DIR"
mv "$TMP_DIR/zola" "$DEST"
chmod +x "$DEST"

echo "Installed sidecar: $DEST"
"$DEST" --version
