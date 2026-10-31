# Independent review: encrypted current usage, stage two

## Result and exact scope

**No unresolved P1/P2 demonstrated in the reviewed ledger-only slice after `070fc08`.** Two reported concerns reproduced on `1038415` and their unchanged safety assertions pass after the follow-up. This acceptance does not cover the proposed lease/budget compaction or claim that the complete admission path is lifetime-history independent.

- Fixed point: corrected stage one `42cd24f5b63c8a7ede8eabe5e67fe6026881a99f`.
- Initial stage two: `103841585184b565d5792505a125128fe0c7311b`.
- Final reviewed commit: `070fc08d5965a09411dd9d1f46a9a059bf7bbdd3`.
- Exact git archives were reviewed in isolated temporary directories, not the owner's moving worktree. All 11 changed files were byte-compared with the final commit. [SHA-256 manifest](usage-projection-stage2-2026-10-19/reviewed.sha256).
- One independent reviewer, with standards and specification axes considered separately. The root reviewer originally raised the lookup privacy concern; the owner raised missing-trigger coverage. This report independently reproduces/rechecks them, not claims original discovery.

## Findings fixed before acceptance

### P2: raw account lookup weakened the stated metadata-privacy contract

Initial `usage_projection.go:39,78` selected/wrote `usage_windows.account` using the logical account ID. Warming public admission therefore persisted an explicit account-to-current-projection mapping even though the accepted design required separately keyed lookup metadata. Existing account IDs elsewhere in the database do not make this new activity linkage free. This is not plaintext usage, quota, credentials or traffic disclosure.

Reproduction: create a synthetic account, warm its window through public admission, inspect the derived SQL row. `TestIndependentStage2RawAccountLookupNotPersisted` failed on the literal `account` key.

Smallest fix, implemented: a separately purpose-derived HMAC-SHA256 lookup key and opaque token for every read/write/delete (`usage_projection.go:30–38,47–92`; `usage_projection_schema.go:28–40`). AEAD remains separately derived, uses fresh nonces and account/version-bound AAD, and canonical encryption is unchanged. Same-account tokens differ after different-master-key restore. Destination cache rejects source-key ciphertext and reconstructs authoritative usage before admitting.

### P2 correctness under the documented schema-fault model: absent trigger allowed stale warm usage

Initial `usage_projection.go:143–149` trusted a clean generation without checking that the dirty backstop still existed. Synthetic reproduction: warm an empty window, drop the ledger INSERT trigger, restore an authentic 29-byte canonical ledger record through raw SQL, then request admission with quota 36. Public canonical usage required a 7-byte grant; initial code granted 36.

This requires **schema loss plus a bypassed/missed canonical writer**. It is a fault-contract failure, not a demonstrated remote-user exploit or a claim of hostile-database tamper resistance. Normal tracked writes without their trigger already failed their expected-generation acknowledgment.

Smallest fix, implemented: require all three named triggers before trusting generation (`usage_projection.go:158–177`); fail closed until reopen reinstalls triggers and invalidates all windows. The check is constant-size schema metadata, not a ledger scan. Same-name malicious trigger replacement and adversarial database rollback remain explicitly outside scope.

Both failures and exact observed grant are retained in [red evidence](usage-projection-stage2-2026-10-19/independent-red.log); final probes pass in [green evidence](usage-projection-stage2-2026-10-19/independent-final-race.log).

## Standards axis

No additional blocking standards violation found. The change stays in the persistence adapter, uses existing SQLite transaction ownership and standard cryptographic primitives, introduces no dependency/API/runtime exception, and leaves canonical facts authoritative. One private usage module plus the previously centralized mutation helper is proportionate to the measured bottleneck. Historical `Usage` deliberately remains an independent full reducer rather than sharing the optimized implementation and weakening differential tests.

The mutation-inventory AST guard is useful maintenance protection, not a proof that arbitrary generated SQL can never bypass it. Reviewed actual production SQL as well: the remaining raw statements outside the helper/importers target fixed non-ledger kinds; both logical importers explicitly invalidate derived state. Future generic mutation additions still require review.

## Specification axis

Verified the intended narrow scope and core invariants:

