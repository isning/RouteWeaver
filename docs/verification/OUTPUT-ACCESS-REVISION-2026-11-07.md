# Opened subscription access action preconditions

## Bounded backend change

Output list/detail and create/publish/rotate/revoke responses now include `accessRevision`, an opaque keyed review token scoped to the authenticated owner and output ID. It covers the complete saved Output, including credential and publication state. Rotation therefore changes it even though the existing publication `revision` remains unchanged. The access/link response and coarse comparison response retain their existing contracts.

Rotate and revoke accept one explicit `If-Match` containing the opened `accessRevision`. Empty, malformed, duplicate, wildcard, combined, other-output, other-owner and stale values produce HTTP 409 with `OUTPUT_ACCESS_CHANGED` and no credential details. Tenant lookup still precedes this check. The exact checked Output remains the existing atomic record/token-index CAS expectation; commit-time conflicts use the same safe error.

Compatibility is explicit: an omitted header retains legacy current-record behavior. This slice does not make old callers stale-safe, add operation IDs, or implement idempotent successful-response replay. A guarded retry after a committed mutation conflicts; it cannot execute the mutation a second time. A legacy repeated rotation can still issue another link. The UI carries the token captured when the decision opens and refuses to write if that token is absent. It never silently uses this compatibility branch.

## Public HTTP regression cases

`internal/httpapi/output_access_revision_test.go` covers:

- A new rotation rejects a delayed rotation of the opened predecessor, preserving both newer feed and bundle links.
- A delayed revoke cannot revoke a newly republished subscription. A fresh matching revoke still denies its links.
- Invalid/duplicate/foreign preconditions do not alter access; knowing a foreign token grants no tenant access.
- Omitted headers intentionally preserve legacy behavior, including non-idempotent repeated rotation.
- List/detail metadata identify the same opened output; mutation response tokens change with rotation, revocation and republication.

Tests observe public HTTP responses and actual anonymous feed/bundle fetch outcomes, not store state. Synthetic account setup reuses the existing fixture helpers.

## UI and browser regressions

The confirmation captures a primitive access revision before any background refresh. A definitive `OUTPUT_ACCESS_CHANGED` rejection closes that expired decision, refreshes metadata and permits a newly opened confirmation. Network failures, malformed responses, generic conflicts and unverified rotation results retain the existing unknown-result guard and never replay rotation automatically. Successful rotation metadata is allowlisted, without retaining returned bearer paths; access reads are owned by both publication and access revision.

DOM regressions cover captured consent through refresh, rejected-conflict recovery, missing revisions, unchanged/missing success revisions and access-response ownership. `web/tests/output-access-conflict.ui.spec.ts` uses the real demo backend and UI with synthetic accounts/data to verify stale confirmations cannot invalidate newer access, followed by a deliberate fresh action. Recordings and credential-bearing diagnostics are disabled.

## Verification status

The first stale-rotation regression was written before implementation. Its attempted targeted command, `./scripts/go.sh test ./internal/httpapi -run '^TestOutputAccessRevisionStaleRotationPreservesNewerLinks$' -count=1`, stopped with exit 2: no Go compiler available. No failing-before-passing runtime result is claimed. Added tests, formatting verification, backend regression and runtime/browser checks still require the normal compiler/CI gates. Frontend and real-browser stale-confirmation regression sources are present; local Vitest, TypeScript and browser execution are unavailable because dependencies are not installed. CI results must be checked for the exact published commit before claiming runtime verification. No external deployment or live records were used.
