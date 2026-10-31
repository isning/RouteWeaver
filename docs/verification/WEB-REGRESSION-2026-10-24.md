# Full web regression — 2026-10-24

**Result: NON-GREEN.** Terminal 02:01:07 UTC. One complete, unfiltered web behavior run reported **1113 passed / 7 failed / 1120 tests**, **99 passed / 4 failed / 103 files**, plus **1 uncaught error**. Typecheck and production build independently exited 0; the test stage and wrapper exited 1. The previous full gate remains preserved, not replaced by selected passes or this smaller failure count.

## Execution and scope

```sh
npm --prefix web run typecheck
npm --prefix web run test -- --maxWorkers=1 --retry=0
npm --prefix web run build
```

One worker, zero retries, unchanged inclusion/configuration and default reporter. Existing jsdom test bodies retain 10,000 ms; Node defaults retain 5,000 ms; explicit per-test budgets and hook/RTL limits remain unchanged. No filter, shard, isolation change, automatic retry or outer kill deadline. Build ran as an independent stage after the failing suite. Vitest reported 1432.24 seconds. Node 24.19.0, npm 11.9.0, Vitest 5.0.5; existing offline dependencies were reused without installation. The build retains its >500 kB chunk warning; success does not establish browser performance.

This is **not official quick/full verification** and contains no backend, E2E/browser, native runtime or deployment acceptance. The earlier official quick failure at the Git-tracked operator-state guard remains unverified because recovered source lacks Git metadata; no index was synthesized. Other backend evidence is separate and is not upgraded by this web run.

## Current failures (exact names)

- `src/infrastructure-creation.dom.test.tsx > infrastructure creation user tasks > suspends host detail while editing and restores it after cancel` — Native test-body timeout, 10,000 ms.
- `src/route-graph.dom.test.tsx > retains measured geometry and dragging across path updates and view switches, without storing geometry in routing intent` — Native test-body timeout, 10,000 ms.
- `src/server-endpoint.dom.test.tsx > blocks saving an unfinished server change and saves the explicitly selected endpoint identity` — Native test-body timeout, 10,000 ms.
- `src/server-endpoint.dom.test.tsx > limits public-path selection to its deployment and blocks an unfinished server change after preview` — TestingLibrary failure: cannot find button named 编辑.
- `src/server-endpoint.dom.test.tsx > uses retained labels only in opted-in saved route editors while choices and other callers remain current` — RangeError: maximum call stack size exceeded.
- `src/session-departure-focus.dom.test.tsx > continues the exact departed button after same-session BODY return` — Native test-body timeout, 10,000 ms.
- `src/session-departure-focus.dom.test.tsx > does not restore a departed owner after changed account` — Native test-body timeout, 10,000 ms.

Five failures are native test deadlines; zero hook deadlines are reported. The missing-button and recursive RangeError occur in the server-endpoint file. The separate **uncaught RangeError** also points to `server-endpoint.dom.test.tsx:289`, where the `getComputedStyle` mock calls `originalStyle(element)`. Vitest associates its most recent test with the public-path-selection case. This location is evidence, not yet a proven cleanup/root-cause diagnosis. The uncaught-error warning explicitly means apparent passes may be affected; the reported pass total is not an error-free reliability claim.

## Exact comparison with prior 17 failures

The prior complete run reported 1060/1077 passing, 17 failing (10 native 10-second deadlines and 7 assertion/lookup failures), 14/101 failed files, and no unhandled/uncaught marker in its terminal log. **None of the seven current exact failed names overlaps the prior seventeen.** Same-file failures are not the same test: the infrastructure case is now edit/cancel rather than endpoint-core selection; the current missing 编辑 button is in server-endpoint rather than public-onboarding.

For each prior failed name below, its failure is **not reproduced in this full run's failure ledger**. Only the five explicitly marked cases have a documented intervening test-contract migration. The other twelve must not be called fixed: ten old deadlines and two unchanged readiness failures remain non-reproductions, not established causal repairs. Earlier selected diagnostics are retained but do not establish fixes.

