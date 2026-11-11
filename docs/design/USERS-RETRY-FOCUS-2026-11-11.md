# Users cached-read retry keyboard continuity

## Finding and scope

The cached Users inventory retry used a native disabled button during a GET. Browser evidence reviewed by the coordinator showed focus falling to BODY at both narrow and desktop sizes. The source also used the default cached-query refetch behavior, which can cancel/restart a read under same-turn repeated activation.

This change is limited to the cached Users recovery action. Initial-load QueryState behavior and unrelated inventories are unchanged. Fresh-read authority remains `query.isSuccess && query.fetchStatus === "idle"`; stale row editing, entries, and menus stay fenced.

## Interaction decision

- Follow the existing AccountingRecovery/Outbox action pattern: pending and aria-disabled/aria-busy feedback without native disabling, plus `cancelRefetch: false` for same-turn deduplication.
- Keep focus on the retry throughout fetching, offline pause, and renewed failure.
- When success removes the error notice, transfer focus to the retained Users search only if that retry still owned focus immediately before removal. Capture ownership with stable React 19 ref cleanup, then apply the handoff after the commit. The search must still be connected, visible to accessibility, and outside an inert subtree, the Users page must have fresh authority, and BODY must be the current focus. A newer search or dialog interaction retains its own focus.
- Keep search text and pagination; do not enable stale mutations or introduce a generic focus abstraction.

## Verification

Public seam: real AdminPage, table, dialogs, and shared action controls; controlled fetch boundary and unavailable layout shims only. No component mocks.

- Red tracer: 5 existing Users cases passed, 1 new case failed because the pending retry was natively disabled (expected false, received true).
- Green: Users file passed 9/9, including same-turn double click, repeated Enter/Space/click, one held GET, controlled failure then success, retained page-two search and row fences, newer search/dialog ownership after success and failure, and offline pause/resume.
- Related focused run: 50/50 across Users inventory, Resources inventory, Sources inventory, Fleet continuous service, and asynchronous action accessibility (one worker).
- `npm run typecheck` passed. `git diff --check` passed.

These are DOM behavioral and type checks, not browser layout or cross-browser evidence. No browser was launched, no full suite rerun was performed by this worker, and no publication/deployment occurred. Real browser focus/viewport verification remains a separate delivery gate.

## Native sampler extension (execution pending)

The existing loopback-only Users sampler at 390×560 and 1440×900 now checks pending retry focus/focus-visible/viewport/hit geometry, non-native-disabled plus aria-disabled/aria-busy semantics, and exactly one held services GET after repeated ordinary Enter/Space activation. After release, it captures the original success viewport before further keyboard navigation and checks that search receives focus and the retry notice is removed. Existing stale action gates, correct-user entry task, screenshot-before-geometry ordering, strict API allowlist, mutation blocking, and final evidence capture remain intact. No script focus or scrolling was added.

Playwright discovery recognizes both viewport cases; standalone spec TypeScript checking passes. The sampler uses the real App query defaults (`retry: 1`) and requires at least two failed inventory reads before recovery, rather than disabling automatic retry. A renewed failure/backoff after manual activation is not separately exercised by this native fixture. Native browser execution is not available locally and remains unrun; these new assertions require CI. Same-turn duplicate activation, controlled renewed failure, offline resume, and newer search/dialog focus remain covered by DOM tests rather than a claimed native run.

## Native pending-phase capture correction

The recovery lane for `2a095264e5d6d531196191f17f1667253ed21fc1` completed 68 cases and failed both Users cases before their pending assertions: `settledTask(body)` correctly observed running motion while the HTTP response was deliberately held. Original artifact 13882299269 (ZIP SHA-256 `95710c3f90e82b67ba1ae407446446c860dbe84c252a5d818cd35b8f24f97e33`) preserves the pending screenshots and geometry despite that capture failure.

