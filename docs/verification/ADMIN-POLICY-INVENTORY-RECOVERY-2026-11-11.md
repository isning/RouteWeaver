# Service offering and user-group inventory recovery

Base: `d79b433`. Bounded continuation during the reported GitHub Actions outage.

## Finding and correction

Services and UserGroups passed cached refresh errors to QueryState, which
unmounted the table and reset pagination after recovery. Cached empty lists also
remained presented as authoritative during pending/offline reconciliation.

Retain cached tables and search on refresh failure, show the failed/pending/offline
read separately, and present empty only after a successful idle read. First-read
failure or offline loading remains unknown. Refresh actions live in the existing
services search toolbar and group section actions. They remain mounted and
focusable through pending reads, prevent repeated requests, and retain keyboard
focus on success/failure without an imperative focus handoff. Newer search/editor
focus is therefore not taken by recovery.

Only Edit is exposed as a row action on these lists. Both editor implementations
fetch their own guarded edit-context, use the returned record rather than the
cached row as the form baseline, and check target existence. This slice does not
copy Users' broader row-action gate. Existing editors remain outside QueryState;
refresh does not reset their drafts. No direct row mutation is exposed.

Source authority checked: ServicePolicyEditor.tsx and GroupPolicyEditor.tsx;
internal/httpapi/policy_edit_test.go and group_policy_edit_test.go cover stale
opening rejection, preview baseline guards and revision-protected apply. Those
backend tests were inspected, not rerun for this UI-only slice. Reference-choice
freshness remains governed by existing editor behavior, not by this fix.

## Verification

- Service tracer failed on the original implementation at the missing searched
  inventory after a confirmed refresh error; passed after the scoped fix.
- Group tracer failed on the original implementation at the missing page-two
  rows after a confirmed refresh error; passed after the scoped fix.
- Tests use real AdminPage/UserGroups, query client and editors; only HTTP is
  intercepted. Fixture mutations are read failures; every HTTP write is rejected.
- Expanded checks cover searched/page-two continuity, initial unknown/empty,
  cached empty during failed/pending/offline reads, initial offline loading,
  same-turn/keyboard repeated refresh, repeated failure then recovery, current
  refresh focus, newer search focus, independently authoritative row editor
  reads during reconciliation, and retained newer draft/focus through later
  recovery and failure.

- Related single-worker regression: **147/147 passed across six files** in
  30.99 seconds (new recovery, Users recovery, service/group policy edit intent
  and service/group submit recovery).
- Build initially caught two unsupported test-only ByRole `exact` options;
  removing those redundant options restored typecheck/build. The final focused
  suite and production build were rerun after review's copy correction.
- Final focused suite: **13/13 passed**. `npm run build` (TypeScript and Vite)
  and `git diff --check` passed.
- Independent source/test review found no blocking issue. Its cached-empty
  notice wording improvement was applied and accepted on rereview.

No full aggregate or native/pixel acceptance is claimed here. Narrow-screen
layout and focused-control viewport visibility need native follow-up when the
supported CI/browser route is available.
No browser bypass, publication, deployment or real-user mutation was performed.

## Separate deferred finding

Services' header New action can set `serviceEditor` before the combined admin
inventory exists, while editor rendering requires `serviceEditor && data`.
An initial read failure can therefore silently retain creation intent and open
it on later recovery. This source-only finding is not changed in this slice.
