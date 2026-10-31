#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
MODE=${1:-parsers}
case "$MODE" in parsers|runtime) ;; *) echo 'Usage: scripts/native-cores.sh [parsers|runtime]' >&2; exit 2 ;; esac
export ROUTEWEAVER_NATIVE_STAGE="$MODE"
if [[ "$MODE" == runtime && -z "${ROUTEWEAVER_NATIVE_PROCESS_TESTS:-}" ]]; then
  echo 'Choose explicit local process targets using ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray or xray,sing-box. No process tests ran.' >&2
  exit 2
fi
if [[ -z "${ROUTEWEAVER_CORE_BIN_DIR:-}" ]]; then
  if [[ -d "$ROOT/bin/cores" ]]; then
    export ROUTEWEAVER_CORE_BIN_DIR="$ROOT/bin/cores"
  else
    export ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores
  fi
fi
export ROUTEWEAVER_MIHOMO_BIN=${ROUTEWEAVER_MIHOMO_BIN:-"$ROUTEWEAVER_CORE_BIN_DIR/mihomo"}
export ROUTEWEAVER_SINGBOX_BIN=${ROUTEWEAVER_SINGBOX_BIN:-"$ROUTEWEAVER_CORE_BIN_DIR/sing-box"}
export ROUTEWEAVER_XRAY_BIN=${ROUTEWEAVER_XRAY_BIN:-"$ROUTEWEAVER_CORE_BIN_DIR/xray"}
unset ROUTEWEAVER_UPDATE_FIXTURES
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
env={'mihomo':'ROUTEWEAVER_MIHOMO_BIN','sing-box':'ROUTEWEAVER_SINGBOX_BIN','xray':'ROUTEWEAVER_XRAY_BIN'}
for core in json.loads(Path('scripts/core-lock.json').read_text())['cores']:
    path=Path(os.environ[env[core['id']]])
    if not path.is_file() or not os.access(path,os.X_OK):
        raise SystemExit(f"Required native executable is missing: {path}. Run python3 scripts/bootstrap-cores.py; no native tests were passed.")
    if hashlib.sha256(path.read_bytes()).hexdigest()!=core['executableSHA256']:
        raise SystemExit(f"Native executable differs from pinned release: {path}; refusing to label it validated.")
    # The agent tests use a directory; do not silently validate a different copy.
    agent_path=Path(os.environ['ROUTEWEAVER_CORE_BIN_DIR'])/core['id']
    if not agent_path.is_file() or hashlib.sha256(agent_path.read_bytes()).hexdigest()!=core['executableSHA256']:
        raise SystemExit(f"Agent native executable missing or differs from pin: {agent_path}")
    print(f"Pinned native executable: {core['id']} {core['version']}")
PY
mkdir -p bin/verification
REPORT="bin/verification/native-$MODE.jsonl"
if [[ "$MODE" == parsers ]]; then
  scripts/go.sh test -json -p=1 -count=1 -timeout=120s -run 'TestNative(Client|Server|VLESS|Trojan|VMess|Pinned|Check|Version|Template|MultiPrincipal|Override|Owned|CoreInstaller|Install)|TestImportedProcessedVLESSPassesBothNativeClients' ./internal/render ./internal/agent ./internal/httpapi ./internal/integration | tee "$REPORT"
else
  scripts/go.sh test -json -p=1 -count=1 -timeout=120s -run '^TestNative(SupervisorLifecycleAndRestart|XrayTwoHopLoopbackRoundtrip)$|^TestRenderedTwoHopRouteHasNoDirectFallback$|^TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate$|^TestNativeFleetConfigureStopStartAndRollback$|^TestNativeEndpointProtocolsLoopback$' ./internal/agent ./internal/integration ./internal/httpapi | tee "$REPORT"
fi
python3 - "$REPORT" <<'PY'
import json,os,sys
events=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]
mode=os.environ['ROUTEWEAVER_NATIVE_STAGE']
required={('routeweaver/internal/render','TestNativeTrojanConfigurationMatrix'),('routeweaver/internal/render','TestNativeVMessConfigurationMatrix'),('routeweaver/internal/render','TestNativeClientNodesOnlyConsumption'),('routeweaver/internal/httpapi','TestNativeOwnedRuleFileBundles'),('routeweaver/internal/agent','TestNativeCoreInstallerPreparesImmutableOfficialExecutables'),('routeweaver/internal/agent','TestNativeInstallDesiredPreservesActiveRuntimeAndLease'),('routeweaver/internal/agent','TestNativeInstallDoesNotEraseAcceptedRevocation'),('routeweaver/internal/agent','TestNativeInstallDownloadCannotDelayActiveLeaseExpiry'),('routeweaver/internal/render','TestNativeClientFixtures'),('routeweaver/internal/render','TestNativeMultiPrincipalVLESSFixtures'),('routeweaver/internal/render','TestNativeVLESSClientFixtures'),('routeweaver/internal/render','TestNativeServerFixtures'),('routeweaver/internal/agent','TestNativePinnedBinariesWhenExplicitlyAvailable'),('routeweaver/internal/httpapi','TestNativeTemplateFollowedProfileUpdate'),('routeweaver/internal/httpapi','TestNativeOverridePublishedArtifactsPassPinnedNativeParsers'),('routeweaver/internal/integration','TestImportedProcessedVLESSPassesBothNativeClients')}
allowed_skips=set()
if mode=='runtime':
    selected=set(os.environ['ROUTEWEAVER_NATIVE_PROCESS_TESTS'].split(','))
    if not selected or selected-{'xray','sing-box'}:raise SystemExit('Unknown or empty native process selection')
    base='TestNativeSupervisorLifecycleAndRestart'
    required={('routeweaver/internal/agent',base+'/'+core) for core in selected}
    allowed_skips={base+'/'+core for core in {'xray','sing-box'}-selected}
    if 'xray' in selected:
        required.add(('routeweaver/internal/integration','TestNativeEndpointProtocolsLoopback'))
        required.add(('routeweaver/internal/agent','TestNativeXrayTwoHopLoopbackRoundtrip'))
        required.add(('routeweaver/internal/integration','TestRenderedTwoHopRouteHasNoDirectFallback'))
        required.add(('routeweaver/internal/integration','TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate'))
        required.add(('routeweaver/internal/httpapi','TestNativeFleetConfigureStopStartAndRollback'))
    else:
        allowed_skips.add('TestNativeEndpointProtocolsLoopback')
        allowed_skips.add('TestNativeXrayTwoHopLoopbackRoundtrip')
        allowed_skips.add('TestRenderedTwoHopRouteHasNoDirectFallback')
        allowed_skips.add('TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate')
        allowed_skips.add('TestNativeFleetConfigureStopStartAndRollback')
passed={(e.get('Package'),e.get('Test')) for e in events if e.get('Action')=='pass'}
skipped=[e.get('Package','')+':'+e.get('Test','') for e in events if e.get('Action')=='skip' and e.get('Test') not in allowed_skips]
missing=required-passed
if missing or skipped:raise SystemExit(f'Requested native gate incomplete: missing/failed={sorted(missing)}, skipped={skipped}')
if mode=='runtime':print('PASS: selected isolated process lifecycle tests: '+','.join(sorted(selected))+'. Not requested: '+','.join(sorted({'xray','sing-box'}-selected))+'.')
else:print('PASS: required pinned native parser fixtures. Process activation was not tested by this stage.')
print('This is not proof of production network reachability, traffic throughput or live quota enforcement.')
PY
