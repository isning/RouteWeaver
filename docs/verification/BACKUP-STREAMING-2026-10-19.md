# Bounded streaming backup verification — 2026-10-19

## Scope and architecture

This addresses the factual 15 MiB whole-snapshot / 16 MiB archive / 100k-row
production-growth limit recorded by the secondary security review. Default HTTP
export is now a v2 framed logical stream inside standard age. Whole-state v1
imports remain compatible and bounded. No history was deleted or truncated,
crypto was not replaced, and restore is still a fresh staged database requiring
explicit offline activation. The module/format/limits/operator instructions are
in `internal/backup/README.md`.

Defaults are 1 GiB ciphertext/plaintext, 32 MiB per record (reviewed configurable
maximum 128 MiB), 2M rows, 4096 categories, 10 minutes and one HTTP operation. SQL
validation avoids history-sized maps; preview encrypts rows before SQLite storage
using an ephemeral in-memory key. Byte/counter/record/category/time/disk bounds
are distinct. The app still has other whole-state records and does not claim
unlimited storage or capacity at the configured hard ceiling.

## Executed behavior

- Public interfaces missing before implementation: [initial red](backup-streaming-2026-10-19/interface-red.log).
- A 300-record archive above 16 MiB restores through streaming preview and a
  different master key. The old snapshot interface correctly rejects that fixture.
- A realistic `store.MeterRecord` history, not a single artificial giant record,
  demonstrates complete recovery at 40,000 and 200,000 ledger rows. Login identity,
  password hash, MFA secret/step, generated-feed secret/index, active generation
  fence, removed-record counter tombstone, and first/middle/final ledger values
  are independently asserted. Canonical durable row digests cover all rows.
- Truncated/tampered/trailing ciphertext, unsupported schema, unknown/mixed or
  duplicate/unordered frame forms, missing/mismatched terminal manifest, missing
  feed index, behind generation fence, and configured byte/row/record bounds reject
  without leaked preview staging. Close removes successful preview staging.
- V1 format import passes. Review identified the initial implementation accepted
  only single-line old exports, not formatted JSON accepted by the previous parser:
  [regression red](backup-streaming-2026-10-19/legacy-format-red.log),
  [fixed green](backup-streaming-2026-10-19/legacy-format-green.log).
- Independent audit reproduced an initial concurrency defect: export held the
  Store mutex and sole connection across all emitted rows, delaying admission
  leases. A dedicated read-only WAL connection now owns the export snapshot,
  with explicit connection-local pragmas and no writer-pool changes. A blocked
  emitter allows real admission and configuration writes to complete, while
  exported record/counter values remain at the original generation:
  [red](backup-streaming-2026-10-19/concurrency-red.log),
  [race green](backup-streaming-2026-10-19/concurrency-green.log).
- A concurrent writer and streaming reader preserve record/counter generation
  consistency. Cancellation after the first import row rolls back to the pristine
  metadata-only store. Existing legacy occupied-target, symlink, schema/columns,
  import abort-trigger and fresh-target tests remain part of the scoped suite.
- Real HTTP multipart transfer exceeds 16 MiB, preserves the complete last record,
  rejects extra parts/replay, and does not activate the target. A server configured
  with 50 ms ordinary read/write timeouts accepts an authenticated backup request
  with a 150 ms delayed body and a later 100 ms multipart delay because the handler
  applies a bounded 30 s backup deadline. This is a real `httptest` socket test,
  not mocked deadline calls: [HTTP green](backup-streaming-2026-10-19/http-green.log).
- Existing HTTP authentication/tenant denial/session-CSRF, explicit confirmation,
  changed digest, secret-free response, path rejection and unchanged live store
  regressions pass against the new default export plus legacy request adapter.

## Growth and memory evidence

Separate test-binary processes, default Go GC, synthetic local disk-backed stores:

