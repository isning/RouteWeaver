#!/usr/bin/env bash
# Packages only built executables, static UI, operator docs and licenses.
# No databases, environment files, runtime tokens or stock core binaries.
# The locally built managed adapter ships with its source/license notices.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
TARGET_OS=${GOOS:-$(scripts/go.sh env GOOS)}
TARGET_ARCH=${GOARCH:-$(scripts/go.sh env GOARCH)}
case "$TARGET_OS/$TARGET_ARCH" in linux/amd64|linux/arm64|darwin/arm64|darwin/amd64) ;; *) echo 'Unsupported package target' >&2; exit 2 ;; esac
NAME="routeweaver-${TARGET_OS}-${TARGET_ARCH}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/web"
MANIFEST_ARGS=()
if [[ "${ROUTEWEAVER_REQUIRE_CLEAN_SOURCE:-0}" == 1 ]]; then MANIFEST_ARGS+=(--require-clean); fi
python3 scripts/package_artifacts.py manifest "$STAGE/$NAME/SOURCE-MANIFEST.json" "${MANIFEST_ARGS[@]}"
# The manifest is captured before the build, then checked again after all copies.
# VCS stamping is disabled in Go; the explicit manifest binds the whole package.
scripts/build.sh
cp bin/routeweaver-control-plane "$STAGE/$NAME/"
cp bin/routeweaver-node-agent "$STAGE/$NAME/"
cp bin/routeweaver-notification-migrate "$STAGE/$NAME/"
cp bin/routeweaver-xray "$STAGE/$NAME/"
cp runtimes/xray/README.md "$STAGE/$NAME/MANAGED-XRAY.md"
cp runtimes/xray/THIRD_PARTY_NOTICES.md "$STAGE/$NAME/THIRD_PARTY_NOTICES.md"
cp -R runtimes/xray/licenses "$STAGE/$NAME/licenses"
python3 scripts/collect-notices.py "$STAGE/$NAME/licenses/root-and-web" \
  --binary bin/routeweaver-control-plane --binary bin/routeweaver-node-agent \
  --binary bin/routeweaver-notification-migrate
cp -R internal/render/schemas "$STAGE/$NAME/client-schemas"
cp -R web/dist "$STAGE/$NAME/web/"
sed -e 's|](verification/|](docs/verification/|g' -e 's|](operations/|](docs/operations/|g' docs/PACKAGE-QUICKSTART.md > "$STAGE/$NAME/README.md"
cp docs/DELIVERY.zh-CN.md "$STAGE/$NAME/README.zh-CN.md"
cp README.md "$STAGE/$NAME/PROJECT.md"
cp AGENTS.md "$STAGE/$NAME/AGENTS.md"
cp -R docs "$STAGE/$NAME/docs"
cp internal/agent/README.md "$STAGE/$NAME/NODE-AGENT.md"
mkdir -p "$STAGE/$NAME/source-manifests"
cp go.mod "$STAGE/$NAME/source-manifests/root.go.mod"
cp go.sum "$STAGE/$NAME/source-manifests/root.go.sum"
cp runtimes/xray/go.mod "$STAGE/$NAME/source-manifests/managed-xray.go.mod"
cp runtimes/xray/go.sum "$STAGE/$NAME/source-manifests/managed-xray.go.sum"
cp web/package-lock.json "$STAGE/$NAME/source-manifests/web.package-lock.json"
scripts/go.sh version > "$STAGE/$NAME/BUILD-INFO.txt"
node --version >> "$STAGE/$NAME/BUILD-INFO.txt"
npm --version >> "$STAGE/$NAME/BUILD-INFO.txt"
printf 'Exact source content and Git status: SOURCE-MANIFEST.json\n' >> "$STAGE/$NAME/BUILD-INFO.txt"
scripts/go.sh version -m bin/routeweaver-control-plane bin/routeweaver-node-agent bin/routeweaver-xray bin/routeweaver-notification-migrate >> "$STAGE/$NAME/BUILD-INFO.txt"
mkdir -p bin/packages
python3 scripts/package_artifacts.py check-source "$STAGE/$NAME/SOURCE-MANIFEST.json"
python3 scripts/package_artifacts.py archive "$STAGE/$NAME" "bin/packages/$NAME.tar.gz" --target "$TARGET_OS/$TARGET_ARCH"
printf 'Packaged %s. Cross-compiled targets have not been runtime-tested here.\n' "bin/packages/$NAME.tar.gz"
