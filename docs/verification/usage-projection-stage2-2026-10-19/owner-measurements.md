# Encrypted current usage window: first ledger-only slice

## Scope and contracts

Implemented on the isolated `perf/encrypted-usage-window` branch from `b5fe0e3`.
This is not a claim that the whole admission path is bounded. No account membership
index, lease/budget compaction, policy cache, history deletion, plaintext activity
index, new dependency or external operation is part of this slice.

- `ledger_mutations.go` centralizes generic transactional writes/deletes. Generic
  CAS, generated records, token-record writes, `RecordMeter` and counter ingestion
  use the same path. `RecordMeter` now reserves the SQLite writer before account,
  replay and rate reads; independent handles cannot both accept conflicting replays.
- SQLite ledger-only INSERT/UPDATE/DELETE triggers track a durable generation.
  UPDATE covers OLD or NEW kind. Normal complete old/new deltas acknowledge only
  their own increment. A pre-existing dirty marker is never cleared by an ordinary
  mutation. Dirty recovery deletes **all** window rows before acknowledgment.
  Missing runtime triggers fail closed; reopen reinstalls them and rebuilds lazily.
- `usage_projection.go` stores one encrypted window per account. Raw/provider
  totals and weighted numerator are exact decimal arbitrary-precision integers.
  External rounding happens once, with existing aggregate-overflow errors. An
  overflowing canonical insert remains accepted; deletion can recover the total.
- Missing/corrupt/account-swapped window ciphertext reconstructs from the complete
  canonical ledger, never zero plus the next delta. Different or backwards windows
  also rebuild. Frozen `ObservedAt` governs half-open membership; no-reset remains
  unbounded and committed future-relative-to-arrival facts remain charged.
- Derived AES-GCM uses an HMAC-SHA256 purpose/version-derived key and authenticated
  length-delimited account identity. SQL row keys use a separately purpose-derived
  HMAC account token, not plaintext account IDs. Canonical encryption is unchanged. `newStore`
  initializes both contexts, including fresh streaming restore's reopen path.
- Derived tables are specifically allowlisted by backup validation and excluded
  from logical records, migration rows and archive digests. Export remains read-only.
  Both imports discard derived windows transactionally. Open/reopen deliberately
  discards windows and reinstalls triggers in one writer transaction after canonical
  key verification. Unknown derived version with the known physical shape is
  rebuildable, not authoritative; missing/unsupported physical schema errors closed.

Opaque account keys reveal equality and row existence, but not plaintext account
identity; totals, window timestamps, rates and quota remain encrypted.
No new IP, activity timestamp or amount is placed in SQL columns. Integrity scope
is missed writers and missing/corrupt derived state, not adversarial whole-database
rollback/truncation (which canonical AEAD also does not detect).

## Reviewable implementation checkpoints

1. `336b568`: central transactional mutation plumbing, separate crypto constructor,
   derived schema lifecycle and archive compatibility; optimized reads not enabled.
2. `42cd24f`: regression fix for SQLite outer UPSERT conflict-policy inheritance.
   Trigger marker creation now uses conditional INSERT SELECT, not INSERT OR IGNORE.
   Independent public overwrite tests caught the defect; a dedicated regression
   verifies replacing an existing ledger record.
3. The following projection commit enables exactly the two current-window ledger
   reductions in admission. Public historical `Usage` remains the independent full
   reducer and differential oracle.

## Tests observed before this report

- New schema/trigger test failed before implementation (missing derived table),
  then passed. Independent conflicting-meter race failed on baseline: two Store
  handles could both accept different payloads for one meter identity. It passes
  with transactional replay/rate reads.
- Focused stage1 `-race -p 1` mutation/schema/backup tests passed (5.687s).
- Public differential tests cover fractional/zero rates, misleading per-row rounded
  totals, 48 deterministic randomized insert/replace/delete/owner/time mutations,
  exact overflow/recovery, generic CAS/token/generated-record rollback, raw SQL
  dirty fallback, multi-account invalidation, denied-renewal settlement commits,
  finite windows, future resets/backwards arrival, and conflicting two-Store meters.
