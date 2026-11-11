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
