# Backup relationship validation cost — 2026-11-01

## Failure evidence and scope

Two independent broad local race selections timed out at the unchanged ten-minute
package budget in `TestAcceptedNotificationsRemainBackupRecoverable`. The root
run was at `ce92963`; that case had run for about 9m5s when the package timed out.
The retained stack was executing SQLite SQL preparation for an indexed
`backupGet` notification-reference lookup. This is evidence of expensive work,
not proof of a deadlock or quadratic scan. The full non-race store suite had
previously passed in 48.869s. The earlier complete CI also used a different,
twenty-minute package budget and passed. These observations are not interchangeable.

The root selection additionally failed
`TestBackupMultipartLargeArchiveAndEndpointDeadlines`: a roughly 20 MiB / 300
ledger-row restore exceeded its unchanged 30-second endpoint budget under race
instrumentation and returned `restore_prepublication_cancelled`. That is a
separate crypto/serialization-heavy workload. This notification optimization
does **not** establish that the endpoint-deadline failure is fixed.

## Narrow change

Every known notification record checks the same `notification-config/settings`
record. Previously each check performed another indexed query and decryption.
Validation now retains only that one raw record for the duration of one immutable
transaction snapshot. The configured record-size precheck runs before the memo
can allocate. The memo is cleared when validation returns and is not reused
across backups, restores, users or transactions.

All canonical record, index, relationship, cryptographic and version invariants
are still checked; only repeated reads of identical configuration bytes are reused. There is no history-sized cache, skipped row, cap increase,
deadline change or changes to account balances/retained obligations. Missing,
malformed and mixed legacy/current notification configuration still rejects the
archive. No source row is removed or rewritten by validation.

A preliminary prepared-SELECT-only change was **rejected**: its small sample
improved, but its larger sample was slower and allocated more. It is absent from
the delivered production diff.

## Public-seam benchmark

`BenchmarkNotificationBackupValidation` creates one 8,000-character announcement
for 100 or 1,000 recipients, excludes fixture creation from measurement, and
calls real `ExportBackup` through its public interface. Every row is validated
and exported. This is not a wall-clock test assertion or capacity/SLO promise.

All samples: Linux amd64, official Go 1.27.3, `-race`, GOMAXPROCS=2, GOMEMLIMIT=768MiB,
one measured iteration on a shared host with other focused work. Hard CPU quota
was not established. Baseline production source was `6591a0e` with the same added
benchmark file. Logs are retained in `backup-validation-cost-20261101/`.

| Case | Baseline | Rejected prepared reads | Snapshot-local config memo |
| --- | ---: | ---: | ---: |
| 100 events, 505 rows | 1.437 s | 0.961 s | 1.243 s |
| 1,000 events, 5,005 rows | 15.388 s | 17.016 s | 10.394 s |
| 100-event allocations | 65,421 | 71,587 | 49,835 |
| 1,000-event allocations | 646,239 | 705,388 | 490,129 |

These single samples support the bounded reduction in repeated work, not a
stable percentage speedup. The original 5,000-event acceptance test is unchanged.

A separate **non-race** comparison used the same workload, five measured iterations,
and a Go overlay replacing only the production validation file with its baseline
version for the first run. Fixture construction remained outside the measurement:

| Case | Baseline | Snapshot-local config memo |
| --- | ---: | ---: |
| 100 events | 59.49 ms | 45.96 ms |
| 1,000 events | 788.40 ms | 488.27 ms |
| 1,000-event allocations | 571,683 | 421,647 |

This also supports reduced repeated work without treating race-instrumented
latency as production latency. It is still one shared-host run, not a capacity
certification or a guarantee about the separate 20 MiB HTTP restore deadline.

## Correctness evidence

- New public-seam regression changes configuration/history/pending relationships
  between exports, requires rejection before any frame is emitted, restores the
  exact row, and requires byte-identical export. It also tests cancellation,
  subsequent retry and mixed legacy/current rejection.
- Existing streamed-insert rollback/retry, missing notification indexes,
  outstanding admission obligations, live-feed indexes, generation fences and
  concurrent admission/configuration writes remain required.
- Eight focused cases passed under race instrumentation in 28.208s. The final
  expanded new regression, including missing-config streamed-restore rollback/
  retry and mixed-representation coverage, separately passed in 1.958s. Two fixture-authoring errors (using a non-admin test recipient and
  attempting generic deletion of an internal notification record) were corrected
  without changing a production guard; their failed runs are not counted as
  successes.
- The unchanged original 5,000-event case passed in **590.83s** under race
  instrumentation with the unchanged ten-minute package budget. It validated
  25,012 canonical/index records, the original 43,701,172-byte accepted state,
  legacy migration, full restore and retained deduplication. Headroom is very
  small; this does not establish a full-suite pass or a stable latency.
- The combined command containing that original case exited **1** because its
  earlier new helper still attempted unsupported generic notification deletion.
  That helper was subsequently corrected and its final expanded form independently
  passed in 1.958s.
  The original case body and production memo code were unchanged between those
  executions. The complete raw log is retained, including its failure; only the
  named original case is counted as passing from that command.
- The quieter exact HTTP race retry **failed in 85.33s overall**, again returning
  `restore_prepublication_cancelled` at the unchanged 30-second restore endpoint
  budget. The running store was not published over. The earlier 97.37s failing
  race case is retained too; a quiet retry did not erase or fix it.
- The exact same HTTP case **without race instrumentation passed in 8.30s overall**,
  retaining the same 30-second endpoint budget and all original checks: complete
  large export, authenticated preview, extra multipart-part refusal, fresh-store
  restore, exact last-record recovery, no automatic activation and replay refusal.
  This establishes normal reference usability, not a production RTO/SLA or a race
  pass. Notification memoization is not claimed to cause this difference.
- No further crypto/JSON-validation change was made to force the instrumented
  deadline case green. Exact-candidate mandatory CI and its runner performance
  remain separate required evidence.

Reproduction:

```sh
scripts/go.sh test -race ./internal/store -run '^$' \
  -bench '^BenchmarkNotificationBackupValidation$' -benchtime=1x -count=1 -timeout=3m
scripts/go.sh test -race ./internal/store \
  -run '^TestAcceptedNotificationsRemainBackupRecoverable$' -count=1 -timeout=10m -v
```