- Restore/fault tests cover snapshot/stream import and fresh restore under a different
  key, canonical snapshot equality, unknown canonical kinds, missing/corrupt derived
  rows, missing marker and unknown version. Account-ciphertext swaps rebuild.
- Internal mutation-inventory guard detects new unaudited raw record SQL. Normal
  generic mutation tests assert the dirty marker is clean **before** reading, so
  repeated full-scan fallback cannot hide missed incremental plumbing. Failed batch
  writes roll back both canonical and derived state. Both backup APIs leave corrupted
  derived ciphertext and dirty state unchanged.
- `scripts/go.sh test -race -p 1 ./internal/store -run '^Test(UsageProjection|CanonicalRecordMutationInventory)' -count=1`
  passed (6.747s). Whole-repository/backup gates are recorded separately when run;
  this focused result does not imply they ran.

## Public-seam characterization

Command: `ROUTEWEAVER_MEASURE_ADMISSION_HISTORY=1 scripts/go.sh test -p 1 ./internal/store -run '^TestAdmissionHistoryScalingCharacterization$' -count=1 -v`.
Identical expanded test ran against baseline `b5fe0e3` and this implementation on the
same shared host, without race instrumentation. Projection numbers below are the
final keyed-row/missing-trigger-check run, not the earlier pre-review run. Each dataset has one existing
presence/budget, half day-old and half year-old ledger facts under a no-reset quota.
Seven warm renewals and seven real cumulative-byte settlement renewals follow one
cold request. These are observations, not a millisecond SLA or a formal bound.

| History | Rows | Baseline warm median | Projection warm median | Baseline settlement median | Projection settlement median |
|---|---:|---:|---:|---:|---:|
| Unrelated | 0 | 0.594 ms | 0.771 ms | 0.541 ms | 0.951 ms |
| Unrelated | 1,000 | 9.004 ms | 0.960 ms | 9.246 ms | 0.838 ms |
| Unrelated | 10,000 | 95.780 ms | 1.207 ms | 88.298 ms | 1.328 ms |
| Same account | 0 | 0.669 ms | 0.635 ms | 0.791 ms | 1.222 ms |
| Same account | 1,000 | 9.530 ms | 0.858 ms | 8.561 ms | 1.292 ms |
| Same account | 10,000 | 98.247 ms | 0.758 ms | 90.988 ms | 0.966 ms |

At 10,000 rows, projection cold requests took 42.3 ms unrelated / 48.2 ms same-account;
reopen canonical verification took 24.9 / 23.6 ms, and subsequent cold requests 47.9 /
48.3 ms. Streaming backup took 76.5 / 70.9 ms (baseline 68.0 / 75.0 ms). Sample database
size was 3,776,512 bytes plus 4,268,352 WAL bytes, versus baseline 3,764,224 plus
4,210,672 bytes. WAL checkpoint scheduling makes these snapshots, not write-amplification
bounds. Zero-history bookkeeping overhead is visible and not hidden.

Cold reconstruction, startup canonical verification, historical Usage and backup
remain linear. Unchanged policy/hold/reset/rate collection scans and lifetime
lease/budget scans remain explicit residual costs. This measurement does not grow
those sets or establish multi-process writer-wait latency, unlimited fleet capacity,
or a fixed bound on live outstanding budgets. Those need their own workloads and
separately reviewed design, not an expanded claim from the ledger result.

## Operational compatibility

Upgrade with writers stopped and a canonical backup. Do not mix old/new binaries:
old binaries may reject the additional physical tables. Startup migration and trigger
installation are transactional; no canonical migration version or archive version
changes. Reopening is the recovery operation for accidentally missing triggers.
Same-name malicious trigger replacement and whole-database rollback are outside the
stated corruption model; no claim of tamper-proof SQLite is made.

Review-driven follow-up adds separate-purpose keyed account lookup and missing-trigger
fail-closed detection. The earlier whole store race at `1038415` passed (48.566s);
focused privacy/fault tests passed afterward. Final aggregate results follow below
when their exact revision is established.
