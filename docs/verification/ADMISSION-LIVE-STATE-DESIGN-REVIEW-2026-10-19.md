# Independent admission live-state design review

2026-10-19. Design/source review only; no production edits, performance tests, or implementation approval. Reviewed `ADMISSION-LIVE-STATE-2026-10-19.md`, the usage-only predecessor, current canonical admission/budget/recovery/policy/backup paths, and the read-only usage-projection implementation branch's mutation, crypto, dirty-state and backup plumbing.

## Verdict

Conditionally endorse the two-hot-path scope, subject to the two exception-handling corrections below and the proposed differential gates. The normal-data old/new classification is sound: use each owner's stored watermark, remove then add exactly once, preserve expired unresolved obligations, rebuild on backwards time, and retain canonical record IDs rather than collapsing embedded IDs. Lease release must not refund budgets; closed history can disappear from derived state without disappearing from canonical evidence.

## Must fix before implementation

1. **Malformed finite counters cannot be dropped by the relevance predicate.** `grantAdmissionBudget` currently computes unsigned `GrantedRaw - SettledRaw` and skips only zero, whereas the proposed predicate excludes `GrantedRaw < SettledRaw`. For an unclosed live budget with granted 0 and settled 1, the canonical conversion to int64 is -1 and `WeightedBytes` errors. If expired, the canonical result is pending instead. The proposed state omits the record and its arithmetic fallback never sees it, potentially granting instead. Preserve these as exceptional canonical facts and route evaluation through the existing ordered evaluator. Do not newly reject a generic canonical write merely because the derived representation cannot handle it. Closed malformed-counter records remain skipped by the canonical reducer. Test both ID orders relative to another pending blocker, before/at expiry, replacement/deletion, owner moves and reopen.

2. **Fallback must include typed-decode exceptions, not only arithmetic exceptions.** `listTx` first authenticates/decrypts every row into `json.RawMessage`; the grant loop then typed-decodes in ID order, potentially returning pending before a later type-invalid JSON budget. A streaming cold rebuild that immediately returns that later typed-decode error changes denial/error precedence. Conversely, silently dropping it loses the error when no earlier blocker exists. Unknown-owner/type-invalid records need domain-wide exceptional fallback (not merely one account invalidation), preserving the canonical two-stage evaluation. A compact authenticated exception marker plus canonical fallback is sufficient; no ordered expired-budget index is necessary. Raw bypass/import, repair and deletion must invalidate/recompute that marker. Add typed-malformed rows before/after pending and arithmetic-error rows, including unrelated-account content. Lease rebuilding also must not silently ignore undecodable rows.

## Required implementation constraints confirmed

- Keep eligibility, credential/manifest freshness, own-budget closed/expiry/policy checks and denial commit ordering in their existing positions. Do not eagerly load budget projection ahead of an IP/connection denial.
- Independent dirty generations and OLD/NEW-kind triggers must cover generic writers, owner changes, imports and raw SQL. Counter ingestion remains on the usage slice's centralized transactional plumbing. Dirty one-account reconstruction cannot acknowledge stale peer accounts.
- Keep administrative rate/reset/policy guards, historical existence, status and review queries canonical: their predicates differ. Finite zero-outstanding unclosed budgets still matter to `SetRate`.
- Retain the first slice's keyed lookup, separated AEAD purposes/AAD, fresh nonces, all-constructor initialization, exact backup table allowlist and canonical-only frames/digest. Document equality/existence, ciphertext-size and write-pattern leakage; never expose IPs, watermarks, amounts or frozen rates as SQL columns.
- Missing/corrupt rows never mean empty. Checked unresolved counts, atomic old/new mutation effects, rollback and anomaly-commit tests remain necessary. No 4096 budget bound or new admission denial follows from the lease cap.

The design removes measured settled-history scans, not unbounded live-obligation cost or residual administrative scans. Measure release/new-presence churn and settlement-bearing renewals separately from closed-history warm latency; cold reconstruction remains deliberately linear.

## Revised-design confirmation (20:33 UTC)

Re-read the current design after its exception-handling revision. Both must-fix findings above are resolved **in the design**: unsigned-underflow budgets remain exceptional independent of expiry; typed decode failures use domain-wide fallback; raw authentication precedes typed canonical-ID evaluation; fallback stays at the original scan location; repair cannot prematurely clear exceptional state. The current document is acceptable to enter isolated implementation, conditional on its differential, rollback/race, backup/restore and scaling gates. This is not implementation verification or a claim that the first slice's outstanding whole-backup gate has passed. The earlier findings are retained above as the review trail, not outstanding design blockers.
