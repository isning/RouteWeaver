# Admission live-state projection: measured closed-history follow-up

Design only; no production edits. Extends the reviewed usage-only slice in `ADMISSION-PROJECTION-2026-10-19.md`, not its first implementation scope.

## Evidence and narrow goal

`admission_lifecycle_scaling_test.go` retains exact publicly produced finalized lease/budget pairs. Root's measured renewal medians: 0.528765 ms without retained pairs, 11.612721 ms at 1,000, and 131.975787 ms at 10,000; new-stream admission 135.745113 ms at 10,000 (final logged run). See `../verification/admission-scaling-2026-10-19/closed-history.log`. These shared-host results establish a closed-history dependency, not a capacity SLA.

Replace ONLY the two lifetime scans inside `AcquireAdmission`/`grantAdmissionBudget` with encrypted account working sets. Keep canonical rows, public interfaces, historical queries and all existing denial/commit rules. No membership index, plaintext IP/expiry index, admission cap, reservation refund, scheduler, or custom tree. Warm work becomes proportional to currently relevant obligations, not retained settled history. Live obligations themselves have no independent hard cap: release/new-presence churn can create many budgets despite few active leases.

## Three independent invalidation domains

Reuse the first slice's standard derived crypto, transactional mutation plumbing, schema validation, and backup exclusion mechanism, not its dirty marker indiscriminately.

- Usage dirty domain: canonical `ledger` only.
- Lease dirty domain: canonical `entry-admission-leases` only.
- Budget dirty domain: canonical `admission-budgets` only.

Each UPDATE trigger handles OLD or NEW kind. Each domain's tracked write applies old/new effects and acknowledges only its own clean-start generation. Unknown/bypass writes invalidate all cached accounts in that domain before clearing that domain's dirty marker. Lease writes must not erase warm usage/budget projections; settlement ledger writes must not invalidate lease sets. Multi-kind operations commit all effects together. Missing or corrupt working-state rows trigger full canonical reconstruction (or a safe error), never empty-account evidence; missing/unsupported schema or crypto context fails safely/rebuilds.

## Lease state and exact update rule

One AEAD payload per account contains `{version, account, watermark, activeByRecordID}`. Each entry retains the lease fields needed to count and compare: canonical record ID, embedded lease ID, client IP, scope/binding identity and expiry. Use canonical record IDs as keys, not a presumed equality with embedded IDs; generic writes and restore must not silently collapse distinct records.

At watermark `t`, membership is exactly `t.Before(lease.ExpiresAt)` for that account. On a tracked mutation, remove the old canonical record ID from its old owner's existing projection, then insert the new value into its new owner's existing projection iff it is unexpired at that projection's own watermark. Absent projections remain absent. Owner changes update both owners independently. Do not advance a watermark merely because another account or canonical writer passes a later timestamp.

Before admission counts at `now`: if state is absent/dirty or `now < watermark`, rebuild by streaming the full canonical lease kind and filtering by decrypted owner and `now`. Otherwise discard entries with `ExpiresAt <= now` and advance watermark. Count the exact IP union and records across all instances and routes. The individual canonical previous lease still decides binding/IP conflict and whether this request renews an existing presence. A released lease does not close its budget.

## Budget state and exact update rule

Separate encrypted payload: `{version, account, watermark, liveRelevantByRecordID, expiredUnresolvedCount}`. For structurally decoded, nonexceptional records (`GrantedRaw >= SettledRaw` for unclosed finite budgets), relevance is:

`!Closed && (!Finite || GrantedRaw > SettledRaw)`.

An unclosed finite budget with `GrantedRaw < SettledRaw` is exceptional, **not irrelevant**. The canonical evaluator subtracts unsigned values and then applies its existing expiry/conversion/weighting checks; do not replace that behavior with the `>` predicate. Mark its account exceptional and use the unchanged canonical evaluator, preserving acceptance of generic canonical writes.

At watermark `t`, each nonexceptional relevant canonical record contributes to exactly one partition: live map if `t.Before(ExpiresAt)`, otherwise expired count. Closed and finite fully settled budgets contribute neither. They are still retained canonically and read directly for their own presence renewal/final/replay rules. Keep finite outstanding raw bytes and frozen rate in the live entry; do not combine rates or round once across budgets.

For every old/new mutation, classify old and new relative to each affected account's **stored watermark**, not settlement time, expiry wall clock, or the next request's time. Remove the old contribution first; add the new contribution second. A relevant expired budget that remains relevant expired is net zero; final/complete settlement removes its one count; nonfinite unclosed remains relevant even with zero outstanding bytes. A new expired relevant record adds one count. Never decrement twice for replay. Counter underflow or inconsistent membership is corruption: rebuild/error, not clamp to zero.

