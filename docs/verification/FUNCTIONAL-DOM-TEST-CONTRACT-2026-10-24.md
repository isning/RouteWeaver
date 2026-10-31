# Functional jsdom test contract — 2026-10-24

## Declared project contract

The project chooses these bounded budgets for functional jsdom tests:

- **20,000 ms whole-test default**, set only when the existing jsdom environment marker is present.
- **5,000 ms initial-page-ready lookup**, used only at two confirmed original sites: the first resources import-action lookup in the session file-preparation A/B cases, and the first Office path lookup in the first server-revision case. This category covers both full Workspace bootstrap and directly mounted inventory-backed page bootstrap. No preliminary wait or replacement target is added.
- **1,000 ms ordinary Testing Library async default remains unchanged.** There is no global asyncUtilTimeout increase.

Node tests retain 5 seconds. Explicit per-wait expressions, hook budgets, browser45s configuration, Go/security conditions and retry0 remain unchanged. The shared source-import journey alias is aligned to the same20s functional-task constant; the first collection case's existing separate explicit20s and unrelated explicit case overrides remain unchanged. The pure constants module imports nothing and introduces no framework or Testing Library setup side effects.

These are project-selected **functional harness contracts**, not a product/browser latency SLA, measured percentile, speedup or library-prescribed numbers. They separate whole multi-step task execution from initial page readiness while retaining short ordinary post-action assertions. Actual user-facing latency requires a separate defined browser measurement and acceptance criterion.

## Why the contract was reviewed

The WIP32 unfiltered web gate on source `8f5e8a555f34d9e2846fea592ab2e11aab8e81ffe1e316fa421248f120ec8fd8` ended **1209/1215 passed, six failed, native exit 1**, with **one additional unhandled rejection**. Its other five recorded stages—format, root vet, root Go NONRACE, typecheck and build—passed; the aggregate remained failed.

Four web failures reported the native10000ms whole-test deadline: existing incompatible listener protocol, typed listener refresh, subscription uncertain-retry busy state, and dirty-source Back/Forward navigation. Their stacks locate test declarations, not pending-action phases. Accumulated work, a particular stall, environmental causality and precise production causes were not established.

The other two failures occurred before their business/security assertions:

- `session-recovery.dom.test.tsx`, original L1090: first resources import button lookup. The snapshot shows an active Workspace shell but truncates in the sidebar before main content; pending lazy import is not proven.
- `server-review-revision.dom.test.tsx`, original L235: first Office path lookup. The snapshot shows the transfer-path header and an aria-busy inventory-loading skeleton, before revision/consent logic.

The separate unhandled rejection, `MutationObserver is not a constructor`, points to subscription-creation-readiness original L464, a new lookup after the initial publish await. Exact native abort/cleanup/teardown ordering was not timestamped. Budget calibration alone is not lifetime containment.

This class-level decision replaces further case-by-case budget increases. It deliberately rejects a global5s asynchronous wait policy, which would also broaden ordinary missing/duplicate target detection. It does not establish that every future task will finish within the chosen caps.

## Shared source-journey category alignment

Before final integration, review found that source-import-journey.ts already described complete multi-surface correctness journeys and explicitly excluded product latency. Its legacy10s value would become a shorter override under the new20s default, without a source-backed stricter timing contract. The alias now imports the same FUNCTIONAL_DOM_TEST_TIMEOUT_MS constant; only that helper and its comment change. This is class-level category coherence, not another failed-case-specific increase.

The untouched consumers have20 alias declaration sites covering25 cases: collection12/15, existing-source5/7 and profile-source3/3. Their whole files contain16+13+4=33 cases. No consumer assertions, input actions, waits, hooks, fake timers or lifetime guards change. The first collection's separately documented20s remains. Previous eight-overlay/96-case evidence is retained as that earlier source configuration, not relabeled as having exercised this later alias change.

## Separate test-owned continuation containment

Only the four timed-out flow declarations gain native-owner checkpoints using the existing ownedClickScenario/assertActive helper. Three plain tests capture their native context directly. The shared subscription receipt/retry callback captures the owner initialized by beforeEach synchronously at entry; it does not mistake an it.each data argument for native context or reacquire a newer owner after an await.

The tests check their captured owner after awaited operations before new lookups/commands. Awaited lookup→input expressions retain the same original real user-event call after the checkpoint. Optional owner checks cover the existing openReviewed and updateListener helpers for those callers only. Assertions, events, user instances, pointer/visibility checks, security predicates and existing cleanup remain; no production UI or broad QueryClient cleanup change is included.

The subscription held-response finally still releases its fixture response unconditionally. Its resolver is assigned synchronously during Promise construction before entering try, even if the hold callback never starts. Only after release does a guard prevent an expired owner from starting the final wait. Already-running input, polling, imports and responses are not forcibly canceled. This is containment of new continuation work, not a claim that the historical unhandled error's precise cause was traced.

## Finite isolated verification — earlier eight-overlay candidate

