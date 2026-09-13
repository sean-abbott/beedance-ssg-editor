#!/usr/bin/env bash
# Vendors a Zola theme into <site>/themes/<name> as a plain copy (not a git
# submodule - keeps this a single-repo affair instead of adding submodule
# bookkeeping). Set theme = "<name>" in <site>/config.toml to activate it.
#
# <site> is resolved the same way the app itself resolves it: $BEEDANCE_SITE_DIR
# env var, else ~/.config/beedance-ssg-editor/site_dir (written by
# `just set-site`), else this repo's bundled sample-site/.
#
# Usage: scripts/add-theme.sh <name> <git-url>
set -euo pipefail

NAME="${1:?usage: add-theme.sh <name> <git-url>}"
URL="${2:?usage: add-theme.sh <name> <git-url>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${BEEDANCE_SITE_DIR:-}" ]]; then
    SITE_DIR="$BEEDANCE_SITE_DIR"
elif [[ -s "$HOME/.config/beedance-ssg-editor/site_dir" ]]; then
    SITE_DIR="$(cat "$HOME/.config/beedance-ssg-editor/site_dir")"
else
    SITE_DIR="$REPO_ROOT/sample-site"
fi

DEST="$SITE_DIR/themes/$NAME"

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
echo "Set theme = \"$NAME\" in $SITE_DIR/config.toml to activate it."
