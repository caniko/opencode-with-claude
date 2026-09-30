#!/usr/bin/env bash
# =============================================================================
# Point a Homebrew formula at a published npm release of opencode-with-claude.
#
# Downloads the tarball for the given version from the npm registry, computes
# its sha256, and rewrites the formula's `url` and `sha256` lines. The formula
# lives in the ianjwhite99/homebrew-tap repository; the Release workflow runs
# this against a clone of that tap after every `npm publish`. Safe to run by
# hand as well.
#
# Usage:
#   scripts/update-homebrew-formula.sh <path/to/opencode-with-claude.rb> [version]
#
# `version` defaults to the version in this repo's package.json.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="opencode-with-claude"

FORMULA="${1:-}"
if [[ -z "$FORMULA" ]]; then
  echo "usage: $0 <path/to/$PACKAGE.rb> [version]" >&2
  exit 64
fi
if [[ ! -f "$FORMULA" ]]; then
  echo "error: formula not found: $FORMULA" >&2
  exit 1
fi

VERSION="${2:-$(node -p "require('$REPO_ROOT/package.json').version")}"
VERSION="${VERSION#v}"
URL="https://registry.npmjs.org/$PACKAGE/-/$PACKAGE-$VERSION.tgz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/$PACKAGE-$VERSION.tgz"

# A new version's tarball can 404 for minutes after `npm publish` returns:
# 1.10.3 and 1.10.4 were still missing when the old ~2.5 minute window ran out,
# and both published fine. Back off to a one-minute ceiling and keep trying for
# about eight minutes (the Release workflow gives this job 15).
MAX_ATTEMPTS=12
MAX_DELAY=60
delay=5
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if curl -fsSL --retry 2 -o "$TARBALL" "$URL"; then
    break
  fi
  if ((attempt == MAX_ATTEMPTS)); then
    echo "error: could not download $URL after $attempt attempts" >&2
    exit 1
  fi
  echo "tarball not available yet (attempt $attempt/$MAX_ATTEMPTS), retrying in ${delay}s..." >&2
  sleep "$delay"
  delay=$((delay * 2 > MAX_DELAY ? MAX_DELAY : delay * 2))
done

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  SHA256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi

if [[ ! "$SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: unexpected sha256 output: $SHA256" >&2
  exit 1
fi

# Only the leading `url`/`sha256` lines of the formula (two-space indent) are
# rewritten; anything inside `def`/`test` blocks is left alone.
sed \
  -e "s|^  url \".*\"$|  url \"$URL\"|" \
  -e "s|^  sha256 \".*\"$|  sha256 \"$SHA256\"|" \
  "$FORMULA" > "$TMP/formula.rb"

if ! grep -qF "  url \"$URL\"" "$TMP/formula.rb" || \
   ! grep -qF "  sha256 \"$SHA256\"" "$TMP/formula.rb"; then
  echo "error: failed to rewrite url/sha256 in $FORMULA" >&2
  exit 1
fi

mv "$TMP/formula.rb" "$FORMULA"
echo "Formula updated: $PACKAGE $VERSION"
echo "  url    $URL"
echo "  sha256 $SHA256"
