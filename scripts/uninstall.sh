#!/usr/bin/env bash
# Removes this app's PERSONAL config only - the site pointer (site_dir),
# author display name, R2 upload credentials, and GitHub PAT/username.
# Never touches a site's own content or repo, or its own .beedance/ site
# config - those live inside the site directory itself, wherever that is,
# not here.
#
# Backed up by default, next to the config directory itself, with a
# timestamp suffix; pass --no-backup to skip that and just remove it.
#
# Usage: scripts/uninstall.sh [--no-backup]
set -euo pipefail

# Matches the Rust app's own config_dir() (via the `dirs` crate) and
# set-site.sh's own copy of this same logic - see that script's comment for
# why (so the CLI and the app always agree on where this lives).
case "$(uname -s)" in
    Darwin) CONFIG_ROOT="$HOME/Library/Application Support" ;;
    *) CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
esac
CONFIG_DIR="$CONFIG_ROOT/beedance-ssg-editor"

if [[ ! -d "$CONFIG_DIR" ]]; then
    echo "No config directory found at $CONFIG_DIR - nothing to remove."
    exit 0
fi

if [[ "${1:-}" != "--no-backup" ]]; then
    BACKUP_DIR="${CONFIG_DIR}.backup-$(date +%Y%m%d%H%M%S)"
    cp -R "$CONFIG_DIR" "$BACKUP_DIR"
    echo "Backed up to: $BACKUP_DIR"
fi

rm -rf "$CONFIG_DIR"
echo "Removed: $CONFIG_DIR"
