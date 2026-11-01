# Local review milestone: resumable exact usage

This commit is a review checkpoint, not integration approval or a full-suite pass.
Base d17c61b; canonical/raw/replay state unchanged. Independent review and expanded
fault/concurrency/restart/backup/legacy-reader tests are still being completed.

The seven-row/two-row-step reproduction failed before implementation and passes
with three unknown/pending snapshots followed by the exact round-once total.
Initial focused notification and reconstruction suites passed before the latest
review hardening. Do not attribute those earlier results to subsequent edits.

Partial state is encrypted separately in usage_rebuilds and never authorizes
usage. One frontier group consumes a global per-step row/byte budget, additionally
capped at 1024 canonical bodies to permit progress inside the existing input time
budget. Metadata uses bounded ID prefixes before bodies. Most-advanced groups
finish first so a resetting/new cold peer cannot repeatedly rewind stable peers.
Ledger insert/update/delete hooks account for already-scanned IDs atomically.
Dirty generation/reopen discards all derived partial and complete state; no old
summary trust was introduced. Normal user deletion cleans its derived partial.

Actual delivery errors dominate normal rebuild-pending status. Expiry,
announcements, warm peers and durable outbox processing remain independent.
Canonical ordering requires generated-schema BINARY keys; custom explicit
COLLATE declarations are conservatively refused, including column/PK overrides.

Remaining verification work is explicit: actual old physical reader refusal,
restart false-clean, backup equality, concurrent writer/rollback boundaries,
nonusage worker progress through completion, default chunk resource observation,
and final independent review. Overview remains a full streaming canonical scan:
its end=now cutoff differs from the completed cycle-window projection's semantics.

## Follow-on hardening and bounded measurement

The follow-on batch adds 1MiB ciphertext chunks, soft deadline yield before
checkpoint/commit, and pending-only one-second-after-completion continuation.
Actual errors use normal backoff. All visits retain the ordinary cursor,
evaluation and dispatch paths and their unchanged 2s input / 5s evaluation
budgets. Delivery errors are not hidden behind pending. The 101-account worker
composition race test originally failed because it incorrectly required pending
on every tick even when ordinary evaluation legitimately exhausted its deadline.
It now accepts explicit deadlines but still requires eventual cursor wrap and
both endpoint accounts' expiry/announcement delivery; it passed in 42.357s.
The separate small-fixture test checks quota remains absent until completion.

Opt-in `ROUTEWEAVER_HISTORY_MEASUREMENT=1 go test ./internal/store -run
'^TestUsageRebuildHundredThousandMeasurement$' -v -count=1 -timeout=120s`:
100,000 synthetic records, 98 committed steps, exact round-once weighted total
50,000; active reconstruction 861.365154ms, slowest input 30.135736ms. Whole test
including insertion took 32.98s. Scheduler delays excluded. This is not a target
hardware capacity, million-row soak, or notification recovery SLO claim.

Actual legacy reader: a tiny read-only Open probe built against d17c61b, SHA256
8208b37e2a2120f24fa05095ef8e931c5b4725f2d2584beb2db97c40de4907a4,
returns `LEGACY_UNSUPPORTED_SCHEMA` for the new physical derived table. Test uses
`ROUTEWEAVER_LEGACY_STORE_PROBE=/tmp/history-legacy-reader-d17c61b`; without that
explicit probe it skips, so default execution alone does not prove old-reader
behavior. No physical downgrade is supported. Canonical logical backup equality
and restore under a different key are tested separately.

Reopen false-clean writes, corrupt/unknown partials, rollback, cancellation,
frontier insert/update/delete/account/time corrections, reset/cycle changes,
writer concurrency, exact provider/weighted totals and no-read warm reuse are
covered by synthetic tests. The old overview/current-cycle cutoff mismatch
remains: overview is streaming O(all canonical ledger), not constant-time.
Full-store, latest focused race and final independent review results will be
recorded after completion; this paragraph is not a claim that pending runs passed.

## Final scoped results for the reviewed composition

- Full `internal/store` package, with actual legacy-reader probe enabled:
  **PASS, 46.377s** (`-count=1 -timeout=180s`). The opt-in 100k measurement remains
  separate; it skips in this ordinary package run.
- Latest store race selection `Test(UsageRebuild|NotificationColdChunks|
  WarmNotificationInputs)`: **PASS, 29.955s**, including corrected soft yield.
- Independent read-only reviewer found no blocking correctness issue and ran
  focused worker race **PASS, 31.571s**, plus real-deadline soft-yield race
  **PASS, 2.310s**. Earlier worker/fake-context failures are superseded, not hidden.
- Web typecheck passed; capacity, backup export outcome and restore outcome DOM
  files passed **22/22** with one active worker. Architecture import and diff
  whitespace checks passed. No browser/pixel, CI or deployment run was performed.

The soft-yield regression uses a real two-second deadline and driver-observed
1.1s metadata delay, verifies only the consumed first-row frontier is committed,
then changes scanned and unread rows and verifies exact eventual rounded usage.
A synthetic Context claiming an already-expired deadline with Err=nil was
rejected by the public seam and replaced; it was not evidence of a code defect.

To reproduce the legacy probe, in a detached d17c61b checkout add a temporary
`cmd/history-legacy-probe/main.go` importing the existing internal store:

```go
package main
import ("bytes"; "errors"; "fmt"; "os"; "routeweaver/internal/store")
func main() {
 s, err := store.Open(os.Args[1], bytes.Repeat([]byte{17}, 32))
 if err == nil { s.Close(); os.Exit(1) }
 if !errors.Is(err, store.ErrUnsupportedSchema) { os.Exit(2) }
 fmt.Println("LEGACY_UNSUPPORTED_SCHEMA")
}
```

Build that helper locally and pass its path through
`ROUTEWEAVER_LEGACY_STORE_PROBE` to `TestUsageRebuildOldPhysicalReaderRefusesDerivedTable`.
It uses only a synthetic private fixture and key. This documents the same probe
behavior; binary hashes depend on source formatting/build location/toolchain.
No old production code is patched to make it refuse.

This closes the fixed total-row notification reconstruction cliff without raw
retention changes. It does not close finite disk sizing, large-history overview
cost, or the separately tracked logical-backup format capacity work. Admission's
independent exact canonical fallback can still scan history when no completed
window is available. No enterprise HA or infinite-storage claim is made.
