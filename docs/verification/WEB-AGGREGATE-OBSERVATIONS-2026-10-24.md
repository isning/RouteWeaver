# Web verification and aggregate-delay findings

Checkpoint evidence summary · 24 October 2026 · No raw profiles or private workspace paths included

## Status

The aggregate web gate is **not clean**. Instrumented observations exposed changing native deadline failures, CPU-active intervals, and two separate late motion-timer errors. Subsequent isolated passes do not clear those aggregate results. No budgets, retries, worker counts, isolation or sequencing were changed to obtain a pass.

| Observation | Native result | What it establishes |
|---|---|---|
| Initial fresh full suite, before added export tests | 1113/1120 passed; 7 failed; one uncaught error | Five initiating 10-second deadlines plus two downstream endpoint failures. Endpoint spy lifecycle leak was subsequently causally reproduced and fixed; initiating delay unresolved. |
| Four-target passive full observation | 1129/1134 passed; 5 failed | Failures migrated outside the four detailed files, which all passed. Targeted phase telemetry alone could not classify migrating failures. |
| Global native-boundary full observation | 1132/1134 passed; 2 failed; 2 additional uncaught errors | Collection and route-exit deadlines occurred in CPU-active, long-event-loop-delay intervals. Separate CSSMotion timer errors reported `HTMLElement is not defined` in two otherwise passing source fixture files. |
| CLI startup CPU profile, original collection file | 16/16 passed | Only coordinator profile delivered; no test-worker code attribution. Missing worker-profile reason unknown—not evidence that Vitest filtered profiler flags. |
| Worker-local inspector channel preflight | Typecheck passed; 1/1 probe passed | Distinct worker/coordinator identities, profile stop/write/disconnect before exit, no inspector listener, and 34 actual probe-frame samples among 42 samples. |
| Worker-local original collection profile | 14/16 passed; 2 native deadlines | Profile delivered from actual worker. Strict timing validation failed on four tiny negative deltas; graph/sample references support count-only stack observations, not repaired timing. |

Later timer-fixture integration and browser checks are independently tracked; they do not turn these historical aggregate runs into passes. No full-suite rerun followed these diagnostics.

## Native CPU-active intervals: global observation

- Collection “returns a newly saved source to the same unsaved collection…”: 12,631ms from observer beforeEach to abort; process CPU16,433ms; active event-loop utilization interval12,622ms. Abort-to-finish callback23ms. Getter instrumentation measured only640ms inclusive over192 calls—insufficient to account for most of this failed interval.
- Route exit “resolves only a matching durable rejection…”: 13,124ms beforeEach-to-abort; process CPU14,147ms; active event-loop interval13,114ms. Abort-to-finish callback903ms.
- Both used native10-second budgets. Fake-timer flags were false at captured boundaries; no overlapping observed contexts.
- Process CPU includes background threads; observer beforeEach includes later setup; finish callback is not final reporter completion. Histogram samples can arrive late: an8-second maximum delivered after collection abort is **not** eight seconds of cleanup.
- RSS/heap deltas describe observations only: no GC, memory pressure, CPU quota, environmental contention, or browser-experience cause is established. External process sampling was unavailable and was not escalated.

## Worker-local profile quality

The two profiled collection failures were:
1. Return saved source to the same unsaved collection:10,039.97ms.
2. Name collapsed source processing and retain configured disabled steps after reopen:12,891.62ms.

The first matches the global collection failure, but profiling overhead is unquantified. This is recurrence **under profiling**, not proof of identical causation.

Raw worker profile SHA256: `9eae8f04aeac19b95b2fe1ab7c6be1b11fa049dc3ffab32f714ec5cf3db2bdb3`.

43,596 samples;104,583 graph nodes. Four negative time deltas were retained unchanged:−6,−5,−2,−1µs. No clipping, timeline repair or retry occurred. Native outcomes and strict profile-validity failure remain separate. Count-only observations below do not depend on timing weights. The profile covers the beforeAll→afterAll hook window, excluding initial imports/environment and potentially other afterAll hooks; there is no per-case clock mapping.

