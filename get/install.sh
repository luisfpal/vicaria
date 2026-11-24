#!/bin/sh
# Installs Vicaria for Mac or Linux from the latest GitHub release.
#   curl -fsSL https://luisfpal.github.io/vicaria/install.sh | sh
# Files fetched by curl carry no quarantine mark, so macOS opens the app without the Gatekeeper prompt.
# For tests: VIC_RELEASE_URL points at a folder holding the release files, VIC_APPS at the install folder.
set -eu
REPO=luisfpal/vicaria
BASE=${VIC_RELEASE_URL:-https://github.com/$REPO/releases/latest/download}
say() { printf '%s\n' "$*"; }
fail() { printf 'Vicaria install: %s\n' "$*" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

os=$(uname -s); arch=$(uname -m)
case "$os" in
  Darwin)
    case "$arch" in arm64) a=aarch64 ;; x86_64) a=x64 ;; *) fail "unsupported Mac processor: $arch" ;; esac
    apps=${VIC_APPS:-/Applications}
    [ -w "$apps" ] || apps="$HOME/Applications"
    mkdir -p "$apps"
    say "Downloading Vicaria for Mac ($a)..."
    curl -fsSL "$BASE/latest.json" -o "$tmp/latest.json" || fail "could not read the latest release"
    ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -1)
    [ -n "$ver" ] || fail "latest release has no version"
    curl -fsSL "$BASE/Vicaria_${ver}_${a}.app.tar.gz" -o "$tmp/app.tar.gz" || fail "no Mac build for $a in version $ver"
    mkdir "$tmp/x"; tar -xzf "$tmp/app.tar.gz" -C "$tmp/x"
    [ -d "$tmp/x/Vicaria.app" ] || fail "the download did not contain Vicaria.app"
    rm -rf "$apps/Vicaria.app"; mv "$tmp/x/Vicaria.app" "$apps/Vicaria.app"
    xattr -dr com.apple.quarantine "$apps/Vicaria.app" 2>/dev/null || true
    say "Installed Vicaria $ver in $apps. Open it from Launchpad or Spotlight."
    ;;
  Linux)
    case "$arch" in x86_64) a=amd64 ;; aarch64) a=aarch64 ;; *) fail "unsupported processor: $arch" ;; esac
    bin=${VIC_APPS:-$HOME/.local/bin}
    mkdir -p "$bin"
    say "Downloading Vicaria for Linux ($a)..."
    curl -fsSL "$BASE/latest.json" -o "$tmp/latest.json" || fail "could not read the latest release"
    ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -1)
    [ -n "$ver" ] || fail "latest release has no version"
    curl -fsSL "$BASE/Vicaria_${ver}_${a}.AppImage" -o "$tmp/Vicaria.AppImage" || fail "no Linux build for $a in version $ver"
    chmod +x "$tmp/Vicaria.AppImage"; mv "$tmp/Vicaria.AppImage" "$bin/Vicaria.AppImage"
    say "Installed Vicaria $ver as $bin/Vicaria.AppImage."
    say "On Ubuntu 24.04 and later it needs FUSE 2: sudo apt install libfuse2t64"
    ;;
  *) fail "this installer is for Mac and Linux; see https://luisfpal.github.io/vicaria/get/" ;;
esac
