#!/usr/bin/env bash
# macOS control-plane + browser UI only; Linux node/runtime packaging is unchanged.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ARCH=${GOARCH:-arm64}
case "$ARCH" in arm64|amd64) ;; *) echo 'Expected GOARCH=arm64 or amd64' >&2; exit 2 ;; esac
export GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=0
mkdir -p bin
scripts/go.sh build -trimpath -ldflags='-s -w' -o bin/routeweaver-control-plane ./cmd/control-plane
npm --prefix web run build
NAME="routeweaver-darwin-$ARCH"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/web" "$STAGE/$NAME/source-manifests"
cp bin/routeweaver-control-plane "$STAGE/$NAME/"
cp -R web/dist "$STAGE/$NAME/web/"
cp docs/MACOS-QUICKSTART.md "$STAGE/$NAME/README.md"
cp -R internal/render/schemas "$STAGE/$NAME/client-schemas"
python3 scripts/collect-notices.py "$STAGE/$NAME/licenses" --binary bin/routeweaver-control-plane
cp go.mod "$STAGE/$NAME/source-manifests/root.go.mod"
cp go.sum "$STAGE/$NAME/source-manifests/root.go.sum"
cp web/package-lock.json "$STAGE/$NAME/source-manifests/web.package-lock.json"
{
  scripts/go.sh version
  printf 'Source commit: %s\n' "$(git rev-parse HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then printf 'Source worktree: contains local changes.\n'; fi
  printf 'Package scope: macOS control-plane and browser UI only; no node agent or managed runtime.\n'
  printf 'Verification: cross-compiled; not executed on macOS. No Developer ID signing or notarization.\n'
  scripts/go.sh version -m bin/routeweaver-control-plane
} > "$STAGE/$NAME/BUILD-INFO.txt"
mkdir -p bin/packages
tar -C "$STAGE" -czf "bin/packages/$NAME.tar.gz" "$NAME"
(cd bin/packages && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
printf 'Packaged %s (not runtime-tested on macOS).\n' "bin/packages/$NAME.tar.gz"
