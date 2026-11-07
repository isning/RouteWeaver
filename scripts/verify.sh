#!/usr/bin/env bash
# Local and CI invoke the same named gates. Requested absent stages fail.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
MODE=${1:-quick}
case "$MODE" in quick|full|static|secrets|backend|backend_core|backend_backup|backend_httpapi|backend_store|backend_managed|web|api|browser|browser_native|native|runtime|managed|package) ;;
  *) echo 'Usage: scripts/verify.sh [quick|full|static|secrets|backend|backend_core|backend_backup|backend_httpapi|backend_store|backend_managed|web|api|browser|browser_native|native|runtime|managed|package]' >&2; exit 2 ;;
esac
export GOMEMLIMIT=${GOMEMLIMIT:-768MiB}
export npm_config_cache=${npm_config_cache:-"$ROOT/bin/cache/npm"}
stage() { printf '\n== %s ==\n' "$1"; shift; "$@"; }
static_gate() {
  stage 'Tracked operator-state exclusion' python3 scripts/check-private-files.py
  stage 'Ticket DAG and complete story traceability' python3 scripts/tickets.py check
  # Actual-scanner regressions run in the mandatory, independent secrets gate.
  local helpers=() file
  for file in scripts/test_*.py; do
    if [[ "$file" != scripts/test_secrets.py ]]; then helpers+=("$file"); fi
  done
  stage 'Offline ticket, distribution and CI helper regressions' env PYTHONPATH="$ROOT/scripts${PYTHONPATH:+:$PYTHONPATH}" python3 -m unittest "${helpers[@]}"
  stage 'Architecture guard negative fixtures' scripts/go.sh test ./scripts/check-architecture
  stage 'Production dependency direction' scripts/go.sh run ./scripts/check-architecture
  stage 'GitHub Actions workflow syntax and contracts (pinned actionlint)' scripts/go.sh run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
}
secrets_gate() {
  stage 'Pinned scanner prerequisite' python3 scripts/security/bootstrap.py
  stage 'Actual secret-scanner rejecting fixtures' python3 -m unittest discover -s scripts -p test_secrets.py
  stage 'Current tree, index and reachable Git history content scan' python3 scripts/check-secrets.py --scope all
}
backend_tests() {
  local inventory packages=()
  # Command substitution propagates inventory errors (process substitution would
  # hide them). Only complete package paths are selected, never individual tests.
  inventory=$(python3 scripts/backend_packages.py "$1")
  mapfile -t packages <<< "$inventory"
  stage "Go behavior and race tests ($1 packages)" scripts/go.sh test -race -p=1 -count=1 -timeout=20m "${packages[@]}"
}
backend_core_gate() {
  stage 'Go formatting' scripts/format.sh --check
  stage 'Go vet' scripts/go.sh vet ./...
  backend_tests core
  stage 'Go build' scripts/go.sh build ./...
}
backend_backup_gate() { backend_tests backup; }
backend_httpapi_gate() { backend_tests httpapi; }
backend_store_gate() { backend_tests store; }
backend_managed_gate() {
  stage 'Managed runtime vet' scripts/go.sh -C runtimes/xray vet ./...
  stage 'Managed runtime behavior and race tests' scripts/go.sh -C runtimes/xray test -race -p=1 -count=1 -timeout=10m ./...
  stage 'Managed runtime build' scripts/go.sh -C runtimes/xray build ./...
}
backend_gate() {
  backend_core_gate; backend_backup_gate; backend_httpapi_gate
  backend_store_gate; backend_managed_gate
}
web_gate() {
  stage 'Web typecheck' npm --prefix web run typecheck
  stage 'Web behavior tests' npm --prefix web run test -- --maxWorkers="${ROUTEWEAVER_WEB_TEST_WORKERS:-1}"
  stage 'Web production build' npm --prefix web run build
}
api_gate() { stage 'Real HTTP API integration (no browser/Vite)' npm --prefix web run test:api; }
browser_gate() {
  local args=() selectors=() inventory label='Browser user tasks (Chromium)'
  if [[ -n "${ROUTEWEAVER_BROWSER_SHARD:-}" ]]; then
    if [[ ! "$ROUTEWEAVER_BROWSER_SHARD" =~ ^([1-9][0-9]{0,2})/([1-9][0-9]{0,2})$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
      echo 'Browser shard must be a one-based index/total (index <= total, each <= 999).' >&2
      return 2
    fi
    # Use Playwright's complete Chromium inventory, not native count-based
    # sharding (which packs slow shared-fixture journeys into the first job).
    # Command substitution preserves discovery/metadata/selector-check failures.
    inventory=$(python3 scripts/browser_distribution.py "$ROUTEWEAVER_BROWSER_SHARD")
    mapfile -t selectors <<< "$inventory"
    args=(-- "${selectors[@]}")
    label="Browser user tasks (Chromium, shard $ROUTEWEAVER_BROWSER_SHARD only)"
  fi
  stage "$label" npm --prefix web run test:browser "${args[@]}"
}
browser_native_gate() { stage 'Same-instance browser/native acceptance' scripts/browser-native.sh; }
native_gate() { stage 'Pinned native parser integration' scripts/native-cores.sh parsers; }
runtime_gate() { stage 'Explicitly selected native process lifecycle' scripts/native-cores.sh runtime; }
managed_gate() { stage 'Managed native runtime end-to-end' scripts/managed-runtime.sh; }
package_gate() {
  # Smoke executes Linux amd64 bytes; cross-compiles belong to an explicit separate job.
  if [[ "$(scripts/go.sh env GOHOSTOS)/$(scripts/go.sh env GOHOSTARCH)" != linux/amd64 || "$(scripts/go.sh env GOOS)/$(scripts/go.sh env GOARCH)" != linux/amd64 ]]; then
    echo 'The package verification gate requires a Linux amd64 execution host; no cross-compiled smoke pass is claimed.' >&2
    return 2
  fi
  stage 'Exact-source application package (first build)' scripts/package.sh
  local archive=bin/packages/routeweaver-linux-amd64.tar.gz first
  first=$(python3 -c 'import hashlib,sys; print(hashlib.file_digest(open(sys.argv[1],"rb"),"sha256").hexdigest())' "$archive")
  stage 'Independent rebuild for reproducibility' scripts/package.sh
  python3 - "$archive" "$first" <<'PY'
import hashlib,sys
with open(sys.argv[1], 'rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != sys.argv[2]:
        raise SystemExit('Package rebuild differs; deterministic package gate failed')
print('PASS: two consecutive builds from unchanged source produced identical archive bytes.')
PY
  stage 'Extracted package durable-state smoke' python3 scripts/smoke-package.py "$archive"
}
case "$MODE" in
  quick) static_gate; backend_gate; web_gate ;;
  full)
    if [[ -n "${ROUTEWEAVER_BROWSER_SHARD:-}" ]]; then
      echo 'Full verification cannot select a partial browser shard. Unset ROUTEWEAVER_BROWSER_SHARD.' >&2
      exit 2
    fi
    if [[ "${ROUTEWEAVER_CLIENT_PROCESS_TESTS:-}" != mihomo,sing-box ]]; then
      echo 'Full verification requires ROUTEWEAVER_CLIENT_PROCESS_TESTS=mihomo,sing-box on an authorized compatible host.' >&2
      exit 2
    fi
    if [[ "${ROUTEWEAVER_NATIVE_PROCESS_TESTS:-}" != xray,sing-box ]]; then
      echo 'Full verification requires ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray,sing-box on an authorized compatible host. Missing or denied targets are not passes.' >&2
      exit 2
    fi
    static_gate; secrets_gate; backend_gate; web_gate; api_gate; browser_gate; browser_native_gate
    native_gate; runtime_gate; managed_gate; package_gate ;;
  *) "${MODE}_gate" ;;
esac
if [[ "$MODE" == browser && -n "${ROUTEWEAVER_BROWSER_SHARD:-}" ]]; then
  printf '\nPASS: browser shard %s only. All shards must pass before the browser gate is complete.\n' "$ROUTEWEAVER_BROWSER_SHARD"
else
  printf '\nPASS: %s verification. This is the named gate only, not deployed acceptance or completion of all 35 stories.\n' "$MODE"
fi
