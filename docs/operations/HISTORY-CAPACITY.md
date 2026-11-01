# Single-instance history capacity and escalation

This is a finite operating guard, not a retention solution. All raw meter inboxes,
exact-retry receipts, ledger history, holds and unresolved reservations remain.
One private CP and Linux nodes do not imply unlimited history or a sized fleet.

## Check before capacity changes and recovery

In **Platform settings → Backup and restore**, select **检查历史容量** (Check history
capacity). Refresh before expanding users/nodes/traffic, before backup/restart/
restore planning, and often enough that expected growth cannot consume remaining
headroom between checks. This is an explicit operator check, not background
monitoring or an alert-delivery service. Record its timestamp; failed refresh
means current headroom is unknown, not that the prior result is still current.

Authenticated administrators can also GET `/api/admin/backups/capacity`. It shares
the one-operation backup gate, has a five-second context, and visits at most
configured backup rows + 1, plus 1,000,000 ledger rows + 1. Counts above those
bounds are lower bounds, labeled “at least.” No record content, owner ID, database
path or credential is returned. Unsupported schema/migrations or scan errors
return unavailable rather than silently excluding unrecognized state.

Warnings begin at 80% of each relevant unchanged configured/hard limit:

- Complete backup: at most 2,000,000 rows and 1GiB archive (operators may lower).
- Maximum backup record: configured default 32MiB, hard maximum 128MiB.
- Notification inventory pressure thresholds: 1,000,000 ledger rows and 512MiB
  ciphertext. These are not total-history refusal limits: reconstruction now
  proceeds in bounded chunks (see below). Maximum single encrypted ledger record
  remains 1MiB.

Stored plaintext record bytes are measured using ciphertext length minus the
existing authenticated-encryption overhead. They are a pressure indicator,
NOT a guaranteed lower bound or exact archive size: framing, indexes, JSON
serialization and encryption differ. Actual archive size remains unknown until
creation completes. A low row count does not establish that a byte-limited
backup will fit. Database/WAL/SHM file lengths are separately observed; they are
not logical archive size, physical allocated blocks or a transactional snapshot.
Linux filesystem available bytes apply only to the database filesystem.
Unsupported/unreadable observations are **unknown**, never zero. Check backup
staging (the process temporary directory), restore target and other relevant
filesystems independently; no universal free-space requirement is asserted.

## At a warning, failure or unknown result

1. Pause capacity expansion and new workload onboarding. Do not delete histories,
   manually edit counters, raise hard caps, purge holds, infer settlement or
   refund uncertain reservations. This software check does not stop traffic.
2. Create a complete encrypted backup while it still fits. Download and securely
   retain it and its password; perform the supported preview and isolated fresh-
   target restore verification. A created backup does NOT shrink the source DB.
   If the complete single-file backup no longer fits, use the separately
   bounded [offline lossless backup-set procedure](BACKUP-SETS.md), with a
   coordinated maintenance window and fresh-target restore verification. This
   does not raise web limits, shrink history or establish production capacity.
3. Review observed growth across timestamped checks and choose an explicit
   remaining operating window. Include expected flow churn, streams, settled
   admission deltas, active obligations, restart/cycle-change cold reconstruction
   and temporary-storage requirements. Do not extrapolate SQLite WAL allocation
   or a 50ms synthetic poll cadence into production record rates.
4. Escalate to the operator responsible for storage and accounting before the
   remaining window is consumed. Decide a reviewed lossless history partition/
   archive-and-query/restore design, or a controlled traffic pause with sufficient
   capacity left to drain durable meter evidence and settle known obligations.
   There is currently no supported automatic historical partitioning/removal.
5. If complete backup fails, the API reports the failure before publishing a
   successful download. Preserve the source and keys; inspect row/record/archive
   limits, integrity, deadlines and each filesystem. Do not treat a truncated or
   failed archive as recovery evidence. No source mutation is needed to inspect.
6. A controlled pause is a separately authorized operational action: coordinate
   admission and traffic shutdown through supported policy/runtime paths, monitor
   acknowledged meter drain and accounting settlement, and preserve all
   unresolved obligations. Never stop/delete the CP first as a “disk fix.” Do not
   erase uncertain state merely to get below a threshold.

A hard reject-all-writes cutoff would strand final meter evidence and settlements.
Automatic admission cutoff needs a proved reserve for live obligations, pending
outboxes and maintenance; it is intentionally NOT implemented. Consequently the
long-run retained-history capacity and measured cold-recovery timeliness remain
production sizing gates.
Streaming historical Usage removes history-sized plaintext allocations but does
not turn historical scans into constant-time queries or prevent WAL retention.

## Synthetic verification scope

Tests cover warning below the cap, capped metadata count/lower-bound reporting,
byte pressure with few rows, no raw-history mutation, cancellation, rejected
raised limits, unknown filesystem information, administrator-only access without
owner/path leakage, shared backup operation exclusion, and UI warning/unknown/
failed-refresh/retry states. All data is synthetic/private. This is not a live
host disk-exhaustion, full-archive-at-1GiB, million-row or target-service soak test.

Final focused verification: `go test -race ./internal/store ./internal/httpapi
-run 'TestHistoryCapacity' -count=1 -timeout=60s` passed (store 2.314s, HTTP 4.412s).
The composed targeted streaming/recovery/backup-concurrency race selection also
passed (store 2.116s, HTTP 3.774s). Web typecheck and the capacity plus existing
backup-outcome DOM files passed, 21/21, one active worker. Architecture import
check and diff whitespace check passed. No browser/pixel or deployment validation
was run. An earlier broader race selection timed out at the unchanged 10-minute
Go deadline in existing `TestAcceptedNotificationsRemainBackupRecoverable`
(notification validation/import); it is not counted as a pass. The full non-race
store package on the preceding streaming composition passed in 48.869s; this is
not a full-suite claim for the capacity addition.

## Resumable notification reconstruction

Notification reconstruction now commits encrypted, derived-only canonical prefixes
of at most 1,024 rows and 1MiB ciphertext per input transaction, further restricted
by the caller's row/byte/time budgets. The former 1,000,000-row / 512MiB budget is
not a total retained-history ceiling: larger histories require multiple steps.
The single encrypted-record 1MiB bound remains. Partial totals are never quota
inputs; usage remains unknown until the entire current window is reconstructed.
Normal ledger mutations adjust already-scanned prefixes in the same transaction;
policy/window changes, untrusted writes and reopen discard uncertain progress.
Logical backups contain canonical evidence, never these derived checkpoints.
Old physical readers refuse the new derived table; use logical backup/restore
with a compatible release, not an in-place binary downgrade.

This removes a permanent row-count refusal, not a latency or disk guarantee.
Successful incomplete batches now schedule another visit one second after the
previous batch finishes, rather than waiting the normal minute. Real evaluation/
delivery errors, oversized records and deadlines retain normal-interval backoff.
Each visit still rotates the account cursor and performs ordinary evaluation and
durable dispatch with unchanged deadlines; there is no tight reconstruction loop.
Account-page rotation, byte limits, write rates and normal-backoff visits add time.
Arrival rates must remain below effective rebuild throughput. Restart intentionally discards partial progress. Measure cold recovery
on the chosen host before admitting its workload; no large-history service SLO
has been certified here. Tenant overview still streams all ledger rows because
its exact `now` cutoff differs from current-cycle projection semantics.
