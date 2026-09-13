#!/usr/bin/env bash
# Points beedance-ssg-editor at a real site directory instead of the bundled
# sample-site/. Writes ~/.config/beedance-ssg-editor/site_dir, which the app
# reads on every launch (BEEDANCE_SITE_DIR env var overrides this if set).
#
# Usage: scripts/set-site.sh /absolute/or/relative/path/to/site
set -euo pipefail

RAW_PATH="${1:?usage: set-site.sh /path/to/site}"
SITE_DIR="$(cd "$RAW_PATH" && pwd)"

# Matches the Rust app's own config_dir() (via the `dirs` crate): XDG_CONFIG_HOME
# (or ~/.config) on Linux, ~/Library/Application Support on macOS - so this CLI
# path and the in-app "Change site" picker always agree on where the pointer lives.
case "$(uname -s)" in
    Darwin) CONFIG_ROOT="$HOME/Library/Application Support" ;;
    *) CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
esac
CONFIG_DIR="$CONFIG_ROOT/beedance-ssg-editor"
mkdir -p "$CONFIG_DIR"
echo "$SITE_DIR" > "$CONFIG_DIR/site_dir"

echo "Site set to: $SITE_DIR"
if [[ ! -f "$SITE_DIR/config.toml" ]]; then
    echo "Warning: no config.toml found there - is this actually a Zola site directory?"
fi
