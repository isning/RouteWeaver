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