Independent inspection of original PNGs `ceff2526fd5a68c5daff52385d5800ab77ac5698.png` (390×560) and `fbe18642389ea6aa9306742082ffaa1f6b3d4ad4.png` (1440×900) confirms a visible spinner and focus ring on the retry. Both geometry records show a 128×44 button with focused/focusVisible/inViewport/hit all true, at (51, 313.75) and (316, 265.75) respectively; neither page overflows horizontally. Both ledgers record two failed reads, one held retry read, zero entry reads, no rejected requests, and no page errors. This proves the captured pending focus only, not the unreached success handoff or repeated-activation assertions.

The pending capture now explicitly skips the settled-task precondition for this deliberately unfinished phase only. All original pixels, geometry, pending focus/semantics, held-GET, and recovered-state assertions remain. Recovered search, entry, and dialog captures still require strict settling. No shared animation rule, spinner, timer, timeout, or production code changed. Explicit workflow artifact paths now include the recovered-search PNG and JSON. Corrected native execution remains pending CI.

Correction checks: standalone Users spec TypeScript check and two-case Playwright discovery pass. The workflow's exact artifact contract first failed on the newly added recovered-search files; adding that named phase to its expected inventory restored all 5 focused workflow contracts. `git diff --check` passes. Native assertions after the corrected pending capture have not yet run.

## Coordinator aggregate check

On 2026-11-11 at 18:39 UTC, the clean serialized web aggregate completed with 4,135/4,135 tests across 337 files (exit 0; 1,164.91 seconds). Production and DOM-test content was the Users retry implementation from `5f91524`; intervening commits changed native tests, workflows, and evidence notes only. The subsequent production build also passed. This does not replace native execution of the corrected pending-phase sampler or the latest remote full gate.

## Exact-source native success and bounded pixel acceptance

The corrected recovery lane at `213e6b211effe36461a9dec4393fff87d0b20703`
passes 70/70 native cases, including both Users viewport journeys. Artifact
`13885140996` has original ZIP SHA-256
`2c79cc2f0f86f89dad42a3f13cb32d61fe61369f43cb571c5c92bdca1fc5f52b`.
This digest identifies the downloaded ZIP, not the review manifest.

Independent review opened these six unmodified originals under the artifact's
`web/playwright-report/data/`, mapped by `users-recovery-originals-manifest.json`:

| State | 390×560 | 1440×900 |
| --- | --- | --- |
| Held retry | `f667c3d380addd1c8d1ccd239d0c424a40ac6eae.png` | `9458d05f5211ed9555ced03622970acd4ef40321.png` |
| Recovered search | `588247f8a0f95e007510266d37661c576510caa5.png` | `50a3d46cce18db863a39546a1cd6543940a80f33.png` |
| Recovered entry | `9468b189c7e30dedb261b5292882945050720a0b.png` | `a99defc9ba42f4ea06d4a61fbf886bfbdeec5e06.png` |

Pixels show complete, clearly painted focus rings in all six states. Held retry
retains readable failure/stale-list context, a spinner and the checking status.
Recovered search removes the failure panel, retains “合成用户”, and shows the
count and 合成用户10 row. Recovered entry visibly associates the focused 平台入口
with 合成用户10; the narrow action-side identity remains legible after table
scrolling. No clipped ring, obscured target or blocking visual defect was observed
in these captures.

Separately, paired geometry reports focus/focus-visible/inViewport/hit true for
the target in every capture, with scrollWidth equal to viewport width. Both
ledgers record two failed reads, one held retry and one entry read, no rejected
requests and no page errors. These measurements and native assertions corroborate
but do not substitute for the pixel observations.

This accepts the captured light-mode pending → search recovery → correct-entry
continuity, not uninterrupted ring animation, dark-mode pixels, real backend
mutations, renewed native failure/backoff, offline transitions, newer-interaction
races or comprehensive accessibility. The reviewer performed no download, image
transformation, test run or source edit. Exact-head full CI remains a separate
gate; the coordinator aggregate above is not duplicated or relabelled here.
