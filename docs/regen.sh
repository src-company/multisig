#!/usr/bin/env bash
# Refresh the generated contract reference under docs/src/src/.
#
# Do NOT run `forge doc` against this directory directly. It regenerates
# book.toml, src/SUMMARY.md and src/README.md from scratch, which would delete
# the hand-written protocol and interface chapters from the table of contents and
# overwrite the book's home page with a copy of the repository README. This
# script takes only the part forge doc owns — the per-contract API pages — and
# leaves everything else alone.
#
# Usage:  docs/regen.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$repo"
forge doc --out "$tmp"

# forge doc emits an index README.md per source directory whose links are
# absolute paths that do not resolve inside the book. docs/src/reference.md is
# the hand-written index instead, so drop them.
find "$tmp/src/src" -name README.md -delete

rm -rf docs/src/src
cp -r "$tmp/src/src" docs/src/src

echo "Regenerated docs/src/src from $(git rev-parse --short HEAD)."
echo
echo "Now check that:"
echo "  * every contract page is listed in docs/src/SUMMARY.md and docs/src/reference.md"
echo "  * pages for deleted contracts are gone from both"
echo "  * docs/src/protocol/*.md still describes the code accurately"
git status --short docs
