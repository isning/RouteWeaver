# Initial service creation readiness

Base: `52dcb02`. Resolves the separate initial-New finding recorded in
ADMIN-POLICY-INVENTORY-RECOVERY-2026-11-11.md.

## Defect and decision

The Services header accepted New while the combined admin inventory was unknown,
but the editor only rendered when that inventory existed. Initial pending or
failed reads therefore retained a silent creation request. An unrelated retry
could later open the Sheet without another New click.

Creation obtains its own authoritative absent-target edit-context, but the form
still depends on the parent inventory's published-route choices and policy
labels. Unknown references must not be fabricated as empty choices. Disable the
visible Services New button only while admin data is undefined, and guard the
handler using the same condition. Existing read loading/failure/offline recovery
remains the next action. Recovery enables New; it does not queue or start creation.

Cached inventory remains enough to start a new independently guarded editor,
including during a refresh failure. Existing creation drafts and other pages'
creation paths are unchanged. No server contract or shared component changed.

## Evidence

The real-Admin HTTP-boundary tracer failed before the fix: after clicks during
initial held/failing reads, retry opened an unsolicited dialog. The same tracer
passed after the two-line correction.

Four focused tests cover initial failure/retry, held-success and offline reads,
no unsolicited dialog/edit-context request after recovery, fresh explicit New,
known published-route choice availability, creation from cached failed inventory,
and the same unsaved creation draft/focus through subsequent recovery and failure.
HTTP writes are rejected by the fixture; no real-user data is touched.

- Related single-worker regression: **32/32 passed across four files** in
  13.92 seconds: new creation readiness, admin policy inventory recovery,
  creation entry and Users inventory recovery.
- `npm run build` (TypeScript and Vite) and `git diff --check` passed.
- Independent source/test review reported no blocking findings; its scope did
  not include executing tests or inspecting browser pixels.

No full aggregate or native/pixel evidence is claimed. No publication, deployment or browser bypass was performed.
