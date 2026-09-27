#!/usr/bin/env bash
# Downloads the pinned Zola release and places it as a Tauri sidecar binary
# under src-tauri/binaries/, named per Tauri's <name>-<target-triple>
# convention (Tauri appends this suffix - and .exe on Windows - itself at
# build time; externalBin in tauri.conf.json stays a single "binaries/zola"
# regardless of platform).
#
# Auto-detects the host OS/arch and fetches the matching Zola release asset:
# macOS (Intel or Apple Silicon), Linux (x86_64 or aarch64), and Windows when
# run under a bash environment (Git Bash/MSYS/WSL - `unzip` must be on PATH).
# A genuinely native (non-bash) Windows path still needs its own script - see
# beedance-ssg-editor: Windows build support in the project's issue tracker.
#
# Set ZOLA_TARGET_TRIPLE to override auto-detection and fetch for a specific
# target regardless of this host's own arch - needed when CROSS-compiling
# (e.g. GitHub's macos-latest runners are Apple Silicon, but the release
# workflow also builds an x86_64-apple-darwin target on that same host -
# uname -m there reports arm64 either way, which would otherwise fetch the
# wrong binary and fail with "resource path ... doesn't exist" at build time,
# found the hard way on the very first real CI run).
#
# Run from the repo root.
set -euo pipefail

ZOLA_VERSION="0.23.6"

if [[ -n "${ZOLA_TARGET_TRIPLE:-}" ]]; then
    TARGET_TRIPLE="$ZOLA_TARGET_TRIPLE"
    case "$TARGET_TRIPLE" in
        *-pc-windows-msvc) ARCHIVE_EXT="zip" ;;
        *) ARCHIVE_EXT="tar.gz" ;;
    esac
else
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Darwin)
            ARCHIVE_EXT="tar.gz"
            case "$ARCH" in
                arm64|aarch64) TARGET_TRIPLE="aarch64-apple-darwin" ;;
                x86_64) TARGET_TRIPLE="x86_64-apple-darwin" ;;
                *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
            esac
            ;;
        Linux)
            ARCHIVE_EXT="tar.gz"
            case "$ARCH" in
                aarch64|arm64) TARGET_TRIPLE="aarch64-unknown-linux-gnu" ;;
                x86_64) TARGET_TRIPLE="x86_64-unknown-linux-gnu" ;;
                *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
            esac
            ;;
        MINGW*|MSYS*|CYGWIN*)
            # Git Bash/MSYS on Windows. Zola only ships an x86_64 Windows build.
            ARCHIVE_EXT="zip"
            TARGET_TRIPLE="x86_64-pc-windows-msvc"
            ;;
        *)
            echo "Unsupported OS: $OS" >&2
            exit 1
            ;;
    esac
fi

ZOLA_ASSET="zola-v${ZOLA_VERSION}-${TARGET_TRIPLE}.${ARCHIVE_EXT}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
BIN_NAME="zola-${TARGET_TRIPLE}"
if [[ "$ARCHIVE_EXT" == "zip" ]]; then
    BIN_NAME="${BIN_NAME}.exe"
fi
DEST="$BIN_DIR/$BIN_NAME"

if [[ -x "$DEST" ]]; then
    if [[ -n "${ZOLA_TARGET_TRIPLE:-}" ]]; then
        # Cross-compiling for a target this host can't necessarily execute
        # (e.g. an x86_64 binary on an Apple Silicon runner) - can't ask it
        # its own version, so just trust it's already there; pass --force to
        # refetch (e.g. after bumping ZOLA_VERSION).
        if [[ "${1:-}" != "--force" ]]; then
            echo "Already present: $DEST (cross-compile target, version not checked)"
        else
            FETCHED=1
        fi
    else
        installed_version="$("$DEST" --version 2>/dev/null | awk '{print $2}')"
        if [[ "$installed_version" == "$ZOLA_VERSION" && "${1:-}" != "--force" ]]; then
            echo "Already present: $DEST ($installed_version, matches pinned version)"
        else
            echo "Installed sidecar is $installed_version, pinned version is $ZOLA_VERSION - re-fetching."
            FETCHED=1
        fi
    fi
else
    FETCHED=1
fi

if [[ "${FETCHED:-}" == "1" ]]; then
    mkdir -p "$BIN_DIR"

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    curl -sL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/${ZOLA_ASSET}" -o "$TMP_DIR/$ZOLA_ASSET"

    if [[ "$ARCHIVE_EXT" == "zip" ]]; then
        unzip -q "$TMP_DIR/$ZOLA_ASSET" -d "$TMP_DIR"
        mv "$TMP_DIR/zola.exe" "$DEST"
    else
        tar -xzf "$TMP_DIR/$ZOLA_ASSET" -C "$TMP_DIR"
        mv "$TMP_DIR/zola" "$DEST"
    fi
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

if [[ -n "${ZOLA_TARGET_TRIPLE:-}" ]]; then
    echo "Fetched (cross-compile target, not executed on this host): $DEST"
else
    "$DEST" --version
fi
