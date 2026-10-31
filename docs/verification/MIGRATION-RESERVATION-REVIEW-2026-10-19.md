# Independent review: bootstrap writer reservation

**Result: no blocking correctness/security issue found in `a72bd51`.** The reported pre-claim startup failure independently reproduces on its parent; the unchanged subprocess test passes on the fix.

## Snapshot and scope

Reviewed exact archived commit `a72bd511be24f259856f33ba187fe5364915269a`, against parent `6101ede9db57fb5465619b3440eb4d2dfef18d73`. Production scope is the seven-line reservation addition in `internal/store/records.go`; also reviewed the exact mutation-inventory exception and new subprocess harness. [File hashes](migration-reservation-review-2026-10-19/reviewed.sha256). One independent reviewer considered standards and specification separately. Production files were not edited.

## Correctness and compatibility

`Open` creates `records` and sets the SQLite busy timeout before `migrate`. The new `UPDATE records SET data=data WHERE 0` immediately after `BEGIN` obtains the writer before any schema-read snapshot, preventing the observed deferred read-to-write upgrade race. It does not depend on `counters` already existing. An independent records-only bootstrap fixture installs an AFTER UPDATE trigger that aborts if any canonical row is touched: both initial and repeated migration pass, existing bytes remain identical and there are exactly the two expected canonical migration rows. The allowlist admits only this exact false-predicate statement, not arbitrary record updates.

No archive format, canonical migration version, ciphertext, schema shape or backup publication path changes. Read-only exports do not call this migration. Targeted tests rechecked unchanged derived state on export and snapshot/stream import plus both fresh-restore paths under a different destination key.

## Subprocess harness and cleanup

The two children share only synthetic temporary SQLite state, not a Go Store mutex. Both report successful Open before the parent releases claims. The same-IP cases separate connection/quota contention from the distinct-IP case; successful results require exactly one allowed child, one durable stream/IP, and exactly one reserved byte for the finite-quota case.

Startup/result failures cancel the common context. Failed-child diagnostics read stderr only after `Wait`, and registered cleanup kills/reaps other started, unjoined children. The reproduced parent failures exercised this path without the former stderr-buffer race or a hang. Malformed-result exits likewise reach cancellation and cleanup. No blocking cleanup defect was found.

The child processes are launched sequentially without a pre-Open start barrier, so startup overlap and scheduler exploration are probabilistic. Claim release is explicitly barriered. This is bounded real-process contention evidence, not exhaustive startup scheduling, concurrent first-ever empty-database initialization, native proxy payload enforcement or production multi-control-plane availability proof.

## Independent runs

- Exact unchanged harness over parent production: `test -race -p 1 ./internal/store -run '^TestAdmissionClaimsAcrossProcesses$' -count=3 -v` **failed as expected**, four startup SQLITE_BUSY failures before the claim barrier, 6.098s. [Red log](migration-reservation-review-2026-10-19/parent-race.log).
- Same command over the fix: **PASS**, three repetitions / 18 child processes, 11.315s. [Green log](migration-reservation-review-2026-10-19/fixed-race.log).
- Independent records-only bootstrap/no-row-trigger probe, mutation inventory, read-only backup and four different-key restore cases: **race PASS**, 2.087s. [Log](migration-reservation-review-2026-10-19/compatibility-race.log), [probe](migration-reservation-review-2026-10-19/independent-bootstrap-probe.go.txt).

Standards axis: no blocking violation; narrow persistence-only correction with an exact exception, no new API/dependency. Specification axis: observed race corrected without canonical mutations; focused bootstrap/archive compatibility checks pass. No complete backup/KDF suite, live-state production review, power-loss injection or full CI rerun is claimed here. Earlier aggregate gates must retain their own pre-fix revision labels.
