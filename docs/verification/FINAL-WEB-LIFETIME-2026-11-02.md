# Final web rerun: bounded test lifetime correction, stall unresolved

Base `7e3d37e`. No production UI/API changes, timeout increases, disabled pointer
checks, or forced overlay/body cleanup.

## Retained integrated failures

`/tmp/literal-final-web-rerun.log` is terminal: **2111/2114 passed**, 195/197 files,
1029.74 seconds. Legacy `#profiles` and collection import-return-save exceeded
their existing 20-second whole-test budgets. The following legacy `#outputs`
case failed at its open-detail click because the element inherited
`pointer-events: none`. The log does not retain the original timeout step,
abort DOM, request ledger or CPU attribution. Overlay/lifetime leakage is a
plausible explanation for the following pointer failure, not a demonstrated
sole cause. The original two stalls remain unclassified.

A separate instrumented single-worker run of these two files passed **45/45**
in 22.18 seconds (`/tmp/final-failure-probe.log`). Legacy cases completed in
289/263 ms, collection in 1268 ms; per-click snapshots are retained in
`/tmp/subscription-workspace.dom.test.jsonl` and
`/tmp/collection-source-task.dom.test.jsonl`. These successful isolated results
do not close the integrated failures.

## Minimal correction and diagnostic capture

The two legacy cases now use existing `ownedClickScenario` for both clicks and
check ownership after asynchronous reads. A canceled/finished test cannot start
a later click against the next test's page. The helper does not cancel an
already-dispatched input event. The collection case already used this ownership
helper and remains otherwise unchanged.

The subscription test file now retains and clears only the QueryClients it
creates, after component cleanup. This releases that fixture's cache timers;
it does not alter App's own session client or force any global pointer/focus
state. No claim is made that those cache timers caused the failures.

Both failed journeys record named elapsed checkpoints in memory. Only an abort
emits `DOM_SCENARIO_ABORT` with full DOM, active element, body style, hash,
checkpoint timestamps, and synthetic fixture HTTP method/path calls. The abort
listener is removed when the test finishes. No extra timers, polling, changed
responses, or input interception is added to normal execution.

A deterministic public-lifecycle regression aborts a two-action journey while
its first target is pending, mounts replacement UI, then releases the target.
The journey rejects without resolving/clicking its second target. It tests
continuation ownership, not the cause of the integrated stalls.

Focused validation: **54/54 tests passed across three files**, single worker;
application typecheck passed. Logs: `/tmp/final-lifetime-focused.log` and
`/tmp/final-lifetime-ts.log`. The coordinator must rerun the full suite serialized;
these focused results are not a replacement full pass. No browser/native
execution, remote CI, push or deployment occurred in this pass.

An initial authoring run exposed that `it.each` did not provide test context as a
second callback argument. The same two named cases now use a finite loop with
ordinary test callbacks; no case or assertion was removed.
