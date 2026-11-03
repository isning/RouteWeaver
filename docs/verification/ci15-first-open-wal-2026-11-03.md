# CI15 concurrent first-open WAL negotiation

## Failure and scope

CI15, remote `e68f379313fcb4b2ff2d8e9a63cff0dfaa0ddbcb`, failed
`TestConcurrentFirstOpenPreservesSchemaInitialization` with `SQLITE_BUSY`.
The test took 0.26 seconds; the 830.126-second duration belongs to the entire
store package and is not this operation's timeout.

The fix is based on canonical `bf61a6f924dcb6e25aa944f78c3cd52f26694320`.
Only the WAL-negotiation phase changes. Schema validation, migration history,
`BEGIN IMMEDIATE`, encrypted records, and process ownership policy are unchanged.

## Red evidence and mechanism

A diagnostic-only error wrapper around the existing
`PRAGMA journal_mode=WAL` localized two failures in 100 race-enabled runs of the
original first-open test to **enable SQLite WAL**, at 0.28 and 0.24 seconds.
This is before `migrate` acquires its SQLite writer reservation.

The SQLite busy handler is not guaranteed to run for a lock upgrade that could
otherwise deadlock. Multiple first-open connections can therefore receive BUSY
while negotiating the rollback-journal-to-WAL transition even though the normal
5000ms busy timeout is configured. The existing migration transaction cannot
protect an earlier operation.

References:
- https://sqlite.org/c3ref/busy_handler.html
- https://sqlite.org/wal.html#activating_and_configuring_wal_mode

## Product change

`enableWAL` owns one connection and one five-second budget. It temporarily
sets that connection's busy timeout to zero, avoiding a fresh five-second
SQLite wait on every attempt. It retries only SQLite primary error code 5,
including extended BUSY codes, and only after the previous statement is closed.
Non-BUSY errors return immediately. It checks the returned mode is `wal` rather
than treating a successful PRAGMA execution as proof that the mode changed.
The original writer busy timeout is restored on the same connection before
it returns to the pool, and restoration errors propagate.

A persistently blocked transition returns a deadline error together with its
last SQLite BUSY cause. It does not start migrations, replay all of Open, swallow
lock errors, increase the timeout, or substitute a process-local mutex for
cross-process coordination. Unknown schemas are still rejected before journal
mode negotiation, and migrations retain their own atomic writer reservation.

## Regression coverage

Public repository seams and real SQLite locks/processes cover:
- Existing four-concurrent-handle first Open.
- Four independent child processes first-opening the same fresh database,
  successfully writing distinct records, passing Ready, and preserving all
  records after all handles close and the database reopens.
- A real rollback-journal reader blocking WAL for the full bounded wait:
  failure preserves the BUSY cause, leaves the legacy schema unmigrated, and
  a later Open succeeds after release.
- Early reader release lets Open finish. A later normal write waits for an
  external writer rather than failing immediately, checking timeout restoration.
- An unknown rollback-journal schema remains in DELETE mode and unmodified.
- Existing supported/historical schema migration, unsupported-schema rejection,
  readiness, cross-process admission, related-record CAS and backup publication
  regressions.

Local evidence is synthetic temporary databases and local child processes only.
No live databases, nodes, credentials or remote deployment were changed.
This focused gate does not replace the final exact-commit CI/store suite.

## Local verification result

- Red: the unchanged concurrent-open behavior, with only WAL error-phase labeling,
  failed twice under `go test -race -count=100` (36.352s package time).
- Green: existing concurrent-handle and new independent-process tests passed
  30 repetitions each under `-race` (57.457s). The final review then preserved
  the prior BUSY cause when cancellation lands inside driver Scan.
- Final reviewed code: all 18 selected top-level concurrency/schema/boundary/CAS/
  backup/admission tests passed under `-race -count=1` (13.873s).
- `go vet ./internal/store` and `git diff --check` passed.

Go 1.27.3 was reused from the checksum-verified official toolchain. Tests used
`GOMAXPROCS=2`, read-only module resolution and one package build worker. A separate
reviewer checked the locking, restoration, cancellation/error propagation and
child-process diagnostic paths. Full exact-publication CI remains the publisher's
release gate, not a conclusion inferred from this focused local run.
