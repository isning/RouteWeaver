# Runtime lifecycle remediation — 2026-10-31

Scope: R01/R02/R03 of the production audit at remote `25ee5888`, exact
source tree `774d13f87b43ef68e9ed0fafd296bc352f11c559`. Local source recovery
commit is `0cd3e4b6ce19a73e3e869dc3eaa1e185b7e2bb9f`; this is not a remote commit.

## Changes

- R01: explicit outbound `--service` / driver `Continuous`, exclusive with a
  duration. Bounded CLI `(0,1h]` and driver `(0,24h]` remain unchanged otherwise.
  Existing signal cancellation is covered with actual SIGINT/SIGTERM subprocess
  tests. No OS service installation or host configuration change.
- R02: recovery observation shares the reconciliation lane, with a one-second
  context before outbound reports and on lease ticks. No activation replay;
  network work remains separate from the lease timer.
- R03: startup leader exit/cancellation records absence only after existing
  identity/group observation proves it. Unknown descendants retain ownership.
  Failure before durable complete identity retains the pending fence rather
  than inventing absence. No process-group signals or weaker identity checks.

## Evidence and limits

Original audit reproductions first failed for stale fixture observation, stale
real owned-process observation, and startup live-descendant false absence.
The new continuous CLI test first failed because `--service` did not exist.
These now pass, with cancellation/option-validation/actual-signal coverage.
`internal/agent` and `cmd/node-agent` adjacent suites pass with official Go 1.27.3.
Native tests that require explicit stock/managed binaries retain their existing
skip prerequisites; these package results do not claim those native gates passed.
No live VPS, production credentials, public network route, host service manager,
reboot, sustained production soak, or blocked sing-box netlink test was run.

Restart deliberately retains the generation fence: after known stop, control
plane must issue a newer generation; unknown outcomes require observation or
operator investigation. See `cmd/node-agent/README.md` for shutdown/restart steps.
R04 meter retention is tracked separately and is not claimed by this document.

RW-15 evidence: the public CLI, RunDriver/Reconciler state, and ProcessSupervisor
interfaces are covered by `cmd/node-agent/main_test.go`,
`cmd/node-agent/service_signal_test.go`, `internal/agent/driver_test.go`, and
`internal/agent/runtime_audit_test.go`. This is scoped implementation evidence,
not a request to mark the entire story or production acceptance verified.

Additional checks: `go test -race ./internal/agent ./cmd/node-agent -count=1`
passed, as did `go vet ./internal/agent ./cmd/node-agent`. The benign helper's
trusted test-only environment sets `GORACE=atexit_sleep_ms=0` to remove the race
runtime's one-second exit delay from native checker subprocesses; race checking
and failure exits remain enabled. An initial race run exposed this fixture timing
issue, not an application data race. Restart generation-fence behavior is covered
by `TestDriverRestartRetainsGenerationFenceUntilNewDesired`.

Unattended automatic restart/crash-loop recovery is **not implemented by this
batch**. A conservative follow-on must obtain a fresh control-plane generation
only after proven absence and revalidated current authorization, with durable
retry/backoff limits; it must not replay uncertain native completion.

Follow-on implementation: explicit reviewed CP standing intent, independent
identity-bound lease refresh and bounded known-absence recovery are now covered
by [paired CP acceptance](CONTINUOUS-SERVICE-CP-2026-10-31.md). The paragraph above
describes this first batch only, not the integrated follow-on. Default/manual
behavior remains unchanged; `--service` alone grants no ongoing authorization.
