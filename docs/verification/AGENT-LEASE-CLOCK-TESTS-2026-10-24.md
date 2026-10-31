# Agent lease-clock fixtures: bounded correction and verification

24 October 2026

## Original failure and causal limit

The WIP31 six-stage current-source gate failed. Its root Go NONRACE stage reported
`TestRenewedNewGenerationCanReplaceExpiredLeaseAfterRestart` failing at the first
generation's `Submit` with `policy lease does not permit access`. The test had not
yet closed the reconciler, slept, restarted, or submitted generation 2.

That setup granted only 20 ms of real-clock lease validity while submission
performed durable journal/artifact work and repeated authorization checks. The
test-start-to-error interval was approximately 26.3 ms. This supports setup expiry
as a lead, but the assertion discarded returned state: the log establishes
neither the precise access decision/guard nor which operation consumed time.
Storage, scheduling, and load are not established causes. A later pass cannot
supply that missing evidence or retroactively turn the original gate into a pass.

Source inspection found exactly one adjacent fixture with the same 20 ms setup
lease followed by a 30 ms real sleep:
`TestExpiredFirstActivationWithLostAcknowledgementStillRestricts`. Its setup must
reach activation before it can test expiry after a lost acknowledgment. Including
it removes the same source-proven dependency; it is not a claim that this second
test failed in WIP31.

## Exact test-only changes and retained security contracts

Only the two named tests in `internal/agent/reconciler_test.go` change. They use the
existing public `Options.Now` seam and explicit policy issue/expiry times, not a
production policy change or a larger real-time timeout. Both retain 20 ms of
initial simulated validity and advance directly to the exact expiry boundary.
The unrelated 20 ms mutation-serialization wait remains unchanged.

- **Restart and renewal:** generation 1 must be nonnil, observed, allowed, and
  conformant; its reconciler is closed successfully. The shared clock advances
  to the old expiry before reopening the same durable root. Generation 2 has a
  strictly newer issue time than the persisted policy high-water mark, and its
  submission must again be observed, allowed, and conformant. Submission performs
  automatic recovery; the test does not pre-clear recovery with a separate call.
- **Lost acknowledgment:** initial submission must return `ErrUnknownRuntime`
  without last-known-valid state. Before expiry, the public adapter observation
  must independently confirm the known, quiescent first identity actually exists.
  At exact expiry, enforcement must return `ErrLeaseBlocked`, report
  `lease_expired`, and clear the reconciler observation; a separate adapter
  observation must show generation 0. Merely receiving an unknown result is not
  treated as proof that anything was activated or stopped.

Clock mutation occurs only after synchronous submission returns; no driver or
background clock reader is started. Restart cleanups capture their own local
reconcilers, and explicit close followed by cleanup uses the existing idempotent
close contract. Independent source review found no blocking findings.

Production lease windows, expiry comparisons, clock-rollback checks, generation
fences, policy issuance freshness, persistence, recovery, and restriction logic
are unchanged. These are local on-disk fixture contracts, not native-core traffic
or per-account enforcement evidence.

## Finite private validation

One serialized, hash-bound private overlay run completed on 24 October 2026,
14:27–14:33 UTC. The canonical source was not edited during validation. Each stage
ran once, with no retry or ordinary-run outer kill deadline. All four native
process exit codes were 0:

| Stage | Command/scope | Result |
|---|---|---|
| Format | Read-only `gofmt -l` over `cmd`, `internal`, `runtimes`, and `scripts/check-architecture` Go files | No files reported |
| Exact two cases | `go test -json -p=1 -count=1 -timeout=20m -run='^(TestRenewedNewGenerationCanReplaceExpiredLeaseAfterRestart\|TestExpiredFirstActivationWithLostAcknowledgementStillRestricts)$' ./internal/agent` | Exactly two native run/pass events; neither skipped |
| Vet | `go vet ./...` from root module | Passed |
| Root Go NONRACE | `go test -json -p=1 -count=1 -timeout=20m ./...` | 1,168 passed test/subtest events; 21 passed packages; zero failed tests/packages |

The root run also recorded **50 skipped tests/subtests and three packages with no
test files**. Skips include unconfigured official archives/native binaries,
explicit native process/socket/parser opt-ins, one optional real procfs read, and
unrequested workload characterizations. Skips are not passes. The complete native
skip inventory was retained with the validation result.

The run used the existing Go 1.27.2 toolchain and caches, `GOMAXPROCS=2`,
`GOMEMLIMIT=768MiB`, `GOFLAGS=-buildvcs=false -p=1`, and offline module/toolchain
settings (`GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`). Source, canonical,
staged overlay/patch, and dependency boundary invariants all remained true. The
QA lane was released at 14:33:37.306730 UTC. Dependency boundary checks are not
continuous observation between those boundaries.

## What this does not establish

- The original WIP31 Go/web aggregate remains failed, with its evidence retained.
- This was NONRACE verification. Historical full-Go race failures remain failed;
  no new race result is claimed.
- Root `./...` excludes the separate `runtimes/xray` module. Its tests, build, and
  vet were not run here. Read-only formatting included its Go source, which is not
  equivalent evidence.
- No Go build, web typecheck/tests/build, browser/E2E, native opt-in suite,
  traffic/apply/deployment, or official `quick`/`full` gate was run by this check.
- The new documentation was not part of the tested private overlay. Integrating
  these test bytes and this report does not create a new aggregate result or a
  post-integration runtime verification claim.

## Portable evidence identity

- WIP31 canonical source: `13ea11013f54c64234415ae0dbecf1d61de05db6ce5f4706094ca81fdcbea87c`.
- Validated private source (one test-file overlay, before this document): `9fe46b90847f04dff9de7f399a3c8e1886c1d902e76c45c815ac6198f412ef64`.
- Test preimage: `bbbc0f7fc1ce97d74f768980a9dbd98ee6b4516c56c2c157490fe2946d8eed05`.
- Validated test bytes: `d87527f34b607c7b8365b3c528f9d5299a84b913c88cd4dd875e6fb78e29bfe3`.
- Validation result receipt: `f89d5d299296b992c0153daada09926615484090582277540c293d64d5ff3fd1`.
- Native run receipt: `eee771fc2aa57bcec2ec53a93a48707363dba40d70abd3eb7bd3f58b8e14f18e`.
- Root Go outcome inventory: `6883f44f42d12acc436646012de5c11975671d019f5b75b03c5bffccdf4514cd`.

The separate result receipt retains full commands, native outcomes/skip reasons,
and provenance. None of the historical verification logs is replaced by this
report.