After independent source and runner review, the eight test/setup/constants overlays were applied to a fresh isolated WIP32 copy. Typecheck passed with native exit0. One six-whole-file Vitest invocation, **worker1/retry0, no case filter or passive instrumentation**, passed **96/96**, with no pending/todo/skipped cases and no native unhandled errors reported:

| File | Passed / total |
| --- | ---: |
| infrastructure-creation.dom.test.tsx | 22 / 22 |
| listener-refresh.dom.test.tsx | 7 / 7 |
| server-review-revision.dom.test.tsx | 6 / 6 |
| session-recovery.dom.test.tsx | 34 / 34 |
| subscription-creation-readiness.dom.test.tsx | 9 / 9 |
| workspace-return.dom.test.tsx | 18 / 18 |

All stage/final source, canonical, dependency, patch/review and actual-inventory guards were true. Canonical was unchanged during this validation. QA was released at **2026-10-24T16:36:30.758779Z**.

The unchanged workspace-return case “keeps the client-link page through detail Back and a materials detour” passed with reported duration **16821.706 ms** under the declared20s default. This is not an all-cases-under-the-old10s result. The four previously timed-out cases were below10s in this one run; that does not establish a speedup, causal fix or old-budget counterfactual. Absence of an unhandled error in one run is not proof of universal future containment.

### Later source-journey alignment verification

After separate source and runner review, the nine-overlay isolated candidate passed typecheck (native0), then one invocation of **33/33** whole-file cases: collection-source-task16/16, existing-source-selection13/13 and profile-source-task4/4. One worker/retry0, no case filters or passive instrumentation; no pending/todo/skipped cases or native unhandled errors were reported. Native test duration was133.48s. All stage/final source, canonical, dependency, patch/review and exact-inventory guards were true. QA was released at **2026-10-24T16:55:19.661095Z**. Canonical was unchanged during validation.

This later run verifies the shared alias's three whole consumer files on the nine-overlay candidate. It does not rerun or reattribute the earlier96-case result, establish an old10s counterfactual, or prove a performance/historical-cause claim.

This focused result does not establish a fresh unfiltered web/full aggregate, browser, native/race or deployment pass. A combined-source aggregate requires a separate recorded run. WIP32's six failures plus one unhandled rejection, WIP31 **1205/1213**, the original-budget passive diagnostic **57/58**, and historical **1138/1139** remain failed evidence.

## Evidence and primary documentation

Earlier eight-overlay /96-case identifiers (before the later alias alignment):

- Earlier validated private source SHA-256: `1e220e5207d30d4b1c70a9c63495881b1718dabb4209fef0aed3ab4a801c1f4e`.
- Eight-file candidate patch: `87ad02429c31b2c8dd60dd3ca5154c6c6c8237f1f6ebd37daf15667135b9873b`.
- Independent source review: `f953670fe8fd6de296800b71f7bdec57a0c6c53168dd520a12a3280f3ef36f20`.
- Finite validation receipt: `340c2fd712e9348aa7288fe74253f8e4751422bcf35b2e07681a00300f69c4dc`.

Later nine-overlay /33-case identifiers:

- Validated private source SHA-256: `751230e7f93ce9519fc9fe37589c5c297fc7dc72b1b4b9e68519e6258bc1b695`.
- Nine-file candidate patch: `7fffd244607273f1461c7d8f22d4809a5d3af2bb33883a6ba870e03d2314ba57`.
- Independent source review: `c4ff486bb77c2604c3469d4eff3d3860d1f8d1647780abe0ed3dcd5cd9c00c67`.
- Finite validation receipt: `e9542391c05eee4807ee25b211b36395355b1b8464cb0fcb64e2339bc9cdcd00`.

Workspace bundles preserve native logs/results: `current-source-gates-proposal-20261024/approved-run-wip32-20261024T1527` , `functional-dom-budget-proposal-20261024/validation-run-20261024` and `source-journey-contract-alignment-20261024/validation-run-20261024`. This note is self-contained; those external workspace artifacts are not dependencies of repository tests.

[Vitest testTimeout](https://vitest.dev/config/testtimeout), [test API](https://vitest.dev/api/test) and [hookTimeout](https://vitest.dev/config/hooktimeout) document separate test and hook scopes and explicit overrides. [Testing Library async methods](https://testing-library.com/docs/dom-testing-library/api-async/) describe findBy as getBy plus waitFor, whose default timeout is1000ms; [configuration](https://testing-library.com/docs/dom-testing-library/api-configuration/) describes asyncUtilTimeout. These mechanics justify distinct scopes, not the project's chosen numeric values. [Vitest environments](https://vitest.dev/guide/environment.html) distinguish Node-hosted jsdom emulation from native Browser Mode. [Testing Library ByRole](https://testing-library.com/docs/queries/byrole/#performance) notes the cost of accessible queries and the confidence tradeoffs of bypasses; this change preserves visibility and pointer checks rather than using those bypasses.