Advance to `now >= watermark` by moving newly expired live entries to the count, never dropping their reservation uncertainty. For backwards `now`, rebuild from full canonical budgets; a count alone cannot reconstruct formerly live identities. The full scan also supports cold restore/reopen after invalidation. A late report updates the historical canonical budget and ledger as before; it changes expired count only according to old/new relevance. Resolving one expired obligation does not clear any other obligation, including one on another route or instance.

At grant evaluation, an expired relevant obligation yields the existing pending denial. A live nonfinite obligation also blocks a finite policy, just as today. Otherwise compute reserved cost by summing `WeightedBytes(outstanding, frozenRate)` **per live finite budget**, preserving overflow checking and the existing own-budget inclusion. Do not store a rounded ledger-style numerator for reservations. Compute from the live map initially: avoid another maintained aggregate and its invalidation burden. The requesting canonical budget still supplies closed/expired/policy-boundary checks before this aggregate query.

## Exceptional canonical data: preserve evaluator ordering

The optimized path may be used only when the domain/account is known to be representable by the compact projection. Perform exceptional checks, cold rebuilding, and canonical fallback **only at the location of the replaced scan**, not eagerly before existing own-budget, policy, IP, or connection denials. Otherwise an exception from a scan the original path never reached would change the result. Introduce durable exceptional markers inside the appropriate derived domain, not new public validation rules. They are rebuildable and excluded from canonical backup. A missed writer makes the domain dirty as usual; dirty state cannot be acknowledged while ignoring exceptional rows.

The existing `listTx` first decrypts/authenticates **all** selected rows and decodes each into `json.RawMessage`, then the caller typed-decodes rows in canonical-ID order. Consequently:

- A corrupt ciphertext or invalid raw JSON anywhere fails before any pending denial. Preserve the initial all-row authentication/raw-validation behavior on a cold path; do not return early because a prior row looks pending.
- A raw-valid JSON value that fails budget/lease typed decoding is different: an earlier budget may return pending before that later type error. Eager projection decoding must not replace this with an immediate type error.

On any typed decode failure, mark the **whole domain** exceptional, invalidate its cached accounts, and route the decision through the unchanged canonical evaluator in that same transaction. Do not assume the owner is trustworthy or known from a partially decoded value. On raw authentication/JSON failure, preserve the original error instead. On structurally decoded arithmetic anomalies (including finite unsigned underflow, out-of-range live outstanding values/rates, or aggregate overflow), an account-specific exceptional marker is sufficient when ownership is known. An underflow marker is independent of live/expired relevance and must not disappear through expiry compaction or backwards-time classification; the canonical evaluator decides its exact result. Using a whole-domain marker initially is a simpler conservative alternative. The evaluator, not the projection builder, decides whether an earlier pending condition precedes an exception.

Normal tracked writes encountering an old/new typed or arithmetic anomaly must still commit canonical data if that public write previously allowed it. Mark exceptional/invalidate instead of rejecting, truncating, normalizing, dropping or initializing partial derived state. Never create a projection containing only the valid rows around an exception. Identity/owner movement must invalidate both provable owners; an undecodable owner requires domain-wide exceptional fallback.

While exceptional, bypass the entire affected compact query and run the original canonical scan/order. Clear an exceptional marker only after a complete canonical rebuild establishes that the relevant scope is representable; deleting or correcting one row is not alone proof that no other exception remains. Reopening retains the marker; restore starts dirty and rediscovers it. Missing/corrupt markers are not permission to trust incomplete state: use the normal derived-state initialization/invalidation contract.

Cold rebuild may temporarily use the existing `listTx` materialization for exact compatibility rather than introducing a new two-pass streaming evaluator in this slice. If streaming is later used, its authentication pass and typed decision pass must preserve these semantics under one SQLite snapshot. Warm snapshots built from supported valid mutations require no repeated history scan. This does not add protection against an external adversary rewriting SQLite data and its derived metadata without supported mutations; canonical AEAD already lacks rollback/truncation protection.

## Integration and queries intentionally left canonical

Acquire must load/refresh lease state before its IP/connection check and budget state before global reservation evaluation, under its existing SQLite writer reservation. Its settlement occurs first; those tracked writes must update any already-present derived payloads. A normal denial still commits legitimate settlement and derived changes through the existing deny closure. A watermark is persisted only in that same committed transaction; rollback or an early uncommitted denial must not advance it. An error still rolls back except the existing explicitly committed accounting-anomaly path. Final-without-prior-budget, release, and reviewed final resolution remain atomic.