- Exactly two admission ledger reductions use the projection. Lease/budget, policy/hold/reset/rate scans remain unchanged; cold full-ledger reconstruction is explicit.
- SQLite's writer reservation precedes mutation reads. Old/new facts update only already complete matching windows, including owner transfers, deletion, replacements and repeated writes to the same key within one batch. Missing/corrupt rows never become zero plus the next delta.
- Clean-start mutation acknowledges only its own trigger increment. Dirty-start mutation cannot hide earlier bypasses. Dirty recovery removes **all** account windows before acknowledging, not just the requested account.
- Exact decimal arbitrary-precision raw/provider totals and weighted numerator retain overflow and allow later correction. Weighted rounding occurs once on aggregate output. Half-open `ObservedAt` windows, finite calendar boundaries, manual/future resets, backwards arrivals and committed future-relative-to-arrival facts agree with the public full reducer.
- Denied renewal can commit valid settlement. A separate independent probe confirms that an already-warm window reflects the settlement **without reopening**, avoiding an initialization scan that could mask a missed delta.
- Unsupported derived version/missing marker/corrupt ciphertext rebuild rather than authorize zero; missing schema/trigger errors close. Canonical facts and projection updates roll back together.
- Read-only backup does not repair derived state; logical archives omit it. Shared constructor initializes both derived crypto purposes, different-key restore rebuilds, and canonical logical snapshots remain equal. Opaque lookup equality/row existence are still visible; no oblivious-storage claim.

## Executed verification and limits

Independent temporary-only probes: [source](usage-projection-stage2-2026-10-19/independent-probes.go.txt).

1. Initial two focused negatives on `1038415`: failed as described, 0.216s.
2. `GOMEMLIMIT=512MiB scripts/go.sh test -race -p 1 ./internal/store -run '^Test(IndependentStage2|UsageProjection|CanonicalRecordMutationInventory)' -count=1 -v`: **PASS, 9.011s** on `070fc08`. [Log](usage-projection-stage2-2026-10-19/combined-race.log). Includes owner differential/overflow/calendar/raw-writer/multi-account invalidation, all four import/fresh-restore paths, account-AAD swap, read-only backup and incremental-mutation tests.
3. Final six independent probe families, including the additional different-key lookup/ciphertext test: **PASS, 2.599s**. Covers two warmed owners across Store handles, same-key batched owner transfers, rollback, missing/corrupt state followed by tracked writes, hot denied settlement, both fixed negatives and rekeying.

No external hosts, real credentials, native daemons, sandbox bypass or production edits were used. This review did not independently rerun full-project CI, performance characterization, crash/power-loss injection, maximum-size backups or a separate subprocess contention harness. Cross-Store handles are tested; they are not claimed as subprocess coverage. Owner aggregate gates are recorded separately when available.

The [owner's final keyed-row characterization](usage-projection-stage2-2026-10-19/owner-measurements.md) reports 10,000-ledger-row warm medians of 1.207ms unrelated / 0.758ms same-account, versus 95.780 / 98.247ms baseline, with cold reconstruction still linear. These are source-linked owner measurements, not independently reproduced here or an SLA. Closed lease/budget history remains a separately measured bottleneck; this patch must not be described as solving that next slice.

### Supplemental stable test checkpoint

The test-only follow-up `2447c26` does not change production bytes. Its public warm-counter test was inspected and separately rerun against the reviewed production snapshot: **PASS, 1.582s**. It exercises counter replay/deltas, provider-vs-payload separation, operator baseline without invented charge, and managed-budget snapshots without duplicate charging. [Log](usage-projection-stage2-2026-10-19/counter-recheck-race.log).

Owner-reported aggregate gate, with retained terminal output: whole `internal/store` race at the final production checkpoint **PASS, 51.119s**. [Log](usage-projection-stage2-2026-10-19/owner-store-race.log). This is an owner's aggregate run, not another independent full-suite execution.

The owner's original serial `internal/backup` race gate subsequently completed with exit 0: **PASS, 420.151s**, `GOMEMLIMIT=512MiB`, same `070fc08` production bytes. [Terminal log](usage-projection-stage2-2026-10-19/owner-backup-race.log). The long non-verbose run had no intermediate progress output; it was not counted as passed until terminal completion. No duplicate heavy backup run was started by this reviewer.
