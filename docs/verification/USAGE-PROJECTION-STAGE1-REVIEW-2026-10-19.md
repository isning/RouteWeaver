# Encrypted usage projection: stage-one review

## Disposition and snapshot

**Accept the reviewed plumbing stage at `42cd24f5b63c8a7ede8eabe5e67fe6026881a99f`,
not the uncorrected `336b56875f575f91c98b038cba862701514d7d7b`.** No additional
unresolved P1/P2 was demonstrated. This does not accept stage-two optimized reads.

One independent reviewer archived exact commit 336b568 into an isolated directory,
then applied only the two committed files changed by 42cd24f. All 17 files changed
from baseline b5fe0e3 were byte-compared with 42cd24f and match.
[File hashes](usage-projection-stage1-2026-10-19/reviewed.sha256).
Active implementation worktree bytes were not substituted. Production code was
not edited; additional probes exist only in the isolated copy and evidence files.

## Specification finding: ledger replacement fails through dirty trigger (fixed)

The dedicated test worker reported this defect first. The reviewer independently
reproduced and rechecked it, without claiming independent discovery.

- Location at 336b568: `internal/store/usage_projection_schema.go:58,63,68`.
  `INSERT OR IGNORE` inside the dirty triggers inherits the enclosing canonical
  UPSERT's conflict handling.
- Reproduction: `Store.Put("ledger", "entry", first)` succeeds; a second public
  `Put` replacing the same key fails with `UNIQUE constraint failed:
  usage_projection_state.id`. This breaks the promised generic replacement
  semantics. Severity: **P2 correctness regression** in the proposed stage.
- Smallest fix: 42cd24f creates the singleton only through `INSERT ... SELECT ...
  WHERE NOT EXISTS`, avoiding a uniqueness conflict rather than trying to ignore
  one. The owner added an overwrite regression.
- The unchanged independent public replacement probe fails on 336b568 and passes
  on 42cd24f. [Probe source](usage-projection-stage1-2026-10-19/independent-probes.go.txt),
  [red output](usage-projection-stage1-2026-10-19/stage1-replacement-red.log),
  [fixed probe/counter/CAS output](usage-projection-stage1-2026-10-19/stage1-fixed-probes.log).

## Standards and coverage

No additional hard standards violation was demonstrated. Central `putTx`/`deleteTx`
cover the generic canonical mutation paths, including generated/CAS/token records;
remaining fixed-kind legacy/auth SQL cannot address the ledger. Authenticated
imports remain intentionally raw, atomic and explicitly invalidating. The AST
mutation inventory is a maintenance guard, not a proof against all dynamically
constructed SQL.

The ledger-only INSERT/DELETE triggers and OLD-or-NEW UPDATE condition cover
tracked-kind transitions. Non-ledger changes do not dirty usage. Mutation rollback
also rolls back trigger generation. Writer reservation precedes generic mutation
reads and RecordMeter replay/rate selection, so Store.mu is not the cross-handle
consistency mechanism. Existing admission settlement/denial and anomaly commit
paths remain unchanged and use the central writer.

The derived AEAD uses a separate versioned HMAC-SHA256 purpose under the master
key; canonical encryption is unchanged. Both Open and fresh-restore's literal
reopen now use the common constructor. There is no derived payload serialization
or optimized reader in this stage, so authenticated payload context, arithmetic,
window matching and warm-state correctness remain stage-two obligations.

Physical backup validation allowlists the two explicit derived table shapes
without generally accepting unknown tables. Logical records, migration frames
and digest semantics remain unchanged; imports invalidate all windows in their
transaction. An independent probe leaves nonempty derived state and a dirty
marker in place, performs both exports, and confirms neither export changes them.
The dedicated read-only streaming connection remains intact.

Unknown derived version recovery under the same usable physical shape was
clarified with the owner: Open intentionally discards *all* disposable windows
and recreates supported trigger/state semantics in one transaction. This is not
canonical-data migration or a promise of mixed-version binary support. Stage two
must never reuse an unsupported-version window or silently treat a failed rebuild
as zero usage.

## Verification and limits

- Immutable 336b568 full store race suite passed in 40.377s. It did **not** contain
  the overwrite case above, demonstrating why that green run alone was inadequate.
  [Original run](usage-projection-stage1-2026-10-19/stage1-store-race.log).
- Additional independent conflicting RecordMeter replay across two Store handles
  yields one winner and one exact retained amount. Failed generic batch and
  token-index writes roll back both canonical ledger and trigger generation.
  Both read-only backup variants preserve derived state.
  [Initial probes](usage-projection-stage1-2026-10-19/stage1-independent-probes.log).
- After 42cd24f, the independent probes plus counter/atomic-generation/CAS tests
  pass under race (2.777s). A separate accounting/backup race subset passes
  (7.890s), including weighted reservations, late settlement, final-after-disable,
  queued admission, fresh restore, import rollback, concurrent backup/writer and
  unknown schema/column rejection.
  [Fixed accounting/backup run](usage-projection-stage1-2026-10-19/stage1-fixed-accounting-backup.log).

No stage-two code, native traffic, performance improvement, crash-injection
coverage, full-project gate or cryptographic rollback resistance is asserted.
The opt-in scaling test was skipped in the full store run, not counted as a pass.
