# Add-user creation recovery

## Task and consequence

The Add user form previously generated a new ID for every Save attempt. If the original write committed but its response was lost, a retry could create a second user. Keeping only the ID would not fix this: the legacy POST is an upsert and can overwrite newer name, enabled-state or quota edits.

Add user now sends one task-owned ID with `If-None-Match: *`. The existing POST accepts this opt-in absence precondition atomically inside the existing user/policy transaction. An occupied ID returns `412 USER_CREATION_CONFLICT` without updating it. Requests without the header and existing-user PUT preserve their legacy behavior. Creation returns the committed user directly rather than reading the entire state after commit. Usage remains server-owned; the policy guard and authentication paths remain in place.

## Recovery behavior

- The submitted name, enabled state and quota are retained and frozen while the outcome is uncertain. Transport loss, unreadable or invalid success receipts, conflict, and unclassified failures are not treated as proof that nothing was saved.
- Only an explicit guarded pre-write validation/precondition rejection, or a session check before dispatch, permits correction of an initial rejected attempt. A definite rejection of a later retry does not erase uncertainty about an earlier request.
- **Check creation result** reads current state for the exact attempted ID without writing. Matching settings confirm the user exists. Different settings remain visible for review and are not overwritten. Usage may advance independently.
- A missing row is not proof that an earlier request cannot still commit. It enables only an explicit retry of the same ID and submitted snapshot with the atomic absence precondition. A late original request and retry therefore cannot overwrite an occupied record.
- Closing explains that it does not undo a possible creation and that a later Add user action begins a separate creation. This is not an exactly-once promise across separate tasks or reloads, nor a durable idempotency ledger after deletion.
- Readbacks and write completions are owned by the task that started them. Opening a newer editor-close or workspace route-leave decision invalidates the old readback. A late successful creation after route review stays visibly completed with an explicit Finish action, rather than reverting to uncertainty or auto-closing behind the decision. Finish closes only its current task. Old results cannot dismiss a newer decision or close/change a newly opened draft. The navigation callback is opt-in; other dirty editors retain their warning/leave semantics.

## Verification

The baseline public UI/HTTP-command test reproduced four failures: retrying after a post-commit 500, dropped response or unreadable success dispatched another ID, and closing called the potentially committed creation definitely unsaved. Two definite-rejection/reset controls passed. A separate result-check/editor-close-decision race was reproduced during implementation and corrected. Independent review then identified the separate workspace route-leave seam: four real App failures reproduced loss from delayed readbacks before/after Stay and initial/retry success behind the decision. Those four regressions and the accepted-leave control now pass.

The final focused run passed **169 tests in ten files** with one worker (38.87 seconds). TypeScript and the Vite production build passed.

Focused browser-DOM/API coverage includes:

- Post-commit 500, transport loss, invalid JSON, valid JSON without a user identity, mismatched identity, and untagged 400.
- Same-task guarded retry, an original commit after absent readback, and intervening name/enabled/quota changes.
- Matching/differing/absent/failed readback, changing usage, and a later retry's explicit rejection.
- Direct submission while frozen, local validation, explicit rejection/correction, Continue checking, truthful navigation/close decisions, fresh-task reset, late checks and old completion after page replacement.
- API precondition/auth headers, unchanged legacy saveRecord behavior, precise response-code classification and pre-/post-dispatch session fences.
- Real App route-leave decisions preserve recovery after Stay, preserve confirmed late creation until Finish, respect accepted Leave, retain other dirty owners, and notify only active opt-in callbacks once per decision through StrictMode/unmount/remount.

Nine Go store/HTTP tests are staged for atomic absence, competing independent Store handles, preserving existing records/usage/default policy, issued-budget guards, malformed/duplicate/empty conditional headers, authorization/CSRF/origin, legacy POST/PUT compatibility and storage-failure classification.

**Local Go tests and Go formatting are unrun.** `scripts/go.sh` exits 2 because no Go compiler is installed. No toolchain bootstrap was attempted. Required CI must run the backend tests and formatting before acceptance. Synthetic DOM endpoint behavior is not evidence of executed Go persistence tests.

No native-browser pixels, deployment or full aggregate are claimed for this isolated change.

Focused commands:

```sh
npm --prefix web test -- --maxWorkers=1 src/admin-user-creation-outcome.dom.test.tsx src/user-creation-api.test.ts src/admin-task-lifecycle.dom.test.tsx src/admin-endpoint-configuration.dom.test.tsx src/invite-creation-recovery.dom.test.tsx src/invite-uncertainty.dom.test.tsx src/navigation.dom.test.tsx src/navigation-focus.dom.test.tsx src/page-navigation.dom.test.tsx src/context-navigation.dom.test.tsx
npm --prefix web run build
scripts/go.sh test ./internal/store -run 'Test(CreateUser|UserCreation)' -count=1
scripts/go.sh test ./internal/httpapi -run 'TestUser(Creation|GuardedCreation)' -count=1
"$(scripts/go.sh env GOROOT)/bin/gofmt" -l internal/store/store.go internal/store/user_creation_test.go internal/httpapi/crud.go internal/httpapi/user_creation_precondition_test.go
```