Tracked mutation inventory: acquire/renew/final, release, `settleAdmissionBudget`, `grantAdmissionBudget`, `ResolveAdmissionBudget`, all generic Put/Remove/Update/Compare/Generate paths, and both imports. Generic owner changes/deletes must update old/new owners; raw misses hit the dirty backstop. Import invalidates all three domains; read-only backup/export never rebuilds. Fresh restore initializes the same derived crypto context and lazily reconstructs from canonical source. Derived rows remain excluded from unchanged canonical backup frames/digests.

Leave these current queries canonical in this slice:

- `SetRate`: it rejects any unclosed matching-route budget overlapping the rate boundary, including finite zero-outstanding budgets excluded above.
- `ManualReset`, `guardBudgetPolicyUpdateAt`, and `activePolicyLimitsTx`/`guardActivePolicyLimits`: retain their existing all-account guards and preview rollback behavior. Their predicates and scopes are not identical to a single-account admission query.
- `AdmissionBudgetReviews`: it reports historical and resolved facts, not just active obligations; `ResolveAdmissionBudget` loads the target canonical records/digest.
- `AdmissionStatus`: leave its read-only snapshot canonical rather than silently requiring a writer just to show status.
- `unresolvedBudgetHold`/`HasAccountingHold`, `hasAccountPolicyHistoryTx`, resets/rates/holds, effective-policy reads and all historical list/export paths. Particularly, historical existence must not vanish when compact state is empty.

These residual scans are explicit. This slice removes the measured closed-history hot-path scans; it does not claim every administrative or status query is history-independent.

## Differential proof matrix

Use public Store operations against the canonical full-scan model; test intentional raw bypasses separately as infrastructure tests.

1. Same account and unrelated accounts: 0/1k/10k closed pairs; active lease identity/IP unions and finite ceilings unchanged; warm renewal and new-stream costs stop following closed history.
2. Shared IP and distinct IP, multiple entries/instances/scopes, 4096 presence cap, released lease with live budget, repeated release/new-presence churn beyond 4096 outstanding budgets, zero-rate and unlimited budgets. No inferred budget cap/refund.
3. Exact expiry equality, forward watermark, reversed arrival times from another Store, old/new owner mutations, arbitrary canonical versus embedded IDs, delete/reinsert and same-record replay. Cold rebuild matches live update results.
4. Finite zero outstanding versus unclosed nonfinite zero outstanding; partial settlement, duplicate final, final without existing budget, anomalous over-report, renewal denied after valid settlement, reviewed stopped-runtime finalization and stale review digest.
5. Many expired unresolved obligations; partial late report stays unresolved, final decrements only one, zero remaining finite clears only that obligation, cycle/route changes never forgive another old obligation. Backwards time reconstructs their live partition.
6. Fractional/zero rates, near-limit reservation sums, unclosed finite GrantedRaw<SettledRaw before/after expiry, corrupted/unrepresentable arithmetic and expired-blocker ordering. Raw-valid typed-invalid JSON before versus after an expired pending budget; foreign-account typed errors; ciphertext corruption anywhere; and repair/reopen of exceptional domains. Preserve the canonical result/error or take a documented canonical fallback, never allow on uncertainty.
7. Independent handles and subprocess races for last IP/connection/quota allocation, grant versus final/release, raw SQL mutation, transaction failure/rollback, missing projection/schema/crypto state, reopen and different-key restore. Dirty lease writes do not invalidate usage and vice versa.
8. SetRate finite-zero guard, policy preview/apply reductions and first-assignment historical existence remain identical. Complete encrypted history and canonical backup digest remain identical before/after rebuilding or dropping only derived state.

Implement after usage plumbing and its independent review stabilize. One small private live-state module and two hot-path substitutions are the intended seam; do not generalize it into a query framework. Test production-like renewals with settlements as well as closed-history fixtures, and report cold reconstruction separately from warm latency.

Independent review: `../verification/ADMISSION-LIVE-STATE-DESIGN-REVIEW-2026-10-19.md`. The exceptional fallback and scan-placement refinements above incorporate that review; they remain design requirements, not implementation evidence.

## Reopen equivalence clarified after implementation review

Reopen may preserve an authenticated exceptional marker, or atomically invalidate every account snapshot and reconstruct complete canonical state before any optimized use. The implementation takes the latter path. A clean marker with no account snapshots cannot authorize a cached result. No partial reconstruction or empty-account inference is permitted.
