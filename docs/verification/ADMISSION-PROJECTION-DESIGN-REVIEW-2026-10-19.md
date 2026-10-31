# Admission projection design review, 2026-10-19

## Decision

**Conditionally endorse the narrowed ledger-only first slice.** For a small fleet,
one lazily rebuilt encrypted usage window per account, exact transactional ledger
deltas, and a durable dirty backstop are justified by the measured warm-history
cost. Do not implement an account membership index, lease/reservation compaction,
or a broader cache framework in this slice. This is design review, not permission
to implement, a production security finding, or evidence that the optimization
has passed tests.

Reviewed the design against `billing.go`, `admission.go`, `admission_budget.go`,
`admission_recovery.go`, `counter_ingestion.go`, `counter_resolution.go`, generic
record/token/CAS writers, and both logical backup/restore paths. No production
files were changed and no new runtime experiment was run for this design review.
The earlier measured scaling results belong to their separate characterization.
[Reviewed design/source snapshot, 20:17 UTC](admission-projection-review-2026-10-19/reviewed.sha256).
The designer may subsequently incorporate the implementation prerequisites below;
this snapshot is not a claim to have reviewed future implementation bytes.

## Corrections identified during review

1. **A presence ceiling does not bound live reservations.**
   `admission.go:409-440` releases only the lease. Repeated admission → release →
   new presence can leave many unclosed, unexpired budgets while the active lease
   count stays small. Unlimited and zero-rate cases are especially clear.
   The designer corrected the proposed 4,096-bound claim. Later compaction must
   retain every obligation and describe work as proportional to relevant budgets,
   or separately specify a semantic cap/expiry aggregation. It cannot silently
   discard reservations to meet a memory target.
2. **A clean marker is not proof of membership-index completeness.**
   Canonical-write triggers cannot detect an omitted derived membership row.
   A cold rebuild through that incomplete index could undercount authentic usage.
   Omitting this index from the first slice removes this failure mode. If added
   later, require authenticated expected counts, unique membership, exact canonical
   identity/owner verification and count agreement, or another demonstrated
   completeness mechanism. Missing metadata never means zero history.
3. **Crypto initialization is a real constructor obligation.**
   `store.go:30-34` retains only an AEAD object today. `backup_stream_restore.go`
   reconstructs a literal Store after closing the temporary database. New derived
   crypto must be initialized through a common context/constructor, including that
   reopen path. Keep canonical encryption byte-compatible; use a separately
   domain-separated, versioned state key and length-delimited authenticated
   account/schema identity. Missing crypto fails closed. Different-key restore
   must reconstruct derived state, never copy its ciphertext or key.

## Required contracts before implementation

- **Scope the trigger precisely:** first-slice tracked input is canonical `ledger`,
  not every lease/budget/policy write. UPDATE invalidation must cover either OLD
  or NEW tracked kind, including owner/key changes. Ordinary admission budget
  writes must not invalidate every warm usage row. A missed writer invalidates
  *all* cached windows transactionally before clearing the dirty generation.
  A missing account row stays missing until a full canonical reconstruction;
  never initialize it from only the next arriving delta.
- **One writer transaction owns the result:** obtain SQLite's writer reservation
  before replay/old-row/rate reads, especially `RecordMeter`. Canonical mutation,
  old/new deltas and dirty acknowledgment commit together. Central coverage must
  include `putTx`, `put`, generic CAS/batch/generated-record writes, Remove, and
  `PutWithToken`/`CompareInputsAndPutWithToken`, not only obvious meter callers.
  Counter ingestion's local SQL closure and raw deletions remain explicit audit
  points. Preserve rollback and denied-renewal semantics: `AcquireAdmission` can
  commit a valid settlement while returning a denied decision; that settlement
  must update the projection too. Baseline establishment must not invent charges.
- **Exact arithmetic includes raw/provider totals:** maintain them losslessly as
  well as the weighted numerator. Current ingestion can accept individually valid
  records whose aggregate later overflows; do not truncate, refund, or reject such
  a canonical write merely because an int64 cache cannot represent the total.
  Preserve externally visible overflow errors, and allow later deletion/replacement
  to recover an otherwise valid aggregate. Ledger rounding is once over the exact
  sum, while future reservation compaction must retain per-budget ceiling costs.
- **Time semantics stay canonical:** key the single window by exact start/end,
  recomputed live policy and latest applicable reset. Use ObservedAt, half-open
  membership and unbounded no-reset end; include committed future-relative-to-
  arrival facts within that window. Preserve expiry-minus-one-nanosecond late
  settlement. Backwards requests or changed windows rebuild rather than reusing
  a monotonic-time assumption. Quota/rate changes do not reprice old charges.
- **Backup remains canonical and read-only:** both export validators must recognize
  only the explicit derived schema without generally accepting unknown tables.
  Exclude derived rows/version metadata from logical frames and canonical digest.
  ExportBackup's dedicated read-only snapshot must not migrate, dirty-clear or
  rebuild caches. Both imports can publish a mandatory dirty state rather than
  building all windows. Preserve freshness, different-key restoration, checkpoint,
  fsync and no-replace behavior. Do not add a canonical migration row that changes
  before/after restore frame hashes.

The integrity claim should cover missed writers and missing/corrupt derived state,
not adversarial whole-database rollback/truncation, which canonical AEAD itself
also does not prevent. Any later compact budget structure must not become the sole
source for every policy guard: `SetRate` rejects an overlapping unclosed budget even
when finite outstanding bytes are zero, unlike the reservation relevance filter.

## Maintenance and release judgment

The ledger-only change is a reasonable trade. An account-only index leaves
same-account no-reset growth; process-local caches lose cross-Store correctness;
plaintext SQL aggregates change the stated privacy model; deleting history loses
accounting evidence. None is a safer equivalent tiny fix.

Keep the new scalar usage state separate from any later large lease/budget blob,
so each settlement does not re-encrypt an entire active working set. Avoid optional
crypto fields and per-caller cache bookkeeping. Gate the plumbing/restore change
before enabling optimized reads, then use the existing full reducer as a differential
oracle across every mutation, dirty bypass, crash/reopen, concurrent Store handle,
window boundary, fractional/zero rate, overflow and old/new-key restore case.
Measure warm read cost, cold global scans, settlement/WAL amplification and writer
wait separately. Existing leases, budgets, holds, rates, policy scans and backup
still retain historical work. The design must not advertise the entire admission
path as bounded after only the ledger slice.
