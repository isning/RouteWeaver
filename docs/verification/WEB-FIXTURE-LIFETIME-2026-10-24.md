# Web fixture lifetime and collection journey budget — 2026-10-24

## Retained original failures

The unfiltered WIP31 web gate on source `13ea11013f54c64234415ae0dbecf1d61de05db6ce5f4706094ca81fdcbea87c` finished **1205/1213 passed, eight failed, native exit 1**. The failures were two collection and three access-policy whole-test 10-second deadlines, one access-policy duplicate “预览影响” button, and two server-validation initial “Office path” lookups that observed loading skeletons. Both server cases failed before reaching their publication/storage assertions.

The one original-budget, three-file passive diagnostic finished **57/58 passed, one failed, native exit 1**. The first collection journey again reached its original 10-second whole-test deadline. The other failures did not reproduce. These results, and the earlier **1138/1139** failed gate, remain failed records; the later bounded candidate pass does not replace them.

## What the diagnostic established

In the first collection journey, elapsed times from the observer's beforeEach were:

| Boundary | Elapsed ms |
| --- | ---: |
| Returned parent dialog resolved | 9870.726 |
| Original focus wait started | 9870.735 |
| Native abort observed | 10074.928 |
| DOM cleanup began | 10085.986 |
| DOM cleanup ended, root disconnected | 10096.427 |
| Old test body resumed after the focus wait | 10097.382 |

The old body then ran further assertions. This establishes **post-abort, post-cleanup continuation in the same test body**. It does not establish cross-test mutation, a production focus defect, or the cause of the original access-policy duplicate surface. In the diagnostic, the access-policy cross-context events were old-client cache removals, not reproduced late mounts or duplicate buttons. Server inventory readiness completed normally, so its original loading failures remain unexplained.

Before the collection focus wait, time was distributed across mount (~2086 ms), opening the collection (~2251 ms), adding a source (~1780 ms), importing (~2037 ms), and other actions. The focus wait had run only ~204 ms when the whole-test budget expired; later preview/save correctness steps were still outstanding. Observer records had no drops and complete declared afterAll windows, but partial observation-cost metrics are not total overhead measurements or a worker-exit trace.

## Test-only containment and query ownership

The five changed test/helper files:

- expose the existing `ownedClickScenario` native-abort/finished check as synchronous `assertActive()`;
- retain a test's captured owner across asynchronous work and check it after awaits, before new global stubs/import-completion mounts and subsequent user commands;
- clear fixture-owned access-policy and server-validation QueryClients after the existing DOM cleanup (collection already owned its cleanup);
- scope the first collection journey's returned-parent focus/state/preview/save queries to that freshly resolved parent dialog;
- add two deterministic helper regressions preventing a subsequent fixture-mutation callback after injected abort/finish. These are not induced native-timeout tests.

Existing pointer/visibility checks, real user-event paths, rapid raw activation pair, assertions and global duplicate-surface/initial-readiness lookups remain. The collection preview is ordinary content inside the parent drawer, not a separate portal; its parent scope does not hide an unrelated overlay. The focus assertion still resolves the accessible target on each retry and checks exact activeElement identity.

In-flight commands, imports, waits and mock responses are not forcibly canceled. Guards prevent new continuation work after an existing await returns. Clearing owned query caches is not a claim that all issued transport callbacks stop. There is no production behavior change and no demonstrated production performance improvement.

## Exactly one explicit budget calibration

The first collection case, **“returns a newly saved source to the same unsaved collection, preserving order and both processing stages”**, now declares `COLLECTION_IMPORT_RETURN_SAVE_JOURNEY_TIMEOUT_MS = 20_000` for its whole import → returned unsaved parent → preview → save journey. This is an explicitly authorized bounded correctness-journey contract, **not a product latency SLA, measured percentile, speedup, or retroactive pass**. The original 10-second run expired after about 9.87 seconds of completed UI work before the remaining correctness checks.

Unchanged: shared `SOURCE_IMPORT_JOURNEY_TIMEOUT_MS = 10_000`; global DOM 10 seconds/Node 5 seconds; second collection and all access/server case budgets; inner find/waitFor and hook budgets; retries; assertion semantics; pointer checks. No blanket timeout increase or further budget change is implied.

## Finite isolated verification

After independent source and runner review, exactly the five test/helper overlays were applied to an isolated WIP31 copy, without passive instrumentation. Typecheck passed (native exit 0), then one four-whole-file Vitest invocation with **one worker, retry 0, no case filters** passed:

| File | Passed / total |
| --- | ---: |
| owned-click-scenario.dom.test.tsx | 8 / 8 |
| collection-source-task.dom.test.tsx | 16 / 16 |
| access-policy.dom.test.tsx | 35 / 35 |
| server-validation.dom.test.tsx | 7 / 7 |
| **Total** | **66 / 66** |

There were no pending/todo/skipped cases. The first collection case took 4754.476 ms in that single run; this is not a speedup estimate. Stage/final source, canonical, dependency and reviewed-overlay invariants were true. Canonical remained unchanged during validation; QA was released at **2026-10-24T15:11:51.870557Z**.

Portable evidence identifiers:

- Validated private source SHA-256: `7723db1451764dfbff74608180f1e8a71dacd0debba1fdc3c93d3a05efa03d57`.
- Five-file candidate patch SHA-256: `5bdf98af7b2592e13b77ac4006416d188241ca0f81e94d41c55fd6d0a1094187`.
- Source review SHA-256: `0dfc4d9a2daa3818b4e688601ea1005bd6380f5eb45b217a4239bac4467ddb5f`.
- Validation receipt SHA-256: `c9dc77d552f0ff8ee3bfe54c6308f443ee95c3136d5b89f9dd2ec2987786beb0`.

Workspace evidence bundles are `current-source-gates-proposal-20261024/approved-run-wip31-20261024T1337`, `web-three-file-passive-diagnostic-20261024/diagnostic-run-20261024`, and `web-fixture-lifetime-proposal-20261024/validation-run-20261024`. They preserve native logs/results rather than converting earlier failures into passes. This note is self-contained; those external workspace bundles are not required for the repository to execute its tests.

This bounded verification is **not** a fresh unfiltered web or full aggregate pass, native/race/browser/deployment verification, or proof of the original access/server failure causes. A later combined-source aggregate requires a separately recorded run.
