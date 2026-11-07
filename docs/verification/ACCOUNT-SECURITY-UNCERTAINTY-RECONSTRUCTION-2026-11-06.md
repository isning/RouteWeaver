# Account security uncertainty: source-only candidate

Baseline: a1fbbc301378e47489660791e68f8c50fcf2b93f (v88).
This is new reconstruction, not recovered v102 bytes or equivalent runtime evidence.
The historical v102 object 3fb249de1815f7e9a1f3e7f9841eb271dbbdaaa6 is unavailable.

## Implemented bounded scope

AccountSecurity.tsx password change, revoke other sessions, revoke one session, and administrator account actions:

- Save an actor-bound sessionStorage reminder before dispatch. Only actor ID, target presentation ID, action enum and timestamp are persisted. No password, OTP, CSRF token, session authentication token, reason, confirmation input, response or request body is stored.
- Persistence failure blocks dispatch. Invalid/cross-actor records fail closed. Records survive page remount and same-tab reload. They do not claim cross-device or browser-close durability.
- No mutation retry; networkMode always avoids queued offline mutation execution. Transport request/response ownership remains in api.ts and SessionLifecycle.ts, unchanged. Components fence post-unmount callbacks. Late success for an inactive component does not remove its reminder.
- Successful response needs a minimum expected shape. HTTP 400/401/403/429 rejection clears the reminder when active. All 409, 404, 5xx, network failures, malformed success, ownership failures and unclassified exceptions conservatively remain uncertain. Classification deliberately does not interpret backend 500 wording as rollback proof.
- Uncertain forms clear credentials; retained administrative reason/action remains only in component memory. Settled mutation variable objects are scrubbed, mutation garbage-collection time is zero. Definite rejected credentials retain the existing editable form draft, not persistent storage.
- Read recovery uses existing authenticated GET routes only. It checks response structure, displays current sessions/account flags, never claims historical completion or validates the new password. Missing target and failed reads are inconclusive. Reads do not remove records or unlock writes.
- Dismissal requires a separate confirmation explaining that it neither cancels the action nor proves failure and that a new submission can duplicate effects. There is no replay action. New writes require fresh user input.

## Backend/ownership evidence inspected

- internal/httpapi/auth_security.go: local browser session guard, rate limits, rejection mappings and operation responses.
- internal/httpapi/auth.go: publicAccount returns explicit state booleans; password session response carries user and CSRF token.
- internal/store/identity_lifecycle.go: transactional security updates/commit errors; SessionView IDs are presentation IDs, not token digests. GET sessions can perform backend housekeeping (pruning), although the UI issues no mutation during recovery.
- web/src/api.ts and web/src/SessionLifecycle.ts: existing guarded response ownership; locally generated 409 can represent uncertain response ownership, not a definitive server rejection.
- web/src/Security.tsx: separate MFA enrollment flow reviewed, not changed.

## Tests and evidence status

Added public DOM UI cases at the established rendered-UI/fetch boundary for lost response, 409, 500, malformed 200, same-actor remount, nonsecret metadata present before dispatch, failed persistence, actor switch with late success, inconclusive 404 read, malformed account state, explicit dismissal warning/confirmation, and cross-actor stored metadata. Updated one existing 500 failure test to require clearing administrator credentials while preserving the reason. These tests are **UNRUN**.

Only text/source inspection and git diff --check were performed. No Node, npm, Go, gofmt, build, typecheck, DOM execution, browser, network, install, push, deployment, or real account-security action was performed. No red/green claim. No independent runtime review. Type and accessibility behavior still require authorized verification.

## Explicit unresolved scope

- Security.tsx MFA prepare/enable is NOT covered. Setup secret retention, enable response rotation, and MFA-specific unknown outcomes require a separate coherent implementation and tests. This is not full account-security/v102 parity.
- There is no backend receipt/idempotency/reconciliation endpoint. Current reads cannot establish whether a particular historical action committed. A password change with a lost cookie response may require manual login/account recovery.
- sessionStorage is per tab and user-agent editable. It is not security authority, a cross-tab lock, a server audit record or a durable receipt. A manually cleared store loses its reminder. An invalid store intentionally blocks writes; supported repair UX remains unresolved.
- Same-actor transport-generation fencing relies on the existing installed session transport. New tests exercise account switch/remount and HTTP 409, not the full installed transport rotation journey. Those existing integration tests and new cases must be run later.
- Account action response validation checks target identity; it does not infer full state from a mutation response. Only separately validated read state is summarized.
- Large AccountSecurity.tsx gains an internal helper rather than adding a new architecture module. Refactoring and rendered content review remain separate work.

## Merge guidance

No lifecycle consequence copy from the original account actions was changed. The separate lifecycle-warning commit a9acd3fa261ff370f375afdd4840936606e32112 can be integrated independently; preserve its updated consequence strings. This change touches AccountSecurity.tsx plus its DOM tests and this evidence document. Do not replace the whole component from either branch when resolving any merge conflict.


## Follow-up: inactive validation dispatch fence

Source review of 0ed929661e028d57a968bc05adff7441bc6457ff found that asynchronous form validation could finish after the actor-keyed task unmounted. A response-generation guard alone is insufficient: delayed dispatch could capture the replacement actor's transport generation.

The follow-up checks the task's active ownership at the start of recovery.run, before any storage or request, and in both password and revoke-other public onFinish callbacks. Recovery inspection and dismissal also reject inactive entry. Ownership cleanup now uses layout effects, so removal commits invalidate the task before pending validation promise callbacks can dispatch. There is no await between the central ownership check, synchronous metadata persistence and request initiation.

Added source-only public form-submit cases for password/revoke-other, each with immediate actor switch and unmount in the validation event turn. The actor switch is committed with React's public flushSync before validation promises settle. Assertions require zero writes and no reminder for either actor. Added unknown revoke-other and admin action remount/read-only cases. All new and existing runtime tests remain **UNRUN**, including whether these regressions exercise the precise rc-field-form scheduling in the installed version. No failing-before/passing-after claim is made.

This addresses removed-task entry, not a new standalone transport-generation implementation. Same-actor generation changes still rely on the existing API/session transport. MFA scope and all earlier verification limitations remain unchanged.
