# Source-receipt initial-page readiness — 2026-10-24

## Preserved WIP33 outcome

The unfiltered gate on source `1cd260ad8d27c249933f3489e0fd7615a0dcc2e052bf90fa271c9d632b58127a` ended **1214/1215 web cases passed, one failed, native exit1**. No native unhandled error was reported. Format, root vet, root Go NONRACE, typecheck and production build passed; the aggregate remained failed. Source/dependency invariants held, and QA was released at2026-10-24T17:42:35.401380Z.

The sole failure was `source-update-continuation.dom.test.tsx`, “retains accepted evidence across page navigation only in the current authenticated session.” Its original line237 first `findByRole(button, 查看更新)` rejected with a missing-button error; reported whole-case duration was1749.254ms. This lookup immediately follows mounting Workspace and creating the user-event instance. It failed before the enclosing click or any acceptance, navigation or identity assertion. It was not a20s whole-test deadline or demonstrated session-isolation defect.

The captured DOM shows an active Workspace and Sources navigation selected, but truncates in the sidebar before main content. It does not establish the precise inventory/render stage or historical cause. The file already statically preloads Sources, so cold lazy loading is not a supported attribution. Historical passes and the next case's pass do not identify the initiating delay.

## Existing category applied consistently

The test-only change imports the existing `INITIAL_PAGE_READY_TIMEOUT_MS` and supplies it as the timeout option at exactly two original first-Workspace-control lookups:

1. The retained failing case's original line237.
2. The next case's equivalent original line308, “does not restore an old-session receipt when acceptance finishes after identity changes,” which passed in WIP33.

Both precede any user action after mounting Workspace. Applying the same named5s category to both avoids selecting only a failing case. This adds no budget number or new waiting category. The file's five direct receipt-component mounts and all later navigation, receipt, identity and metadata lookups retain ordinary1s behavior. No shared mount helper, assertion, input event, target, pointer check, preload, client cleanup, native lifetime behavior or production code changes.

There are now **four reviewed initial lookup source sites** using this category across the project: the existing session-recovery file-preparation A/B resources lookup, the existing server-review-revision first Office path lookup, and these two source-receipt Workspace lookups. The A/B parameterization is one source site. The earlier `FUNCTIONAL-DOM-TEST-CONTRACT-2026-10-24.md` records the prior two-site stage and its earlier96/33-case evidence; this follow-up records the additional two sites, without rewriting that history.

DOM whole-task default20s and shared source-journey20s, ordinary RTL1s, Node5s, unrelated explicit case/wait overrides, hooks, browser45s, Go/security conditions and retry0 remain unchanged. This is application of the existing project functional-harness contract, not a product latency SLA, measured speedup or proof of exact historical cause.

## Finite isolated verification

After independent source and runner review, a fresh isolated WIP33 copy plus the one-file overlay passed:

- Typecheck: native exit0.
- One whole-file invocation: **8/8 passed**, one worker/retry0, no case filters or passive instrumentation, no pending/todo/skipped cases.
- Native test duration20.67s; no native unhandled errors reported.
- Exact inventory and all stage/final source, canonical, dependency, metadata/patch/review guards true.
- Canonical unchanged during validation; QA released **2026-10-24T17:52:22.246181Z**.

The previously failing case completed its full assertions in4968.463ms in this run. That is the whole-case duration, not a measured initial-lookup duration or a comparison under the former1s lookup contract. This finite pass does not establish a new full aggregate, product/browser performance or exact causal repair. WIP33 remains failed1214/1215; WIP32's1209/1215 plus one unhandled rejection, WIP31's1205/1213, the57/58 passive diagnostic and historical1138/1139 remain failed evidence. Prior96-case and33-case candidate passes remain separate, not rerun or reattributed here.

## Portable evidence identifiers

- Validated private source: `c9783cc14775e6c09c8db9052337f8e94cf8d269db90b24b737c23611f4d4c81`.
- One-file patch: `9ebe1ac8f64665ce870feb1fa375ba68cb8ef27838ddd207a6e4d655f30f5b3d`.
- Independent source review: `a3fa4e75014239173ed6adc5b11e1257abcddd083c1267e887a720aae690ae7c`.
- Validation receipt: `28b937f3125a26c8aa3fd7200dffa51bffa942afe6353862d03def989b3d804c`.

Native artifacts are retained in workspace bundles `current-source-gates-proposal-20261024/approved-run-wip33-20261024T1701` and `source-receipt-initial-readiness-proposal-20261024/validation-run-20261024`. This note is self-contained; external workspace bundles are evidence, not test runtime dependencies.
