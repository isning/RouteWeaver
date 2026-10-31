#!/usr/bin/env bash
# Use a real Go compiler, not unrelated executables also named `go`.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Generated toolchains and module caches are not application packages. Some
# upstream archives contain negative compiler fixtures or legacy modules with
# no go.mod; a boundary keeps ./... scoped to the actual repository sources.
mkdir -p "$ROOT/bin"
if [[ ! -e "$ROOT/bin/go.mod" ]]; then
  printf 'module routeweaver.local/build-artifacts\n' > "$ROOT/bin/go.mod"
fi
if [[ -n "${ROUTEWEAVER_GO:-}" ]]; then
  GO_BIN=$ROUTEWEAVER_GO
else
  GO_BIN=""
  for candidate in "$ROOT/bin/toolchain/go/bin/go" /workspace/shared/routeweaver-tools/go/bin/go "$(command -v go || true)"; do
    if [[ -x "$candidate" ]] && "$candidate" version 2>/dev/null | grep -q '^go version go'; then
      GO_BIN=$candidate
      break
    fi
  done
fi
if [[ -z "$GO_BIN" || ! -x "$GO_BIN" ]]; then
  echo 'No Go compiler found. Run scripts/bootstrap-go.sh, or set ROUTEWEAVER_GO to an official Go compiler.' >&2
  exit 2
fi
if [[ -d /workspace/shared/routeweaver-tools ]]; then
  CACHE_ROOT=/workspace/shared/routeweaver-tools
else
  CACHE_ROOT="$ROOT/bin/cache"
fi
export GOCACHE=${GOCACHE:-"$CACHE_ROOT/go-cache"}
export GOMODCACHE=${GOMODCACHE:-"$CACHE_ROOT/go-mod"}
export GOPATH=${GOPATH:-"$CACHE_ROOT/go-path"}
export GOTOOLCHAIN=${GOTOOLCHAIN:-local}
export PATH="$(dirname "$GO_BIN"):$PATH"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH"
cd "$ROOT"
exec "$GO_BIN" "$@"
