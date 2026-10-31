# K05 bounded diagnostics delivery evidence, 2026-10-19

Scope: RW-18 diagnostic request/result slice. Existing controlled notification
adapters remain separate; K06 server auto-failover remains excluded.

## Implemented vertical path

Administrator host task → immutable authorized target → bounded scoped durable
job → enrolled agent claim → one real local HTTP transfer → durable agent result
journal → authenticated immutable result → administrator result/cancel view.

The backend's contracts are in `internal/diagnostics/model.go`; exact semantics
and unsupported behavior are documented in `internal/diagnostics/README.md`.
The console workstream owns `web/src/Diagnostics.tsx` and its browser evidence.

## Tests executed

- Initial public-contract test failed before `NewJob` existed, then passed.
- Initial bounded GET/PUT executor test failed before executor types existed,
  then passed against real loopback targets.
- Deadline test exposed a response-header timeout racing the context timeout;
  timeout classification was corrected and the adversarial test passed.
- Result validation test first accepted a zero-byte success, then was tightened:
  successful speed requires full bounded payload and a rate computed from exact
  reported bytes/time; zero-byte/fabricated-rate cases now fail.
- Early 2xx, rejection and reset upload tests first exposed `CostKnown=true` for
  incomplete writes; WroteRequest completion, bounded source close/join and final
  counters replaced reader-only completion inference. Those tests now pass.
- Delayed-claim test first executed a stale claim; the executor now caps the
  claimed execution window and returns not_run before any target traffic.
- Late durable report test first could not refine missing-result unknown state;
  now only a matching scoped report can refine that CP-generated unknown. Already
  accepted agent reports remain immutable.

Executed package command:

`./scripts/go.sh test -race ./internal/diagnostics ./internal/agent ./internal/store ./internal/httpapi ./internal/resources ./cmd/node-agent`

Result: all six packages passed. Native/environment-gated tests that are skipped
by those packages are not claimed as new native execution evidence.

Additional focused runs exercised the final delayed-claim and upload hardening.
`./scripts/verify.sh static` passed ticket DAG/negative fixtures, tracked-state
exclusion and production import direction after using `domain.InstanceScope`.

## Positive and adversarial evidence

- Real API admin/tenant/anonymous authorization, explicit fixture registration,
  durable job submission, authenticated agent execution, direction/cost/result,
  exact retry, conflicting payload/result rejection and enrollment replacement.
- Independent RunDriver lane starts a real request; admin cancel closes the
  actual target request and reports cancelled, without a fabricated rate.
- Separate Store handles concurrently claim jobs on two Core Instances of one
  physical node; exactly one gets the lane. Queue persistence, eight-job bound,
  attempt fences, scope isolation and expiry semantics are exercised.
- A real subprocess is killed during a real synthetic transfer. Reopening the
  journal reports unknown cost and does not repeat traffic.
- A lost report receipt is retried from the durable journal after worker reopen;
  the target is called once and both result payloads are identical.
- Unsafe address/credential/query forms, exact fixture URL mismatch, redirects,
  oversized/unknown/short bodies, total deadline, cancellation and local executor
  concurrency are tested. Shared resources tests cover all-address DNS checks
  and literal-IP pinning/rebinding defense.

## Review and release status

Root review identified the upload writer/cost issue and prompted the independent
adversarial check described above; it was fixed. No separate parallel standards
and specification reviewers were available within this worker's concurrency
allocation, so this is not represented as an independent full code review.

No public target, real VPS, external download, imported subscription credential,
ICMP/root operation or deployment was used. The initial mode measures node-origin HTTP. The managed extension below measures
selected native connector forwarding, not public-entry/client admission or
provider-billed traffic. Private target
probing and credential-bearing subscription-source probes are unsupported.

RW-18 remains in_progress until its prerequisite tickets, joined UI/browser
acceptance and final project gate are verified. Passing this slice alone does not
close the overall project or claim production readiness.


## Managed-route connector extension

The selected `managed_route` mode resolves an explicit published route and entry
instance from current immutable manifests. Every hop is pinned and checked at
queue/claim/poll/result boundaries. The agent binds RPC to its exact live effective
process and staged bytes. Fixed inherited-pipe operations enter the configured
native connector using an unexported administrative context, not user-provided
routing fields. The same bounded network adapter still applies public-DNS pinning,
HTTPS, byte/time/concurrency/cancellation and no-target-retry rules.