- 40,000 ledger rows: 17,314,941 ciphertext bytes; sampled peak Go heap 525,581,776
 bytes; process maximum RSS 745,980 KiB; elapsed 6.486 s.
- 200,000 ledger rows: 86,711,873 ciphertext bytes; sampled peak Go heap 525,411,728
 bytes; process maximum RSS 562,028 KiB; elapsed 20.632 s.

Exact results: [40k](backup-streaming-2026-10-19/ledger-40000.log),
[200k](backup-streaming-2026-10-19/ledger-200000.log).

This fivefold history increase leaves sampled peak Go heap within 0.2 MB, rather
than producing a fivefold heap increase. Age scrypt's approximately 256 MiB working memory
and Go garbage collection dominate the measured peak. RSS varies and is **not**
a strict bound; it includes setup/legacy rejection/allocator and non-Go memory.
The sampler runs every 5 ms, so it is evidence, not proof of all transient peaks.
No full 1 GiB, 2M-row, 128 MiB-record or platform-independent throughput claim is made.

Reproduce with the real compiler:

```
scripts/go.sh test -c ./internal/backup -o /tmp/routeweaver-backup-stream.test
/tmp/routeweaver-backup-stream.test -test.run '^TestStreamingBackupLedgerGrowthAndCompleteRecovery$' -test.v
ROUTEWEAVER_BACKUP_BENCH_ROWS=200000 /tmp/routeweaver-backup-stream.test -test.run '^TestStreamingBackupLedgerGrowthAndCompleteRecovery$' -test.v
scripts/go.sh test ./internal/backup ./internal/store ./internal/httpapi -run 'Test(AuthenticatedBackup|Backup|StreamingBackup)' -count=1
```

For the retained RSS measurements, each invocation was wrapped in a separate
Python process using `subprocess.run`, `time.monotonic`, and
`resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss` (Linux KiB). No production
or user database was accessed.

## Review and remaining limits

Implementation self-review separated standards (module locality, bounded adapters,
shared relationship policy, no secrets on disk) from specification (whole-state
coverage, v1 compatibility, authenticated EOF, exact preview receipt, fresh durable
restore). The independent integration auditor rechecked its original blocked-
admission reproduction under `-race` after the dedicated reader fix and reported
no remaining demonstrated backup blocker. It reviewed authenticated terminal EOF,
private encrypted staging, no-replace restore, and resource/schema/index bounds.
It did not independently repeat the 200k benchmark or test the full 1 GiB ceiling;
those measurements remain implementation evidence, not independent validation.
Its final snapshot and broader integration conclusions are recorded separately.

An initial multi-package race run concurrent with the large benchmark was killed
by the environment for backup and HTTP; store passed. Retained as
[race resource failure](backup-streaming-2026-10-19/race-resource-failure.log), not
counted as green. A sequential `-p1`, `GOMEMLIMIT=384MiB` recheck passed backup 214.221 s, store 6.533 s
and HTTP 94.412 s: [race green](backup-streaming-2026-10-19/race-sequential.log).
The subsequently corrected dedicated read-only connection has its own passing
store race regression above. The final current-tree scoped non-race recheck passed
backup 21.659 s, store 0.441 s and HTTP 8.951 s:
[final scoped green](backup-streaming-2026-10-19/final-scoped-green.log).
Scoped vet, architecture-import guard, and whitespace checks passed.

Not established: crash/power-loss fault injection, ENOSPC fault injection at every
filesystem step, real production data/volume, runtime/node enforcement, end-user
browser memory at 1 GiB, or comprehensive Go secret-memory erasure. A context cannot
interrupt an arbitrary blocking custom reader; HTTP sockets have explicit bounded
deadlines. Preview scratch files after a process crash remain encrypted with a
lost ephemeral key. Operator TMPDIR/restore-directory ownership and disk headroom
remain required. Source WAL may grow under other writers during the consistent
read transaction. Whole-state notification records can eventually hit a configured
record limit and need a separately reviewed model migration.
