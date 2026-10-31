# Collection-source test ownership containment — 2026-10-23

This is a narrow test-only change, not a product latency, deployment, or full-suite readiness claim.

## Observed ownership

A whole-file diagnostic produced14passes and2native10-second timeouts. During the double-click acceptance case, addSource entered its awaited real userEvent.click at timestamp1792792133468ms. Native timeout abort occurred at1792792140699; fixture cleanup ran at0700–0709, the task finished at0749, and the next held-Enter case began at0751 (same timestamp prefix). The old click resumed at1474 and immediately started the helper's following dialog query. The next case did not enter addSource until2306, establishing ownership of that earlier continuation. This does not establish that the old query mutated the next test, or explain the original React window exception.

The earlier selected-two diagnostic passed2cases with14skipped; the whole-file diagnostic passed14/16 and timed out in candidate deferral and double-click acceptance. Neither reproduced the original window exception. These outcomes are preserved as bounded diagnostics, not superseded by the candidate's focused pass.

## Containment

For the two gesture cases only, addSource uses the existing ownedClickScenario to check native TestContext.signal after the awaited click and before the subsequent dialog query. Other helper callers retain their original path. Already-dispatched input is not canceled, and not all lifetime paths in this fixture are protected. There is no error catch/suppression, arbitrary cancellation, timer drain or replacement input event.

The cases use it.for, whose second callback argument is TestContext; it.each does not supply it. Their existing SOURCE_IMPORT_JOURNEY_TIMEOUT_MS remains10,000ms, now expressed using the supported options-before-callback form. Native hook budgets, individual findBy/waitFor budgets, action order and assertions are unchanged. APIs: https://vitest.dev/api/test.html#test-for and https://vitest.dev/guide/test-context.html#signal.

## Verification

One isolated invocation at worker1/retry0 ran the existing abort-during-click helper regression and both gesture cases:3passed/19skipped,20.61seconds, native exit0. Skipped cases are not passes. Typecheck tsc-b exited0; no unhandled errors appeared in the focused log.

The helper regression uses an injected AbortController and proves rejection without subsequent continuation. It is not an induced native timeout run. Native failure preservation is source reasoning: throwIfAborted propagates the original signal reason without a catch, while Vitest independently rejects the timed-out test and retains handling for the body Promise. No additional induced-timeout test was run.

Original fixture SHA256:5620361428c143ed21c0775d37fe086a75cff5c73a5ff0d8aaa1db5423b318db.
Integrated fixture SHA256:e96d004e871d550305b4f5029bbcfa3996b335cb112ef102ac2c3e1ce3513eed.

Latest recorded broad gate remains924/946 with8unhandled errors. This containment does not fix the10-second timeouts, establish a window-error fix, or make that gate green. No deploy or live application performed. Raw diagnostic logs remain outside the portable source package.
