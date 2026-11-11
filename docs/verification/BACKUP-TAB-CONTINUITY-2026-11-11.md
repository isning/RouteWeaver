# Backup recovery across local settings tabs

## Finding and change

Leaving the Backup tab unmounted its task. Returning silently lost the unresolved restore target and mandatory operator-check acknowledgement, including when an uncertain response arrived while Basic Settings was active. A fresh inspection could then start another restore without that acknowledgement.

The visited Backup tab now stays mounted but hidden while another local settings tab is active, following the existing retained Basic Settings pattern. It is still mounted lazily, and actual settings-route departure still retires its task. No secrets are persisted, restore APIs or server policy changed, or live backup operations performed.

## Verification

- Both new public AdminPage regressions failed before implementation because the uncertain-result warning was absent on return. Both pass after the change.
- Cases cover uncertainty before departure and while hidden; preserved target, archive/password, operator-check fence, newer Basic Settings input focus, hidden noninteractive controls, and exactly one new restore only after acknowledgement, fresh preview, and new typed confirmation. All HTTP calls use synthetic fixtures.
- All 103 backup and settings-tab tests across nine files pass, including existing export retirement and restore-outcome tests.
- Production TypeScript/Vite build passes.
- The complete 4,030-test pass at `f497893` immediately predates this change and is not a full-suite pass for this patch.

## Remaining verification

Independent source review found no blocking correctness issue: lazy task ownership, hidden controls, focus, explicit retry and actual route-departure cleanup remain intact. Native browser execution and rendered pixel acceptance are not yet performed. Publication remains blocked pending authorization; no denied operation was retried, deployed, or routed around.

## Additional settings check and controlled baseline

An additional five-file settings run produced 29 passes and one failure: the first `settings-save-receipt` case could not find the initial edit-name button within its existing wait. Standalone full-file runs likewise produced 11 passes and one failure, while the exact first case alone passed. Diagnostic DOM snapshots showed the App module-loading or initial settings-read skeleton, before the changed tab component mounted. An isolated checkout of unchanged predecessor `f497893` reproduced the same 11-pass/one-failure outcome and module-loading skeleton. This identifies pre-existing initial-loading timing sensitivity, not a demonstrated tab-retention regression. Failed runs are retained as failures; no timeout, source-loading behavior or assertion was weakened. The prior complete 4,030-test pass remains valid only for its recorded run.

## Native fixture preparation

The real-App loopback fixture covers keyboard local-tab changes while a synthetic restore is held, completion behind the Basic Settings tab without taking focus, returned recovery target and acknowledgement, blocked repeat, and fresh preview/confirmation. It runs at 390 and 1440 pixels, captures original current viewports with password masking, and attaches sanitized geometry and a failure-resilient request ledger. Exact synthetic multipart backup requests are intercepted; none are forwarded. Unexpected/off-origin traffic is blocked. This does not test backend restoration.

Strict native TypeScript passes. The supplemental lane discovers 42 cases across 15 files; all five workflow contracts pass, with required full discovery, sandbox provenance, timeouts, retries and workers unchanged. These checks do not constitute browser execution or rendered acceptance.

Independent native-fixture source review found no concrete blocker in current selectors, roving-tab keyboard use, staged synthetic transport, masked original captures or safe ledger preservation. This remains source acceptance only: asset compatibility, keyboard traversal and pixels require actual native execution. The fixture covers response completion while hidden; DOM regressions additionally cover completion before tab departure.
