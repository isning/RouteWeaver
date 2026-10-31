# Continuous service: control-plane acceptance

Scope: local synthetic tests, not a deployment or soak certification.

## Authority and compatibility

The reviewed Fleet input `continuousService: true` is accepted only for
start/configure. False/omitted retains bounded/manual behavior. Agent
`--service` alone grants nothing. A compatible, continuously running agent
must report actual observations; older/poll-only agents remain
`awaiting_observation` and expire under their original lease.

Each successful reviewed opt-in execution creates a stable, persistent intent
bound to its batch, target identity and originating administrator. New
non-opt-in desired state (including install/stop), or direct manual publication,
atomically disables the old intent. Stopping only the agent is not revocation:
a subsequent explicitly continuous agent can report proved absence. Use a CP
stop or non-opt-in replacement to cancel standing authorization.

Account administrator disable, retirement, required password change, or removal
of administrator role blocks continuation. Operator-token intents bind its
digest; token replacement blocks continuation. Full raw account/input CAS is
retained. Login counters, passwords/MFA bookkeeping and display metadata are
not stable authorization fingerprints; real roles/flags/grants/credentials,
effective policies, reviewed input and rendered artifacts remain significant.

## Refresh and recovery invariants

POST `/api/agent/instances/{instanceId}/service-heartbeat` uses the existing
enrollment bearer/scope boundary and strict decoding. Unknown, non-quiescent,
stale, mismatched and inactive observations cannot renew or recover. Client
policy timestamps identify a receipt only; issuance/expiry/sequence derive
from the CP clock and durable state. A clock behind prior authority fails closed.

Compilation is durably throttled to at most once per intent per five seconds.
Refresh leaves the original Desired and its request digest unchanged. The
pending grant and monotonically increasing sequence are committed before the
response. Retries return that exact grant only while old authority is valid.
Published manifest expiry advances only after a matching actual-live heartbeat
acknowledges the durably applied grant. A pending grant is never activation proof.

Every grant, retry, acknowledgement and automatic/new opt-in generation uses
the same SQLite writer reservation for raw record/set CAS, current effective
policy, route permission, usage/quota and accounting-hold checks, generation
allocation and intent writes. The canonical admission policy/hold evaluator is
shared rather than copied. Deadlines fence receipt freshness, enrollment and
applicable lease at commit. Per-flow admission/budget leases remain independent:
an instance refresh does not extend them or allocate additional flow budget.

Only explicit known absence can queue a newly compiled, currently authorized
generation. A pending refresh is discarded only atomically with that new
generation. Three automatic attempts total use 5/10/20-second backoff; renewal
and successful running do not reset the budget. Thereafter
`crash_loop_blocked` requires a new reviewed administrator execution.
`review_required` similarly requires review, not unknown-operation replay.

Admin instance inspection exposes `serviceIntent` with `id`, `running`,
`status`, `automaticAttempts`, `nextAttemptAt`, `leaseExpiresAt`.
Running describes desired intent, not observed process health. Blocked intents
retain running=true; disabled/superseded intents are false. The displayed expiry
is acknowledged, never merely issued.

## Verification

HTTP tests cover manual default, opt-in review, server-time/identity fencing,
unknown/stale facts, expiry, current authority and quota/hold rejection,
pending-versus-acknowledged manifests, immutable Desired, concurrent handlers,
actual DB reopen, pending-response-loss followed by death, stop cancellation,
durable retry budget and ordinary MFA/usage bookkeeping.

A benign owned-child CP/driver test proves stable PID across original expiry
and new generation after real known process death. It is not native traffic
evidence. A separate required managed-native test opens a real synthetic VLESS
payload flow *before* refresh, waits past original instance/manifest expiry,
then revokes its principal and verifies new-flow denial and old-flow closure
while the refreshed core remains alive. The script
`scripts/managed-runtime.sh` requires this test to pass; a skip is failure
for that gate. Exact integrated-source CI must rerun it.

All processes and credentials are test-owned and loopback-only. Stock sing-box
host permission restrictions, production enrollment, real host networking,
long-duration load/soak, deployment supervision and operations acceptance are
not established by these tests. No host guard was relaxed.

Recorded local commands (official Go 1.27.3):

- `go test -race ./internal/httpapi ./internal/fleet ./internal/controlprotocol -run 'TestContinuous|TestFleet' -count=1`: passed, HTTP 35.803s.
- `ROUTEWEAVER_MANAGED_XRAY_BIN=/tmp/routeweaver-service-managed go test -race -p=1 ./internal/httpapi -run '^TestNativeContinuousManagedServicePreservesPayloadAndRevocation$' -count=1 -v -timeout=90s`: passed 23.849s, including aligned original instance/manifest expiry.
- `go vet ./internal/httpapi ./internal/fleet ./internal/controlprotocol` and `git diff --check`: passed.
- Native binary built from this worktree's unchanged managed runtime with `go -C runtimes/xray build -p=1 -trimpath`; SHA-256 `ba98f5a52ec724075782b24fca4472162739ed00f1cba1954ab56c7eda62a479`.

Red/green evidence: the initial opt-in test rejected the unknown JSON field;
the native test initially attempted admission before the CP had received the
actual applied observation and correctly got EOF. Waiting for that real receipt
made admission succeed. A race run exposed a benign helper's delayed PID-file
write; bounded polling now waits for the replacement child's actual PID rather
than interpreting a stale fixture file as runtime ownership.

## Recovery failure idempotency follow-up

Independent review reproduced a liveness defect: a transient prior-stage gate
appended a failed `service-<intent>-1` attempt without allocating a generation;
later healthy heartbeats then treated that failed request ID as already queued.
The recovery-only path now returns a retryable conflict for stage-gate failures
without creating such rows or consuming budget. Only a request with an actual
queued identity is deduplicated as successful; historical identity-less failed
rows are revalidated rather than treated as activation. Terminal recovery
compile/configuration/enrollment/target gates atomically mark the exact current
intent `review_required`. Manual Fleet execution semantics are unchanged.

The original public-HTTP counterexample fails before the fix. Extended tests
reopen the actual database, exercise historical failed rows, issue six concurrent
healthy retries, and assert one new generation/one automatic attempt plus stale
observation rejection. This regression passed under `-race -count=3` (5.566s).
A terminal changed-input test additionally verifies visible review and no budget
or generation consumption. Policy/generation writer fences remain unchanged.
Adjacent `go test -race ./internal/httpapi ./internal/fleet -run
'TestReviewService|TestContinuous|TestFleet' -count=1` passed (HTTP 38.197s);
vet and diff checks passed.