Executed positive native proof (no skip):

`./scripts/go.sh -C runtimes/xray test -race ./... -run TestManagedDiagnostic -count=3 -timeout=90s`

- `TestManagedDiagnosticTraversesNativeTransitAndNeverFallsBack`: actual managed
  Xray entry → actual stock Xray VLESS transit → synthetic local HTTP target,
  through the real private control RPC. A 4096-byte download succeeds. Replaying
  the job returns identical evidence without another transfer. A requested native
  outbound override is denied. Stopping transit makes a new request fail even
  though native direct is the default; the HTTP target receives no second request.
- `TestManagedDiagnosticCancellationAndPrivateEOFCloseNativeTunnel`: cancellation
  and private control EOF each terminate the real native target tunnel and join.
- A later focused race run also passed native destination-policy denial and a
  network-client admission denial while administrative probing remains allowed.
  `TestDiagnosticMappingRequiresUniqueGeneratedPrincipalPrefix` rejects ambiguous,
  missing, shadowed and duplicate connector mappings.

Executed CP/agent evidence:

- `TestManagedDiagnosticPinsEveryAppliedHopAndRejectsUnknownOrAmbiguousPath`,
  `TestManagedDiagnosticChangedHopCannotReportSuccessAndExactReplayRemainsIdempotent`,
  and `TestManagedDiagnosticRequiresFreshAllHopObservationEnrollmentAndLease` pass
  under race detection. An exit-only generation change invalidates the job;
  stale observation, policy, enrollment or fingerprint cannot be selected.
- `TestManagedDiagnosticFenceRequiresExactEffectiveProcessArtifactsAndPolicy`
  passes under race detection. It checks live observation, quiescence, artifacts,
  private pipe identity, recovery, lease and LastValid identity, including the
  legitimate inactive-install candidate case. This fence test uses an adapter
  observation fixture; it is not represented as a process-launch proof.
- `TestPublishedRoutePrincipalsRequireExactAppliedManifest` now joins actual
  authoring/rendering/publication, scoped observations, the real diagnostic-path
  selector, admin job creation and scoped agent claim. The DTO contains no
  principal/transit credentials; unknown native override fields fail. An executor
  without an exact bound runtime reports `not_run`, never direct fallback.

The native forwarding and CP/agent fence tests are compositional evidence, not a
new single test spawning the full CP plus supervised CLI plus every native hop.
The existing opted-in published-native gate now includes the selector/claim
assertions, but it does not execute a local diagnostic target through that CLI:
production CLI deliberately has no loopback-target diagnostic bypass.

Precise UI path: **入口核心→已配置中转/出口→测试目标**. Public ingress TLS,
user admission and subscription are outside this mode. Operational payload is
not tenant quota; NIC/provider traffic still accumulates on every hop. Displayed
payload cost is not an aggregate wire charge. No external/public probe was run.
The managed boundary extension requires its own independent security review;
the previous direct-mode review does not cover the new administrative context.


Final extension gates executed:

- `./scripts/go.sh test -race ./internal/diagnostics ./internal/diagnosticexec ./internal/agent ./internal/store ./internal/httpapi ./internal/privateipc ./internal/resources ./cmd/node-agent` passed all eight affected packages (140.9 seconds for HTTP API).
- `./scripts/go.sh -C runtimes/xray test -race ./... -count=1 -timeout=120s` passed the entire native module (12.9 seconds).
- Static architecture/ticket guards passed after documentation and catalog render.
- Final self-review reproduced an unknown-stop concurrency bug with a red test:
  CP could release the node slot before remote cancellation was proven. The
  correction retains that lane until the hard claimed execution horizon and
  preserves `unknown`/`not_run` during path invalidation. Focused regressions cover
  another instance attempting to claim during that uncertain window.
- Native preflight refusal now emits an explicit `not_run` result; actual RPC
  transport uncertainty remains `unknown`. Upload completion means a complete
  local HTTP write (into the native stream in managed mode) and bounded 2xx, not
  proof of remote consumption or every hop's wire throughput.
