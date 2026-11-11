# Legacy link-configuration creation readiness

Base: `be5d28c`.

This slice is limited to AdminPage's legacy link-configuration editor, reached
from `#legacy-routes`. Modern `#routes` renders ServerRoutesPage and its forwarding
Sheet; neither is changed here.

## Finding and correction

Before inventory was known, New initialized a route with a guessed `sing-box`
engine, but the Sheet required both route and inventory. A later read recovery
could open this queued task without another click and retain the guessed engine
instead of the recovered capability default.

New is now visibly disabled while the combined admin inventory is undefined;
new-route initialization checks the same boundary. A fresh explicit click after
recovery initializes from known capabilities and reference choices. Cached
inventory is still sufficient to create, and already-open drafts remain owned
by their existing task. Known empty capability behavior is unchanged.

Nodes, Users and Invite do not depend on this inventory to initialize their
creation fields and remain available while the inventory is unknown or failed.
No backend, modern routing, shared component or creation persistence changed.

## Verification

The HTTP-boundary real-Admin tracer failed before the fix at an unsolicited
legacy Sheet after held/failed initial reads recovered. It passed after the
new-route guard and header condition change.

Nine new tests cover initial held/failing reads, no late automatic creation,
fresh explicit creation with Xray-first capabilities and known endpoint/account
choices, cached creation and retained new-draft/focus through refresh recovery and
failure, and independent Nodes/Users/Invite creation during pending and failed
reads. Fixtures reject every HTTP write.

- Final related single-worker regression: **68/68 passed across four files** in
  20.76 seconds: legacy readiness, service readiness, admin task lifecycle and
  admin validation recovery. This includes all nine new tests and the final
  recovered endpoint/account-choice assertions.
- `npm run build` (TypeScript and Vite) and `git diff --check` passed.
- Independent source/test review found no blockers. Its capability-ordering
  observation was addressed with two known capabilities, Xray first and sing-box
  second; the final nine-test suite and build passed after this fixture change.
- This slice does not separately exercise initial offline reads, held cached
  background refetch, or an already-saved route's editor draft. Existing admin
  lifecycle coverage ran in the related suite; no expanded claim is made.

No full aggregate, native/pixel verification, publication, deployment or
real-user mutation was performed in this slice.
