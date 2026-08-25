#!/usr/bin/env bash
# Snapshot the current working tree's build into bench/.builds/<label>/
# so A/B comparisons run against frozen bundles (build once per side).
#   usage: bench/snapshot-build.sh <label>
set -euo pipefail
label="${1:?usage: snapshot-build.sh <label>}"
cd "$(dirname "$0")/.."

npm run build
dest="bench/.builds/$label"
mkdir -p "$dest"
cp build/index.mjs "$dest/"
cp build/index.mjs.map "$dest/" 2>/dev/null || true
echo "$(git rev-parse --short HEAD 2>/dev/null || echo unknown) $(date -u +%FT%TZ)" > "$dest/BUILD_INFO"
echo "snapshot -> $dest ($(cat "$dest/BUILD_INFO"))"