| Prior exact failed name | Prior outcome | Intervening evidence / interpretation |
|---|---|---|
| `src/existing-source-selection.dom.test.tsx > names an unavailable selected source and repairs it without saving or replacing the rich collection draft` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/existing-source-selection.dom.test.tsx > repairs a source inside a Profile's collection without changing its input mode or rich intent` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/explicit-rule-destination.dom.test.tsx > retains explicitly selected Android review while an incomplete repair rule is edited and saved` | Assertion / lookup failure | Test-only request ledger migration: resumed explicit Android review adds a preview; manual retry and target/body assertions retained. |
| `src/infrastructure-creation.dom.test.tsx > infrastructure creation user tasks > selects an endpoint core only from its chosen server and clears it when the server changes` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/profile-content-hierarchy.dom.test.tsx > keeps dirty input and error on failed save while pending actions stay busy` | Assertion / lookup failure | Unchanged readiness assertion; earlier focused non-reproduction is not a fix. |
| `src/profile-preview-layout.dom.test.tsx > keeps a newly saved draft open and updates the same identity on subsequent saves` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/public-onboarding.dom.test.tsx > explains unsupported public entry before assignment while preserving legacy route editing` | Assertion / lookup failure | Unchanged readiness assertion; earlier focused non-reproduction is not a fix. |
| `src/publish-input-lifecycle.dom.test.tsx > preserves user input when the opening animation finishes late and publishes exactly that review` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/publish-review-copy.dom.test.tsx > makes rechecking secondary after a compatible review without repeating the preview heading` | Assertion / lookup failure | Test-only placement migration: consequence and confirmation scoped to accessible 更新确认 group, not absent Ant modal footer. |
| `src/source-import-task.dom.test.tsx > requires a new use gesture after read-back by double click, including an accepted snapshot whose newer input failed` | Assertion / lookup failure | Test-only safe-copy migration: sanitized fallback plus negative raw-error assertion; gesture/focus/snapshot/request checks retained. |
| `src/source-import-task.dom.test.tsx > requires a new use gesture after read-back by held Enter, including an accepted snapshot whose newer input failed` | Assertion / lookup failure | Test-only safe-copy migration: sanitized fallback plus negative raw-error assertion; gesture/focus/snapshot/request checks retained. |
| `src/source-refresh.dom.test.tsx > keeps a stale candidate visible and requires read-only verification before another decision` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/source-saved-failure.dom.test.tsx > allows paired legacy records with both revisions missing without inventing a fence` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/task-experience.dom.test.tsx > does not offer a cached subscription link when the current access check rejects it` | Assertion / lookup failure | Test-only fixture/copy migration: actual 409 generic detail contract, safe notice and negative raw detail; cached-link hiding/retry retained. |
| `src/ux-recovery.dom.test.tsx > does not classify profiles as unpublished while outputs are loading or failed` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/workspace.dom.test.tsx > real component user tasks (DOM, not browser rendering) > retains a failed source form and retries the same source identity with corrected input` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |
| `src/workspace.dom.test.tsx > protects unsaved profile changes when navigating by keyboard` | 10,000 ms deadline | No causal repair established; current full-run non-reproduction only. |

The five migrations are three safe-copy/contract cases and two review request/placement cases, documented in [Safe-copy contract migration](SAFE-COPY-CONTRACT-MIGRATION-2026-10-23.md) and [Remaining UI assertion migrations](REMAINING-UI-ASSERTIONS-2026-10-23.md). They correct expectations to reviewed behavior without demonstrating a production repair for the other historical failures. The separate final Backup negative-label assertion migration is not one of the prior seventeen and is not credited for their absence. The suite grew by 43 tests and two files; changing coverage and an uncaught error further prevent interpreting lower failure count or shorter duration as proof of reliability or speed improvement.

## Exact source binding

The root-approved source manifest contains **1088 entries**, SHA-256:

`1c1db63b2ee5d6d103c552b297e5c32c988149e1aeacbd01188a4c44cda666bf`

Canonical before-copy, canonical after-copy and isolated frozen before-run manifests matched exactly. Both canonical and frozen after-run manifests remained identical: zero changed entries. This binds the run to the final postmigration WIP21 source; generated checkpoint-status metadata is not a production/test source difference. The final Backup assertion file postimage was guarded explicitly:

`4ea61b2771cfd54f51b48ab6be56e02f7d367404f033272162f592283d86e903`

The manifest records source-file hashes/modes and symlink identities; it does not traverse dependency targets and excludes Git, dependency contents, generated dist/test reports/caches, Python bytecode and TypeScript incremental artifacts. Therefore invariance does not claim an identical entire filesystem. Build outputs were produced only in the isolated tree and separately inventoried. QA serialization covered 01:37:03–02:01:07 UTC. No canonical changes were made by the runner. This report was prepared after terminal completion outside canonical and is not part of the tested 1088-entry manifest.

## Evidence index and remaining limits

These are relative internal evidence-package identifiers, not public download links. Raw logs, DOM, private filesystem paths and stacks are not distributed in this portable report.

- `fresh-full-web-20261024T0136/terminal-receipt.json`: exact stage commands/times/native exits, wrapper exit 1 and source invariance.
- Same package: `canonical-before.json`, `canonical-after-copy.json`, `canonical-after.json`, `source-before.json`, `source-after.json`, `test-inventory.json`, `built-assets.json`.
- Same package: `web-summary.json`, `web-failure-ledger.json`; original native logs remain retained internally and authoritative.
- `integrated-independent-resume-20261023T2215/COMBINED-SUMMARY.json`, `web-summary.json`, `web-failure-ledger.json`: preserved prior 17-failure full-gate evidence.
- [Integrated verification, 2026-10-23](INTEGRATED-VERIFICATION-2026-10-23.md): prior independent stages, blocked official quick and scope limits.

No automatic rerun was performed. Next work must establish causes for the current seven failures and uncaught error under unchanged budgets, then obtain fresh full-run evidence against any changed source. Neither isolated green results nor count reduction can certify overall product quality, accessibility conformance or Google-level polish.
