# Reviewed new-output creation

## Contract

- `POST /api/me/outputs/preview` accepts `{id, name, profileId, target, mode}` with a stable, explicit new output ID. It returns the existing redacted preview format, `previewScope: "new-output"`, `outputId`, and `previewDigest`. This is read-only; it does not reserve the ID or issue a feed token.
- `POST /api/me/outputs` accepts the same descriptor plus optional `previewDigest`. With a digest, it prepares the candidate using the same captured-input reader and renderer as preview, checks the exact review, then uses the existing input-CAS publication transaction. Changes to owner, identity, effective target/mode, profile, sources, resource files, grants, names or unredacted material invalidate review. Invalidated preparation returns 409; no candidate is published.
- No-digest callers retain current-input semantics. Explicit incorrect/empty digests are not equivalent to omission. New product UI creation paths always supply a reviewed digest.
- Only successful reviewed creation stores `creationReviewDigest`. Clients cannot submit that receipt or name allocations. Owner-scoped output views expose the receipt, not tokens or raw artifacts. Republish clears it; revoke cannot reconcile because status is not published.
- UI reconciliation requires matching ID, profile, published status and receipt. It cannot claim an unrelated existing output or a later republish as the reviewed creation. An uncertain request/lookup preserves the attempt for retry with the same ID and digest. A known stale rejection keeps draft choices and requires review again.

## Evidence and limits

The public HTTP tracer first failed at the absent preview route (404), then passed after implementation. A subsequent mutation sensitivity check removed only creation digest validation: the profile/source/resource/secret/identity/owner/private-file cases all failed by accepting 201; restoring the check returned them to green. Focused serial race tests cover stale profile, source, resource, secret-only changes, identity/owner changes, exact no-secret artifact content, legacy no-digest behavior, duplicate creation rejection, receipt clearing, server-owned receipt fields, frozen private rule-file bundles, and stable collision-resolved names. Existing-output review and private-bundle regression tests run in the same gate.

Commands:

- `scripts/go.sh test -race -p 1 ./internal/httpapi -run 'Test(ReviewedOutputCreation|OutputReview|OwnedRuleFilesPublishAsExactFrozenBundle|Output)' -count=1`
- `scripts/verify.sh static`
- `scripts/go.sh vet ./internal/httpapi`
- `npm --prefix web run typecheck`
- `npm --prefix web run build` (passed; existing large-chunk warning)
- `npm --prefix web test -- --maxWorkers=2` (15 files / 111 tests; focused creation/basic DOM suites: 28 tests)

DOM tasks cover both new-creation paths, stale-review choice retention, mismatched/missing receipt rejection, and accepted/lost creation plus unavailable first lookup followed by same-ID/digest retry. The uncertain-lookup tests failed before their recovery change and passed afterward. The full DOM run emitted the existing jsdom canvas warning but had no failed/skipped tests.

This is a bounded local API/UI change, not deployment or native-client execution evidence. The full backup/KDF gate and live browser ports were deliberately not duplicated while the parent aggregate was running. Existing publication-CAS machinery is reused, not replaced by a new transaction system.

## Independent recovery-state audit follow-up

Two independently reproduced UI recovery defects were corrected after the initial slice:

- An explicit stale-review 409 must remain a known rejection even if a later lookup is unavailable. A first definitive 4xx now bypasses reconciliation entirely; an earlier uncertain attempt remains separate state, not a rewrite of the latest response.
- Source refetch must not hide recovery for a possibly accepted creation. A frozen pending attempt now has an independent read-only receipt check and an explicit same-ID/digest replay action outside the Basic editor's source query state. Creation fields/save/review/advanced actions are held while pending so recovery cannot discard newer choices or imply a different draft was published. Closing remains available. An empty/unavailable lookup alone does not claim failure or success. A definitive replay rejection followed by a successful no-match lookup permits fresh review using the same output ID; a late original receipt must not be mistaken for the newly reviewed attempt.

DOM regressions first failed and then passed for definite stale rejection plus unavailable lookup in both creation paths, source-refetch invalidation while an accepted attempt is unresolved, duplicate-conflict retries with repeated unavailable/empty receipt lookups, and a request that never arrived followed by empty lookup and successful identical replay. This follow-up changes no backend receipt or renderer contracts.

Follow-up terminal gates: typecheck passed; focused creation/Basic DOM 36/36 passed; full DOM/unit 119/119 across 15 files passed (31.17s); scoped Prettier and `git diff --check` passed. The final release/late-original cases were independently red before their production changes. No backend change or live browser/native/deployment claim is part of this follow-up.
