#!/usr/bin/env bash
# Builds the installable plugin zip with the given version stamped in.
# app/dist must be built first (cd app && npm run build).
#
#   bash bin/build-zip.sh 0.1.5 [out-dir]   →  out-dir/gridrankers-portal.zip (default: build/)
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: $0 <x.y.z> [out-dir]" >&2
	exit 1
fi
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${2:-$PLUGIN/build}" && cd "${2:-$PLUGIN/build}" && pwd)"
test -f "$PLUGIN/app/dist/.vite/manifest.json" || { echo "app/dist is missing: run npm run build in app/" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/gridrankers-portal"
mkdir -p "$DEST/app"
cp -r "$PLUGIN/gridrankers-portal.php" "$PLUGIN/README.md" "$PLUGIN/includes" "$PLUGIN/admin" "$PLUGIN/templates" "$DEST/"
cp -r "$PLUGIN/app/dist" "$DEST/app/"

MAIN="$DEST/gridrankers-portal.php"
sed -i -E "s/^( \* Version: +).*/\1$VERSION/; s/define\( 'GRP_VERSION', '[^']*' \);/define( 'GRP_VERSION', '$VERSION' );/" "$MAIN"
grep -qE "^ \* Version: +$VERSION\$" "$MAIN" && grep -q "define( 'GRP_VERSION', '$VERSION' );" "$MAIN" \
	|| { echo "could not stamp version $VERSION" >&2; exit 1; }

rm -f "$OUT/gridrankers-portal.zip"
(cd "$STAGE" && zip -qr "$OUT/gridrankers-portal.zip" gridrankers-portal)
echo "$OUT/gridrankers-portal.zip ($VERSION)"
