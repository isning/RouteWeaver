# Exact owner-history lookup — implementation and bounded evidence

Source base: `9e5dee0` (resumable notification usage reconstruction). This change
addresses `UsageContext` decrypting every tenant's canonical ledger on every
historical/overview read. It does not substitute cycle totals for the overview's
`now + 1ns` upper bound, alter quota policy, or claim a production capacity/SLA.

## Trust and memory boundary

- `usage_history` contains HMAC owner lookup tokens and canonical record IDs.
  Canonical encrypted ledger payloads remain the only accounting authority.
- `usage_history_owners` contains AEAD-authenticated counts, bound to each token.
  `usage_history_state` authenticates canonical and derived generations. Six
  derived-table mutation triggers invalidate the fence on unaccounted mutations,
  including deletion or replay of formerly valid owner proofs. Trust also requires
  exact installed SQL definitions for all six derived and three canonical ledger
  triggers, shared with their installers (not merely matching names).
- A valid complete-global fence plus absent owner proof means expected zero;
  actual membership must still be empty. Missing proof from a raw deletion changes
  the derived generation and cannot authorize zero. No dirty/missing/corrupt fence
  can authorize a derived result.
- Indexed reads fetch every selected owner's canonical record in the same read
  snapshot, validate AEAD and actual ownership, verify cardinality, then use the
  unchanged arbitrary-window/exact-weighted reducer. Errors or mismatch discard
  partial work and use the original full canonical scan in that same snapshot.
- Every ordinary canonical ledger mutation uses `putTx` / `deleteTx`, and advances
  derived membership/counts/fence transactionally only from a previously valid
  state. Unknown raw SQL never becomes valid merely because cycle usage recovers;
  `invalidateUsageTx` also clears the history stamp, including marker-reset cases.
- Reopen unconditionally reconstructs from canonical history under the existing
  initialization writer reservation; restored old trigger definitions/false-clean
  metadata are not accepted. Startup uses an extra ledger pass and SQLite grouped
  token counts, not an unbounded Go owner map. Application memory is O(one record).
- Live reads use the existing separate read-only snapshot connection, not a writer
  transaction or full-history rebuild. Dirty-state degradation lasts until reopen;
  correctness wins over silent partial/zero totals. A single owner's very large
  history still requires scanning that owner's history.
- Online generation fences are not a defense against arbitrary hostile SQL that
  disables triggers, mutates records/proofs, then restores identical trigger
  definitions before observation. No external trusted anti-rollback state exists.
  As with existing canonical projection fences, reopening is the unconditional
  reconstruction boundary; exact current definitions cannot prove prior history.
- Derived tables are omitted from logical backups, accepted only with known shapes
  by current readers, and rejected as unknown physical schema by older readers.
  There is no new canonical migration, format, endpoint, or framework.

## Evidence so far

- New public Usage mutation/window and tamper regressions first failed against
  base because owner tables did not exist; then passed after implementation.
- Focused exact-window/mutation/false-clean-reopen/malformed-foreign-record tests
  passed (0.208s). Broader usage projection/resumable/history tests passed (3.842s).
- Focused race run of history, projection (including counter ingestion and budget
  settlement), old false-clean reopen, and context cancellation passed (36.103s).
- Cases include future/backdated facts, owner changes, deletes, fractional rounding,
  absent-owner fast lookup, rollback, normal generic mutation seams and RecordMeter,
  dropped/replayed/corrupt derived rows, missing triggers/table, and logical restore.
- Full integrated repository/CI and repeated 100k normal-CLI comparison remain
  pending. No remote CI, push, live data, real node, browser or native-core operation
  was performed by this change's author.

Additional focused verification:

- Final owner-history race tests, including missing canonical marker recovery and
  concurrent public write while an indexed read snapshot stays open: **5.764s
  PASS**. The old snapshot remains unchanged; a new public Usage sees the commit.
- Immediate predecessor **9e5dee0** actual reader rejects the new physical schema:
  **0.038s PASS**. Probe SHA-256
  `c913dc4e7d397cf452d6354c192630cb93f27a15def30d418d48fd84c99bcbed`;
  built from a detached 9e5dee0 checkout with only the tiny read probe added.
  The earlier d17c61b probe also passes, but alone would not isolate this change
  because that reader already rejects `usage_rebuilds`.
- `go vet ./internal/store`, production architecture guard, and `git diff --check`
  pass. Pinned TDD/review reference retrieval became available after initial
  implementation and was read during the review phase; initial missing local
  skill files are not claimed to have been read.


Independent review identified and reproduced three actual undercounts on the
initial implementation: same-name no-op derived triggers plus lower-proof replay,
same-name no-op canonical insert, and same-name no-op canonical update replaying
an old authenticated owner. These are retained failing-before-fix regressions,
not dismissed as harmless corruption. The correction validates exact definitions
of all nine relevant triggers before trusting a history stamp; any mismatch uses
the complete canonical read. Current-cycle projection's prior name-only checks
were reported separately to the coordinator rather than silently expanded here.

Corrected nine-definition trust check and independent regression suite plus owner
history/shared normal-mutation/false-clean reopen tests: **23.211s race PASS**.

Complete store package standard test matrix on corrected production `c0581ab`:
**45.774s PASS**, terminal 2026-11-01 20:04:29 UTC:

```sh
ROUTEWEAVER_LEGACY_STORE_PROBE=/tmp/owner-history-legacy-reader-9e5dee0 \
  go test ./internal/store -count=1 -timeout=150s
```

The actual immediate-predecessor physical-reader probe was enabled. Optional
large reference fixtures were not enabled in this command; the independent CLI
capacity worker owns the final 100k reference repeat. No CI or full-repository
acceptance is inferred from this package pass.
