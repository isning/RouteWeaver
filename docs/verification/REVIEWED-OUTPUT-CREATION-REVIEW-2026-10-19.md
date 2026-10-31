# Independent review: exact reviewed output creation

## Initial result and snapshot

**Final `e0bb417` recheck: both initial P2 UI recovery defects are fixed; no blocking finding remains in this bounded creation review.** Initial `c2725ef` findings and red evidence are retained below. Backend digest/CAS enforcement, owner separation and artifact freezing passed the focused checks. Neither UI defect demonstrates unauthorized publication or secret exposure.

Frozen review: `c2725effac0d0ac58f3321ee64f3e615ff8a2c3f`, parent `86857268536fb9fdecabd7ee822422d4d2787829`, archived into an isolated temporary tree. [Initial nine-file hashes](reviewed-output-creation-review-2026-10-19/reviewed-initial.sha256). Specification sources: `docs/product/UI-SPEC.md` and the commit's `docs/verification/reviewed-output-creation-2026-10-19.md`. A separate bounded standards reviewer inspected the changed production files; the main reviewer performed specification/security review and executed repros. No whole-system re-audit is claimed.

## Standards

### P2: a definite stale rejection is converted into unknown acceptance

`web/src/BasicRouting.tsx:272–278` and `web/src/Subscriptions.tsx:594–600` replace every failed POST with `APIError(0)` if the subsequent output lookup fails. A first creation attempt that returns an authoritative stale-review 409, followed by a failed GET, consequently hides the real rejection and leaves the stale preview retryable. The status-based invalidation handlers no longer see 409.

This violates AGENTS' requirements to distinguish error/offline/unknown states and show the concrete failure/next action. The creation contract also says known stale rejection requires a fresh review. The separate standards reviewer identified the code path; the main reviewer reproduced it through the DOM. Expected stale detail was replaced by “无法确认订阅是否已发布…”. [Red evidence](reviewed-output-creation-review-2026-10-19/known-rejection-red.log), [probe](reviewed-output-creation-review-2026-10-19/output-creation-independent-probe.tsx.txt).

Smallest correction: preserve definitive first-attempt rejection semantics while independently retaining genuinely unresolved prior attempts. Do not break lost-success recovery when a later retry returns duplicate-ID conflict and lookup remains unavailable.

Optional Fowler smell, not a hard violation: creation submission, receipt matching and unknown-result handling are duplicated across the two views. A narrow shared helper for typed outcomes would reduce drift; form-specific review invalidation should remain local. No other blocking standards violation was found in the frozen changed files.

## Specification

### P2: a background source refresh removes recovery for an unresolved accepted creation

`BasicRouting.tsx:143–151,255–256,475–478` gates both publication and the only reconciliation action on current draft/input review. Repro: server accepts creation; response is lost; first authoritative lookup is unavailable; a normal React Query focus refresh then changes only the source display name. `reviewCurrent` becomes false and the publication/reconciliation button disappears, even though the original creation remains recoverable by its server receipt. The UI demands another preview against an already occupied output ID instead of recovering the frozen attempt.

This breaks the documented same-ID/digest retry contract and UI-SPEC's distinction between current draft review and uncertain action reconciliation. [Corrected red evidence](reviewed-output-creation-review-2026-10-19/refetch-red.log), [probe](reviewed-output-creation-review-2026-10-19/basic-routing-independent-probe.tsx.txt). The first exploratory combined run used the wrong warning string; only this corrected run establishes the refetch failure.

Smallest correction: retain a frozen unresolved creation attempt separately from current preview/input freshness and provide a reachable recovery action after refetch. Recovering an old attempt must not silently discard later edits or imply those edits were published.

Otherwise the scoped creation descriptor, shared prepare/render path, server receipt, stable name allocation and frozen private resources match the intended contract. Existing-output publication clears the receipt; revoked status cannot reconcile; duplicate creation remains conflict rather than overwrite.

## Security and API verification

No additional blocking backend security finding demonstrated:

- Digest covers owner, stable ID/name/profile, effective target/mode, captured tenant records, final unredacted artifacts and private rule-file bytes. Tenant changes are compared atomically with output/token commit.
- Narrow decoding rejects client-supplied receipt/name-allocation fields. Output lists expose receipt/metadata, not tokens or raw artifacts. Different-owner digest reuse fails.
- Optional omission intentionally retains latest-input semantics. Explicit empty/incorrect strings and numeric digests are rejected. JSON `null` follows the existing optional pointer convention: legacy/unreviewed creation, with no receipt. This is not a way to forge reviewed creation; omission already permits the same legacy operation.
- An independent simultaneous same-ID/same-digest HTTP test observed exactly one 201 and one 409, one durable output/receipt, and no list token/artifact leakage. Revoke then republish clears the receipt.

