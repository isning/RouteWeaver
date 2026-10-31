# Missing action recovery — real-browser acceptance

Recorded 2026-10-22 14:25 UTC. This is bounded browser evidence, not a claim of whole-product or Google-level quality. Authentication/session work remained isolated during these runs and is not certified by them.

## Results

Two separate runs against the same frozen production source:

| Suite | Actual result | Start (UTC) | Duration |
| --- | --- | --- | --- |
| New missing-action repair tasks | 3 passed, 0 skipped/flaky | 14:20:09.649 | 30.063 s |
| Existing canonical journeys | 19 passed, 0 skipped/flaky | 14:20:53.048 | 130.592 s |

Do not report these as a single 22-test run. Both before/after production manifests contain 228 files and have SHA256 `9c53a5bd4af86e3e5ef80a7dd460482da6dc9d4bf0a69630a1eb3cc8a367d431`. Both ended with ports 8080/4173 closed and no synthetic demo database directory remaining.

The three new tasks are now retained in `web/tests/repair.ui.spec.ts`:

1. Accepted source update removes a selected connection. Real backend rejects selected phone subscription preview; repair navigates/focuses the default control. Explicit choice and save retain the selected phone target. Confirmation stays disabled until a fresh successful check. Only explicit confirmation updates that phone; the independent laptop remains unchanged.
2. One removed connection occurs in a group and two rules. The second-rule CTA focuses that exact occurrence; group CTA focuses the correct group. Real backend returns the stable group location, and its error repair focuses the matching control. No automatic intent rewrite or publication. Full focused input fits at 390 and 320 pixels, with page width equal to viewport; group also fits at 320.
3. New-client name, sing-box target/version and nodes-only mode survive repair suspension. No output is created before fresh check and explicit final confirmation. Existing outputs remain unchanged.

Fixture setup uses public HTTP and synthetic local material; update acceptance and recovery decisions are real UI actions. Validation responses are not mocked. Output baseline and later observations both use the safe public GET projection, comparing all returned fields. This avoids incorrectly comparing one-time access-bearing create responses with intentionally redacted list responses. Existing canonical journeys independently retain delivery-content/access-identity freezing checks.

## Actual counterexample closed

Before the narrow CSS fix, 390-pixel page width expanded to 612–614 pixels: an unresolved connection's long ID forced `.rule-action .ant-select` to about 525 pixels. Focus landed on the correct control but only part of it was visible. The test now requires complete focused-input visibility (`ratio: 1`) and exact page width at both 390 and 320 pixels; it does not mask overflow globally or remove the long-ID case.

The scoped `ProfileIntent.css` repair constrains flex sizing without changing underlying selection/candidates. CSS SHA256: `c27d92bfc2696446312d7dce93c0ddeecf0ee93c2f582f27edaf2d8143ba68cb`. Screenshots inspected internally show one-line labels, truncated display value, visible complete focus ring, and no sideways page stretch.

## Existing test update and migration

`source-refresh.ui.spec.ts` now checks the intended contextual Chinese failure and typed default metadata, verifies raw technical detail is initially collapsed and can be opened, then uses the repair CTA and checks actual focus/viewport. It retains real HTTP 400 and exact raw diagnostic integrity; this is not a weakened replacement for a failing assertion.

The three already-executed scratch tasks were moved to canonical tests after the runs. Changes are only the portable `@playwright/test` import, explicit safety override, and formatting. Manual diff verified this. Canonical `playwright test --list --project=chromium` passed and discovers **22 tests in 5 files**. The post-migration single 22-test execution is reserved for the next combined gate after remaining work merges; it has not been claimed here.

## Safety and evidence locations

Sandboxed Chromium 153, real loopback demo backend, installed direct binaries, offline Go, shared `/tmp/routeweaver-qa.lock`. No deployment or uploads. Trace and automatic screenshots disabled for the three new publication tasks; only deliberate safe business-state screenshots are captured before publication. First scratch assertion logs inadvertently included expired synthetic access paths; those paths were locally redacted after service/database destruction, and were not uploaded.

Local evidence directories (not required to execute canonical regression tests):
- `qa-runtime/repair-journey-run2`: original overflow counterexample and 2/3 initial result.
- `qa-runtime/repair-journey-final3`: new 3/3, report, manifests and safe screenshots.
- `qa-runtime/repair-full-final19`: existing 19/19, report and manifests.
- `qa-runtime/repair-journeys/canonical-migration-list.log` and `.diff`: portable migration review.

This review follows repository AGENTS.md public-seam, intent-preservation, actual rendering/focus and resource-serialization requirements. The pinned tests skill was unavailable locally and official retrieval returned cache miss; no claim is made that this unavailable reference was executed.
