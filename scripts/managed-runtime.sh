#!/usr/bin/env bash
# Real loopback processes with synthetic credentials, never a live VPS rollout.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
export ROUTEWEAVER_CORE_BIN_DIR=${ROUTEWEAVER_CORE_BIN_DIR:-/workspace/shared/routeweaver-tools/cores}
export ROUTEWEAVER_XRAY_BIN=${ROUTEWEAVER_XRAY_BIN:-"$ROUTEWEAVER_CORE_BIN_DIR/xray"}
export ROUTEWEAVER_MANAGED_XRAY_BIN="$ROOT/bin/routeweaver-xray"
export ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray
mkdir -p bin/verification
scripts/go.sh -C runtimes/xray build -trimpath -o "$ROUTEWEAVER_MANAGED_XRAY_BIN" ./cmd/routeweaver-xray
scripts/go.sh test -json -race -p=1 -count=1 -timeout=240s -run '^TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries$|^TestManagedSharedVLESSIngressKeepsPrincipalPathsSeparate$|^TestNativePublishedManagedPrincipalEndToEnd$|^TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal$|^TestNativeContinuousManagedServicePreservesPayloadAndRevocation$|^TestNativeManagedProviderSuspensionAndRecovery$' ./internal/agent ./internal/integration ./internal/httpapi | tee bin/verification/managed-native.jsonl
python3 - <<'PY'
import json
items=[json.loads(line) for line in open('bin/verification/managed-native.jsonl') if line.strip()]
required={('routeweaver/internal/agent','TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries'),('routeweaver/internal/agent','TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal'),('routeweaver/internal/integration','TestManagedSharedVLESSIngressKeepsPrincipalPathsSeparate'),('routeweaver/internal/httpapi','TestNativePublishedManagedPrincipalEndToEnd'),('routeweaver/internal/httpapi','TestNativeContinuousManagedServicePreservesPayloadAndRevocation'),('routeweaver/internal/httpapi','TestNativeManagedProviderSuspensionAndRecovery')}
passed={(x.get('Package'),x.get('Test')) for x in items if x.get('Action')=='pass'}
skipped=[x.get('Test') for x in items if x.get('Action')=='skip']
if required-passed or skipped: raise SystemExit(f'Managed native gate incomplete: missing={required-passed}, skipped={skipped}')
print('PASS: required loopback managed runtime / CP integration. Not production VPS acceptance.')
PY