Executed on the initial exact production snapshot:

1. `GOMEMLIMIT=512MiB scripts/go.sh test -race -p 1 ./internal/httpapi -run 'Test(ReviewedOutputCreation|OutputReview|OwnedRuleFilesPublishAsExactFrozenBundle)' -count=1 -v`: **PASS, 19.669s**. [Log](reviewed-output-creation-review-2026-10-19/reviewed-http-race.log).
2. Additional independent concurrent identity/receipt and digest-boundary probes: **race PASS, 3.425s**. [Log](reviewed-output-creation-review-2026-10-19/independent-http-race.log), [source](reviewed-output-creation-review-2026-10-19/independent-http-probes.go.txt).
3. The two adversarial DOM scenarios fail as described. Filtered-out owner cases in those negative runs are not counted as passes.

All identities, credentials and HTTP targets were synthetic/local. No production source edits, remote targets, native process tests, browser sandbox bypass, full backup/KDF rerun or full integration gate were performed by this review. Parent integration gates retain their separate commit/scope. The final recheck below supersedes the initial pending result.

## Final fix recheck

Frozen follow-up: `e0bb417fc1b51fb7101cac06598db86cd4848116`, parent `c2725effac0d0ac58f3321ee64f3e615ff8a2c3f`, archived separately before review. [Final nine-file hashes](reviewed-output-creation-review-2026-10-19/reviewed-final.sha256). This follow-up changes only the two creation views, their tests and the implementation note. The HTTP implementation is byte-identical to the initial reviewed snapshot; the earlier HTTP race evidence still applies to that backend scope.

### Standards final result

The separate standards reviewer rechecked the pinned two-file production diff and found **no blocking standards finding**. Known first-attempt 4xx retains the actual rejection; pending inputs are preserved and locked; recovery has a distinct consequence/action. The optional duplicated-recovery-logic heuristic remains, not a hard architecture violation. This is one separate bounded standards review plus the main reviewer's specification/security/probe work, not two full-system audits.

### Specification final result

**No blocking specification finding remains in the scoped creation contract.** The original definite-rejection probe passes unchanged. The original source-refetch probe passes with only its expected copy and action changed to the new dedicated receipt-check control; its accepted/lost-response and unavailable-first-lookup scenario is unchanged. Recovery is outside the Basic source-query state and no longer depends on current preview validity.

The final state transitions also cover the important negative branches: empty/unavailable lookup alone leaves a frozen uncertain attempt; explicit replay uses the same ID/descriptor/digest after refetch; a definitive replay rejection plus completed no-match lookup unlocks fresh review with the same ID. The retained uncertainty history lets later conflicts be checked without treating an old receipt as proof that a new digest succeeded. The owner test exercises late original completion after a revised review and verifies no invented success/overwrite. Closing the view remains an explicit escape; durable browser-reload recovery is not claimed.

### Independent final execution

- `npm --prefix web test -- src/output-creation.dom.test.tsx src/basic-routing.dom.test.tsx --maxWorkers=1`: **38/38 PASS, 19.46s**, comprising the pinned owner's 36 cases plus both independent repros. [Log](reviewed-output-creation-review-2026-10-19/final-focused-dom.log).
- Additional independent source-query-outage probe: accepted creation/response loss, first output lookup unavailable, source refetch fails and hides the form, then reachable GET-only exact-receipt recovery succeeds. **1 PASS, 2.90s**; 22 filtered cases are not additional passes. [Log](reviewed-output-creation-review-2026-10-19/final-query-outage.log), [Basic probes](reviewed-output-creation-review-2026-10-19/basic-routing-final-independent-probes.tsx.txt), [advanced probe](reviewed-output-creation-review-2026-10-19/output-creation-final-independent-probes.tsx.txt).
- `npm --prefix web run typecheck`: **PASS**. [Log](reviewed-output-creation-review-2026-10-19/final-typecheck.log).

A source-diff inspection of integrated main `b9c4486` against `e0bb417` confirms its routing-summary additions preserve these two components' recovery/replay/receipt logic. [Exact two-file diff](reviewed-output-creation-review-2026-10-19/integrated-production-diff.patch). This does not independently verify all routing-summary changes or replace the parent's integrated gates.

Final limits: synthetic DOM/API evidence only; no live browser, network deployment, cross-session idempotency or whole-system assurance. No additional backend security defect or secret exposure was demonstrated. **Standards: 0 unresolved blocking findings, 1 optional duplication heuristic. Specification: 0 unresolved blocking findings.**
