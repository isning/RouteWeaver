# Announcement list refresh recovery

## Scope

Previously loaded announcement rows disappeared when a subsequent list GET failed. The announcement table passed every query error into the initial-load error boundary, even when cached data existed.

The table now retains the last known titles, audiences and schedules with a current refresh status. Cached empty results remain distinguishable from an unknown initial read. A stable Refresh announcements action remains focusable while fetching or paused, and repeated activation does not restart the request. Initial no-cache loading/error/retry uses the existing QueryState path.

Starting Edit requires a successful, idle, unpaused list read; the selected ID is resolved against the current list before form initialization. Create remains independent of the list. No GET completion automatically opens, rebases or closes an editor. An already-open editor retains its independently typed draft and Save availability after a failed background list read.

## Evidence

Public seam: NotificationsAdminPage, QueryClient and UIProviders with controlled HTTP fetch responses; no component mocks, external writes or actual delivery.

- First tracer failed on the missing cached announcement row after populated success → tab away/back → held GET → 503.
- The same tracer passed after the list recovery change.
- Six dedicated regressions passed: cached title/schedule retention; keyboard retry focus, deduplication and fresh explicit Edit; initial unknown versus cached empty; paused refresh/reconnect; newer Create draft continuity; existing Edit draft continuity.
- Focused suite: 35 tests passed across announcement-list-recovery, account-notification-read-states, announcement-authoring, announcement-modal-focus, announcement-submit-focus and settings-tab-continuity, one worker.
- Initial build found a TypeScript closure-narrowing issue and unsupported test query option. Both were corrected. Final dedicated rerun: 6/6 passed. Final `npm run build` passed (TypeScript and Vite).
- One preliminary command used the repository root rather than the web working directory and found no tests; this was corrected and is not counted as a test pass.

## Limits

No native browser or screenshot acceptance was performed for this change. jsdom focus assertions do not establish rendered viewport behavior. No full-suite run, server mutation, real announcement scheduling, notification delivery, deployment or publication was performed by this worker.

Announcement API writes have no revision check: POST/PUT share an unconditional replacement handler. A successful idle read prevents deliberately starting from a known-failed/pending list but does not provide optimistic concurrency or protect against another administrator changing the record after it is opened. This patch does not add such a backend contract or silently overwrite an existing draft with fetched values.

Independent bounded source review accepted the change without a blocker. The starting-Edit gate applies to the current rendered list and its callback. This is a direct row button, not a delayed menu action; no guarantee is claimed for an artificially retained old callback invoked after a cache update but before React rerenders.

## Native sampler prepared (not executed locally)

`announcement-list-recovery.ui.spec.ts` adds four discovered Chromium cases: retry and newer-Create ownership at 390×560 and 1440×900. Native keyboard traversal, Enter/Space activation and typed input are used. The retry journey observes initial unknown, populated cached error, held retry focus/deduplication, recovered data and explicitly opened Edit. The newer-Create journey holds a background refresh while typing a new draft, then checks that its failed read cannot replace that draft or focus. Neither journey submits a form.

The context request boundary allows loopback static resources plus exact query-free GETs for `/api/auth/me`, `/api/state` and `/api/admin/announcements`. All other API calls and all mutations are rejected. Announcement 503 handling accounts for the production query client's one automatic retry. Fixtures are synthetic and do not establish backend acceptance or announcement delivery.

Named screenshots preserve original viewport position before focus geometry checks. Pending captures do not globally settle busy animations. Finally captures occur before held requests are released. Exact PNG/JSON paths, including a synthetic request ledger, were added to the supplemental recovery workflow and its positive/negative artifact contract. Shared sandbox/server defaults remain unchanged; required full discovery is not narrowed.

Prepared checks: TypeScript passed; Playwright list-only discovery found four cases; the five recovery-workflow contracts passed. No local browser, screenshot inspection or full-suite run was performed. Native execution and independent screenshot review are still required before claiming rendered acceptance.

Independent native-sampler source review accepted the bounded preparation without blockers. Coverage limits remain explicit: schedule/header attachment assertions do not establish their viewport visibility; the 80-Tab traversal bound is a reachability guard, not an efficiency claim. This sampler does not establish native offline behavior, known-empty recovery or already-open Edit draft retention; those have component evidence only. Native execution, artifact delivery and screenshot acceptance remain unverified.

## Coordinator aggregate check

The clean serialized local aggregate completed on 2026-11-11 with 4,146/4,146 tests across 339 files (exit 0; 1,086.58 seconds), including the production and DOM changes from `b11c2cd`. Build had already passed. Exact remote `aceb55ea9e9146b9561030e483ef2d8fbda6fd77` is verified on the review branch, but its native and full workflow runs remain queued as of 20:54 UTC. The preceding `e08a779` reports successful test steps but unresolved diagnostic-upload failures and inconsistent nonterminal status. Neither is claimed as a completed remote pass; no rerun, artifact deletion or gate weakening was performed.