## Actual caller paths into expensive DOM/CSS work

Of43,596 total samples,30,555 had a leaf in jsdom, dom-selector or css-tree. The following counts apply only to those hot-leaf samples. Each exact ancestor frame is counted at most once per sampled stack. Categories overlap and must not be added or interpreted as CPU durations.

| Observed ancestor/category | Unweighted hot-leaf samples |
|---|---:|
| React render/commit-named work | 17,062 |
| RC focus `syncFocus` | 11,086 |
| RC focus `getFocusNodeList` | 10,948 |
| RTL `queryAllByRole` | 8,976 |
| RC `isVisible` helper | 6,426 |
| Ant wave module anywhere in stack | 2,100 |
| Ant wave `onClick` | 1,659 |
| RTL/user-event visibility or pointer-check modules | 342 |

Representative ordered chains, with intervening unrelated frames omitted:

- **Focus:** React passive-effect commit → RC `lockEffect` → `lockFocus` → `syncFocus` → `getFocusNodeList` → `focusable` → fixture visibility/style callbacks → css-tree `map/clone` (**931 samples** sharing this retained chain). Another corresponding chain ends in dom-selector `matchAttributeSelector` (**686**).
- **Role query:** RTL `waitFor/checkCallback` → `queryAllByRole` → accessible-name filter → jsdom `cascadeProperty` → `collectCandidateStyles` → `collectCandidateStylesFrom` (**131**). Installed RTL source confirms that filter computes accessible names; this is not just selector lookup.
- **Wave:** user-event pointer release/up → dispatch → Ant wave `onClick` → RC `isVisible` → fixture visibility/style callbacks → css-tree `map/clone` (**84**).
- **Non-wave render:** React synchronous render → Ant FormItem `ItemHolder` → RC `isVisible` → fixture callbacks → css-tree clone (**155**), or dom-selector matching (**133**).

The fixture’s two anonymous transformed frames occur on23,846 and16,102 hot-leaf stacks. Their order and the installed `isVisible` source—which reads `element.offsetParent`—strongly support the fixture offsetParent getter → getComputedStyle wrapper identification. Transformed frame lines are not asserted to be original source lines without a source map. The fixture walks ancestors and computes styles; no caching/removal/semantic change has been made.

This is **whole-file** sampling, including passing cases. It does not contradict the earlier640ms failed-case getter counter: these are different runs and scopes. Focus locks are materially represented, wave work is only one contributor, and disabling focus or visibility behavior is not justified. Imports before the profiling hook were not observed; remaining render work cannot be labelled unrelated to a particular failed case.

Separate native pseudo-frame selfsamples: GC1227, idle173, program113. They are not CPU durations or evidence that GC caused a deadline. Module-inclusive counts deduplicate module names per stack; different module totals overlap.

## Smallest evidence-led next improvement proposal

Prefer a source-local test targeting improvement over another blanket profile: scope collection helper role queries to the already identified active parent dialog, retaining the same accessible role/name, user-event action, await and assertion semantics. `addSource` currently starts with a document-wide “添加来源” button query even though `openNew` already identifies the parent dialog. This is a concrete candidate for reducing unrelated accessibility-name candidates, **not a proven timeout fix**. A separately reviewed change should preserve ambiguity/missing-target failures and existing focus/visibility assertions, and be checked with the unchanged-budget original collection file once. No execution or change is authorized by this report.

Do not optimize the offsetParent visibility algorithm, remove focus trapping, change production motion, replace user events, or raise budgets based on these counts. A fixture-only wave ownership correction may address known late timer errors but should not be presented as resolving the larger focus/query paths or aggregate CPU delays.

## Integrity and delivery

All diagnostic runs used separate private trees. Canonical bytes/modes/dependency bindings were audited unchanged by diagnostics; private overlays were explicitly enumerated. Native results, observer validity and source invariance were kept independent. Original worker-profile run had no source/build-metadata changes after execution. All QA locks were released and offline analysis completed. Raw profiles remain immutable for reanalysis, not reruns.
