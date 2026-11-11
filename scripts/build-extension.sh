#!/usr/bin/env bash
# Build a loadable extension package: dist/fab-free-claimer-extension.zip
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/extension"
out="$root/dist"
staging="$out/fab-free-claimer-extension"

rm -rf "$staging"
mkdir -p "$staging"

# Ship only what the browser needs: no tests, no docs.
rsync -a \
  --exclude 'tests/' \
  --exclude '*.md' \
  "$src"/ "$staging"/

cd "$out"
rm -f fab-free-claimer-extension.zip
zip -qr fab-free-claimer-extension.zip fab-free-claimer-extension

echo "built: $out/fab-free-claimer-extension.zip"
unzip -l fab-free-claimer-extension.zip | tail -n +2
