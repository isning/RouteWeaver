# Nodes and legacy-route inventory recovery

## Verified defects and remedy

A read-only audit of the real AdminPage reproduced six failing requirements on Nodes and legacy routes: a cached-read failure unmounted search/table and reset pagination on recovery; repeated keyboard Retry initiated duplicate reads; pending/offline rows remained actionable without current inventory authority. Twenty observations/controls and thirty-one existing controls passed. The aggregate query reads multiple endpoints, so a failed aggregate is not attributed to a particular backend endpoint without evidence.

The remedy retains known cached search/table context with task-specific error and pending/offline status. A persistent refresh action remains focusable while busy and does not restart an in-flight read. First-error retry stays mounted until recovery, then hands off only its own visit-scoped focus. Current read authority and target existence are checked when opening existing-row Edit, Validate or Delete, including callbacks retained by a menu. An unsubmitted stale deletion confirmation fails truthfully rather than resolving as success. Existing drafts and independent Node creation remain available; legacy creation keeps its established known-inventory requirement.

Successful deletion removes only its captured kind/ID from the client cache after cancelling obsolete read ownership, then starts reconciliation without awaiting that read. Late pre-delete responses cannot reinsert the confirmed-deleted row through the cancelled query. This is transient client presentation, not server-side concurrency protection or a persistent tombstone. Uncertain/failed DELETE does not project success. Newer page/task focus remains independent of shared-cache correctness.

## Independent review corrections

The initial candidate cleared an earlier read failure when a successful DELETE projected its cache result. Four held/offline regressions reproduced the problem before correction. Read-error presentation now survives until a successful idle, non-invalidated inventory read. A further public-component lifecycle test caught stale failure presentation after recovery on another AdminPage view; this also passed after correction. Normal App navigation remounts the page boundary, unlike that explicitly tested same-instance prop lifecycle.

Final frozen patch SHA256: `797a5948fa32247ce326dfed3aa945c03fc719f79834abd3d43d59ff2bbf93a7`, based on `31f2c5dc2359735feb8683c233cdcc87b521b0cf`. Independent Standards and Spec re-review found no remaining actionable findings. Review was source/log inspection, not independent test execution.

## Integrated verification

Applied strictly to docs-only successor `0d6674c`. All four integrated source/test files matched the independently reviewed manifest. Coordinator verification on 2026-11-12:

- 251 tests across 14 files passed, one worker, 88.60 seconds.
- Typecheck and production build passed.
- Patch whitespace checks passed.

Coverage includes cached/initial/empty/pending/offline recovery, single-owner retry, stale row tasks and confirmations, existing draft continuity, creation readiness, route validation, page-two/last-row deletion, failed reread, late obsolete read, navigation, and prior confirmation/keyboard controls. Existing removal tests retain newer-owner intent using independent creation while stale row edits are now fenced, and account for immediate confirmed-row removal.

Full aggregate for this candidate is pending. The preceding 4619-test/358-file full frontend pass covered source `31f2c5d`, not this patch. Native browser, rendered copy/pixel, backend concurrency, and deployment acceptance are not claimed. Publication remains blocked; no denied write was retried.
