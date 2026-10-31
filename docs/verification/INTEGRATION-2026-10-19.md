# Integration evidence, 2026-10-19

This is a scoped execution record, not closure of all 35 product stories.

## Cross-layer positive evidence

- `TestImportedProcessedVLESSPassesBothNativeClients`: real VLESS URI import →
  tenant snapshot → source rename processing → full client IR → renderer →
  actual Mihomo 1.19.32 and sing-box 1.14.3 native configuration checks. The
  processed readable name survives without a forced internal-ID suffix.
- `TestRenderedTwoHopRouteHasNoDirectFallback`: ServerDeploymentIR → Xray
  server renderer → native validation → owned-process supervisor/reconciler →
  authenticated loopback A → B → TCP echo. Stopping B prevents a fresh payload
  through A, demonstrating no silent direct fallback in this fixture.
- Both tests passed with Go's race detector. Synthetic credentials and loopback
  destinations only; this does not establish real FRA/UK connectivity.

Reproduce:

    ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores \
    ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray \
    scripts/go.sh test -race -v ./internal/integration

Use `scripts/bootstrap-cores.py` and the core lock for another checkout; the path
above records this execution environment, not a required production path.

## Bounded model exploration

`TestBoundedSelectedPathModel` enumerates all 64 directed graph inventories on
three endpoints, every selected walk of zero through three edges, and every
explicit exit. All **23,040** cases satisfy the selected simple-path predicate.
The red test found an unnecessary global-inventory DAG restriction: unused
reverse links made valid direct and selected routes fail. The implementation
now checks cycles on the selected route while validating inventory references.

This is bounded exhaustive testing against a declarative predicate. It is not
an unbounded mathematical proof, verification of native routing, or a claim
about every graph size.

## Import and fetch security seams

- Untrusted fetch tests pass with the race detector: pinned public DNS dialing,
  mixed/private addresses, redirect restrictions/referrer stripping, deadlines,
  bounded bodies and secret-free diagnostics. Offline HTTP uses net.Pipe.
- Source import tests pass: URI/base64/YAML/JSON positives, VLESS preservation,
  readable name and credential-rotation identities, same-location account
  reconciliation, duplicate JSON and unsupported security rejection, no partial
  accepted snapshot after late validation failure.
- A 3-second fuzz run completed **55,022 executions** without failure before
  the subsequent identity-reconciliation extension. It is not a proof of parser
  correctness; normal regression/race tests were rerun after that extension. A second bounded
  run after identity reconciliation completed 37,794 executions without failure
  (five-second target, six seconds elapsed including shutdown).

## Gates not represented as passed

- sing-box actual process startup in this execution environment fails with
  netlink socket permission denial, including minimal no-listener configuration.
  Native parsing passed; process/traffic acceptance is still open.
- Chromium's supported sandboxed launch fails at socket creation. A separate
  supported cloud-browser attempt against the running local CP on 127.0.0.1:8080
  also failed with ERR_HTTP_RESPONSE_CODE_FAILURE; no rendered app was obtained. Browser
  pixel, keyboard, mobile and accessibility acceptance remain open. API-based
  user-task tests are separately reported by the web module.
- No private GitHub repository/Issues publication, remote CI run, real VPS
  deployment or production credential enrollment was performed by these tests.

## Managed native integration — 19:06 UTC checkpoint

After the private inherited-pipe transport and zombie-reaping cleanup fixes,
`scripts/managed-runtime.sh` passed its two required, non-skipped race-enabled
process tests:

- `TestManagedSharedVLESSIngressKeepsPrincipalPathsSeparate`: real managed VLESS
  ingress routes two authenticated principals independently; explicit revocation
  removes one account's old/new payload while the other remains usable. Transit
  removal fails its dependent route rather than falling back direct.
- `TestNativePublishedManagedPrincipalEndToEnd`: actual HTTP provisioning,
  immutable desired artifacts, agent/supervisor application and scoped
  observations precede effective credential reveal. Two real managed ingress
  instances serve eight competing flows. After 104 previously accounted bytes,
  a 4200-byte quota permits at most 4096 additional combined payload bytes and
  settles the canonical ledger exactly once. Initial finite provisioning is also
  exercised, rather than bypassing a product gate for the test.

The multi-entry test first exposed a stale request-time ledger query that could
reserve already-consumed allowance again. The CP fix counts committed facts in
its immutable cycle window after acquiring the SQLite write reservation. Its
separate cross-store regression and repeated native tests are recorded in
`CONTROL-PLANE-API-NOTES.md`. A separately discovered cleanup race confused an
unreaped zombie leader with unknown descendants; bounded observation now waits
for confirmed group absence without adding a negative-PGID kill fallback.

`verify.sh quick` also passed at this checkpoint: root and managed-module
format/vet/race/build, TypeScript, 44 DOM/model tests and production web build.
The web owner separately ran ten real-Go API workflow tests. This is a snapshot
checkpoint while further feature lanes continue, not a release acceptance claim.
The shared framework web bundle still has a size warning; browser visual/mobile
acceptance remains unrun as recorded above. TLS packaging and native TLS wire
checks have passed separately; a joined CP-published TLS fixture is in progress.

## Bounded quota lifecycle exploration

`TestBoundedAdmissionLifecycleInterleavings` passed with the race detector
(12.465 seconds). It enumerates every one of the 20 order-preserving merges of
two acquire / consume-and-report / final lifecycles, at both 1× and 2× rates,
with both monotone and stale-arrival timestamps: **80 scenarios** through two
actual SQLite store handles. At each transition it checks that committed
consumption plus outstanding raw ceilings cannot exceed the weighted account
quota, canonical raw/weighted settlement equals the reported bytes, and exact
request replay cannot charge twice. This finite enumeration covers that model,
not arbitrary crashes, clients, multipliers or all concurrent schedules.
