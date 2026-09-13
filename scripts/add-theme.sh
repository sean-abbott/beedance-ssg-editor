#!/usr/bin/env bash
# Vendors a Zola theme into sample-site/themes/<name> as a plain copy (not a
# git submodule - keeps this a single-repo spike instead of adding submodule
# bookkeeping). Set theme = "<name>" in sample-site/config.toml to activate it.
#
# Usage: scripts/add-theme.sh <name> <git-url>
set -euo pipefail

NAME="${1:?usage: add-theme.sh <name> <git-url>}"
URL="${2:?usage: add-theme.sh <name> <git-url>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/sample-site/themes/$NAME"

if [[ -d "$DEST" ]]; then
    echo "Already present: $DEST (remove it first to re-fetch)"
    exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

git clone --depth 1 "$URL" "$TMP_DIR/theme"
rm -rf "$TMP_DIR/theme/.git"
mkdir -p "$(dirname "$DEST")"
mv "$TMP_DIR/theme" "$DEST"

echo "Vendored theme '$NAME' into $DEST"
echo "Set theme = \"$NAME\" in sample-site/config.toml to activate it."
