#!/usr/bin/env bash
# Installs orx from GitHub Releases:
#
#   curl -fsSL https://github.com/rileyhilliard/orx/releases/latest/download/install.sh | bash
#
# Downloads the binary for this OS and CPU, checks it against the release's SHA256SUMS, and
# installs it as $ORX_INSTALL_DIR/orx (default ~/.local/bin). Nothing is installed if the
# checksum doesn't match. Settings (env):
#   ORX_INSTALL_DIR    where to put orx (default ~/.local/bin)
#   ORX_VERSION        a tag like v0.2.0 (default: the latest release)
#   ORX_RELEASES_REPO  owner/repo (default rileyhilliard/orx)
#   ORX_RELEASES_URL   the GitHub API base (default https://api.github.com; tests use a stub)
set -euo pipefail

repo="${ORX_RELEASES_REPO:-rileyhilliard/orx}"
api="${ORX_RELEASES_URL:-https://api.github.com}"
dir="${ORX_INSTALL_DIR:-$HOME/.local/bin}"
version="${ORX_VERSION:-}"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no orx build for $(uname -s); build from source (see README)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no orx build for $(uname -m)" ;;
esac
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl Linux (Alpine) isn't supported yet; use a glibc distro or build from source"
fi
# Under Rosetta, uname says x86_64 on an Apple Silicon Mac; the native build is faster.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="orx-$os-$arch"

if [ -n "$version" ]; then
  release_url="$api/repos/$repo/releases/tags/$version"
else
  release_url="$api/repos/$repo/releases/latest"
fi
release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$release_url")" ||
  fail "couldn't read $release_url"

# The download URL of a named asset, from the release JSON (no jq needed).
url_of() {
  printf '%s' "$release" | tr ',' '\n' | grep '"browser_download_url"' | sed -E 's/.*"browser_download_url" *: *"([^"]+)".*/\1/' |
    grep -E "/$1\$" | head -n 1
}
binary_url="$(url_of "$asset")"
sums_url="$(url_of SHA256SUMS)"
[ -n "$binary_url" ] || fail "the release has no $asset"
[ -n "$sums_url" ] || fail "the release has no SHA256SUMS"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$binary_url" -o "$tmp/$asset" || fail "couldn't download $binary_url"
curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS" || fail "couldn't download $sums_url"

expected="$(awk -v name="$asset" '{ file = $2; sub(/^\*/, "", file); if (file == name) print $1 }' "$tmp/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ -n "$expected" ] || fail "SHA256SUMS has no line for $asset"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); nothing installed"

mkdir -p "$dir"
chmod 0755 "$tmp/$asset"
# Moved into place in one step, so a running orx is never overwritten mid-read.
mv -f "$tmp/$asset" "$dir/orx"
echo "Installed orx to $dir/orx"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, e.g.: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc" ;;
esac
