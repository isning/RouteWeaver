#!/usr/bin/env bash
# Explicit exact-source managed/browser bridge. No stock core or remote host.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
if [[ ! -x "${ROUTEWEAVER_CHROMIUM:-}" ]]; then
  echo 'An explicitly verified sandboxed browser executable is required.' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo 'Browser/native source must be committed and clean.' >&2; exit 1
fi
SOURCE=$(git rev-parse HEAD)
mkdir -p bin/verification
export ROUTEWEAVER_MANAGED_XRAY_BIN="$ROOT/bin/browser-native-managed-xray"
export ROUTEWEAVER_BROWSER_NATIVE_HELPER="$ROOT/bin/browser-native-bridge"
scripts/go.sh -C runtimes/xray build -trimpath -o "$ROUTEWEAVER_MANAGED_XRAY_BIN" ./cmd/routeweaver-xray
scripts/go.sh test -tags=browser_native_acceptance -c -o "$ROUTEWEAVER_BROWSER_NATIVE_HELPER" ./internal/httpapi
"$ROUTEWEAVER_BROWSER_NATIVE_HELPER" -test.list '^TestBrowserNativeBridgeClassifiesOnlyExactOutcomes$' | grep -x TestBrowserNativeBridgeClassifiesOnlyExactOutcomes
"$ROUTEWEAVER_BROWSER_NATIVE_HELPER" -test.run '^TestBrowserNativeBridgeClassifiesOnlyExactOutcomes$' -test.v
export ROUTEWEAVER_MANAGED_XRAY_SHA256
ROUTEWEAVER_MANAGED_XRAY_SHA256=$(sha256sum "$ROUTEWEAVER_MANAGED_XRAY_BIN" | cut -d' ' -f1)
python3 - <<'PY'
import hashlib,json,os,subprocess
from pathlib import Path
files={key:os.environ[key] for key in ('ROUTEWEAVER_MANAGED_XRAY_BIN','ROUTEWEAVER_BROWSER_NATIVE_HELPER')}
receipt={'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'binaries':{Path(p).name:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files.values()}}
Path('bin/verification/browser-native-build.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
(cd web && npx --no-install playwright test --config=playwright.native.config.ts)
python3 scripts/check-browser-native-result.py bin/verification/browser-native-results.json

if [[ "$SOURCE" != "$(git rev-parse HEAD)" || -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo 'Source changed during browser/native verification.' >&2; exit 1
fi
