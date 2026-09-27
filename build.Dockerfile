# Linux build/check environment for this app's Rust side - has every system
# package Tauri v2 needs on Debian/Ubuntu (per Tauri's own prerequisites docs)
# plus libdbus-1-dev, which tauri-plugin-dialog's Linux backend needs via
# pkg-config but isn't in Tauri's own list. Useful on a host that doesn't have
# (or can't easily get) these installed system-wide.
#
# Build the image (from the repo root):
#   docker build -t beedance-tauri-check -f build.Dockerfile .
#
# Run cargo check or cargo build against this repo's src-tauri/, with a
# persistent cache so repeated runs don't re-fetch/re-build every dependency.
# --user matches the invoking host user's uid:gid - the container's default
# user is root, and without this flag every file cargo writes under target/
# and .docker-cargo-cache/ (including target/debug/.cargo-build-lock) ends up
# root-owned, which then blocks that same user from running a plain host-side
# `cargo check` afterward (Permission denied on the lock file) until someone
# manually chowns the directory back:
#   mkdir -p .docker-cargo-cache/registry .docker-cargo-cache/git
#   docker run --rm \
#     --user "$(id -u):$(id -g)" \
#     --cap-add=DAC_OVERRIDE \
#     -v "$(pwd):/work" \
#     -v "$(pwd)/.docker-cargo-cache/registry:/usr/local/cargo/registry" \
#     -v "$(pwd)/.docker-cargo-cache/git:/usr/local/cargo/git" \
#     -w /work/src-tauri \
#     beedance-tauri-check \
#     cargo check
#
# --cap-add=DAC_OVERRIDE is a HACK working around a permission error Tauri's
# own build script hits processing capabilities/*.json under this bind mount
# when NOT running as root (found the hard way, root cause not fully
# understood - something about how a non-root, non-UID-0 process interacts
# with this specific bind-mounted overlay; the files/dirs involved have
# completely normal ownership and permissions on inspection). It grants just
# that one kernel permission-check bypass, not root itself - files this
# writes still come out owned by the host user from --user, not root - but
# it's still a bypass of normal permission checks, not a real fix. Reviewed
# 2026-09-27, judged acceptable given how narrowly it's scoped here (see
# pws-y8t's notes for the full security writeup). Next time this is touched,
# try dropping it first - a Tauri/Docker version bump may have fixed the
# underlying bug by then.
#
# (Prefer `just docker-check` / `just docker-build`, which run this exact
# command with --user and --cap-add already baked in.)
#
# Swap `cargo check` for `cargo build` to also verify linking. Either way, the
# Zola sidecar must already be fetched first (`just fetch-zola`) - the build
# fails otherwise looking for src-tauri/binaries/zola-<target-triple>.
#
# This image cannot produce a runnable GUI (no display server, and Tauri
# commands are still compiled but the app can't actually open a window here) -
# it's for verifying the Rust side compiles and links, not for running the app.
FROM rust:1-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    pkg-config \
    libdbus-1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
