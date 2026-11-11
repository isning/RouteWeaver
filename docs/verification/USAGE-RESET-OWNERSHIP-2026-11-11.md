# Usage reset ownership and reason preservation

## Scope

The authorization sheet contains two independent tasks: policy editing and manual usage reset. The reset reason stays outside the policy form and is never included in policy preview/apply data. This change protects the reason, reset confirmation and completion lifecycle without changing the reset endpoint or backend accounting behavior.

Inspected proposal base: `924120a`. Regression-first integration base: `ba8de69`. No live user reset, credential operation, browser session, remote publication or deployment was performed. All new HTTP behavior tests use intercepted synthetic responses.

## Reproduced failures

Before source changes, focused public-UI tests failed independently:

- Typing only a reason did not register unsaved content. The sheet's close/navigation ownership considered policy fields only.
- Removing the editor while retaining its UI provider left the old reset confirmation live. Clicking that surviving public button sent `/api/users/u1/reset` with the departed reason.
- A successful reset cleared the reason and disabled its opener. Confirmation dismissal left focus on the sheet container rather than an eligible reset control.

A further isolated acceptance check reproduced a nested case after the initial correction: reset could finish while a pending-navigation decision owned focus; choosing Stay afterward left focus on the body because navigation's captured opener was the removed reset-confirm button. The reset-local correction passed that exact case before broader reruns.

These are observed DOM/network-seam failures, not rendered-browser evidence. The reset-dispatch reproduction intercepted the HTTP request; it did not reset a real account.

## Ownership and behavior

The reset task is owned above the policy-fields generation key. Adopting the latest policy version retains the independent reason. Removing or replacing the user editor immediately revokes its reset decision. Confirming reset requires the live owner, its current decision, the exact reviewed reason/revision and no pending operation.

Every raw character counts toward a draft, including whitespace. Only exact clearing returns to the empty baseline. Whitespace alone cannot be submitted. Local Close, Cancel and Escape use one discard decision when either policy content or the reset reason needs protection. Canceling preserves both.

A pending reset blocks local dismissal, reason changes, duplicate submission and policy preview. Global navigation may proceed only after its explicit warning that leaving does not cancel the submitted reset. A departed request's later success/failure cannot clear a replacement reason, display an old outcome or invalidate the replacement overview observer.

Success clears only the current task's submitted reason. After the confirmation closes, it returns focus to the enabled reason input only if focus was released to the body, detached/closing content or the owning sheet container. It does not replace newer control focus or focus hidden/inert content. Cancel retains the existing opener restoration behavior.

When success occurs under a still-open navigation decision, the local reset task may defer that handoff until that exact marked review is removed. `App.tsx` adds a semantic data marker around the existing navigation-description text and records its explicit Stay/Leave outcome immediately before calling the unchanged navigation callbacks; navigation behavior and global focus logic are unchanged. Restoration requires explicit Stay, not merely removal of the review or a still-live editor, because accepted browser history replay can unmount the editor later. The one-shot local observation is canceled on unmount, reason revision/new reset, window blur/visibility change or newer eligible focus. It cannot follow a different review or modal. Positive Stay and negative newer-control/newer-modal/confirmed-departure cases cover the handoff. Real-browser focus/animation review remains outstanding.

## Shared policy-close contract

`usePolicyChange` accepts an optional `closeCompanion` containing `pending`, `dirty`, `revision`, `label` and `discardDescription`. This describes another task sharing the editor's lifetime, not policy data. The reset task independently registers navigation ownership; the policy dirty flag and request payloads do not incorporate its reason.

The companion participates in local discard disclosure and pending guards. Because successful policy application already closes the whole sheet, the existing policy-apply checkbox explicitly includes disposal of the reset reason. A newer companion revision clears that consent. Retained policy copies and the reason are named together when both would be discarded. Failed, conflicting or partial-audit policy apply retains the reason. Rebasing and canceled apply/discard never clear it.

Caller behavior:

- Drawer `UserPolicyFields` supplies the reset companion. Non-pending reason text does not block policy preview or alter its payload.
- Non-drawer `UserPolicyFields` supplies no companion and has no reset UI.
- `ServicePolicyEditor` and `GroupPolicyEditor` omit the option and retain their existing labels, close, preview, apply and retained-copy behavior.
- Existing direct/legacy policy-hook callers omit it and retain prior behavior.

The reset request directly awaits the existing `post` helper so request ownership and pending state stay in the reset task rather than an unmounted mutation observer. Existing session transport and server response handling remain in place. No request cancellation, idempotency or stronger failure-outcome guarantee is introduced.

## Verification

`web/src/usage-reset-ownership.dom.test.tsx` contains 25 scenarios covering exact reason preservation/clearing, sheet dismissal, one combined discard, Enter safety, canceled and explicit live reset, pending and duplicate guards, failure recovery, retained-provider owner removal, late completion, Back/Forward, rebase, combined retained-copy consent, policy apply failure/conflict/partial-audit, companion consent revision and immediate/deferred success focus with newer-control/modal/departure negatives.

- Initial focused red results independently established the ownership, stale dispatch and success-focus defects.
- The corresponding three core scenarios passed after the source changes.
- All 21 new scenarios passed with one worker in 10.37 seconds.
- Initial typecheck rejected unsupported `exact` query options in the new tests. Those options were removed; role-name string matching is already exact. No assertion or product behavior was relaxed.
- Typecheck then passed.
- An initial affected-group run passed 334/335 scenarios. Its single failure was the new App fixture capturing a loading sheet that the production editor then replaced. Both setup paths now wait for the connected public reason control and reacquire the sheet. No product assertion or timeout was relaxed.
- The nested-navigation success-focus acceptance scenario was reproduced red, then passed after the local exact-review handoff. All 24 scenarios then present passed before the additional confirmed-departure negative was added.
- A subsequent affected-group run passed 338/339 scenarios and exposed a real deferred-focus race: accepted history replay could remove the review before the editor unmounted. The confirmed-leave negative detected focus returning briefly to that departing input. The explicit Stay/Leave outcome marker corrected that inference without timing heuristics; all four focused deferred-handoff cases then passed.
- Final typecheck passed after the explicit outcome-marker correction.
- Final one-worker affected group passed **339/339 tests across 16 files** in 88.06 seconds. This includes all 25 new scenarios plus entitlement/service/group policy editing, return/error/confirmation focus, submit recovery, partial audit, access policy, workspace navigation/return and task overlays.
- Production build (`npm --prefix web run build`, including `tsc -b` and Vite) passed. `git diff --check` passed.
- Independent read-only source review accepted the shared optional contract, exact Stay-outcome gate and observer/listener teardown without a remaining material source blocker. That review inspected the red/green evidence but did not independently run tests or a browser.

No full-suite or browser pass is claimed for this change. The prior coordinator full suite preceded these edits. Coordinator-owned aggregate verification and rendered desktop/narrow focus/animation checks remain separate; this scoped work performed no browser, remote publication or deployment.

## Integrated pass and prepared native evidence

At approximately 14:39 UTC on 2026-11-11, the complete serialized DOM suite at production/test source `36fa9d7` passed **4,093 tests across 329 files** in 1,120.73 seconds.

The prepared native fixture adds ten real-App synthetic journeys at 390×560 and 1440×560. Six are GET-only dismissal/review-retirement flows with all writes blocked. Four validate and locally fulfill exactly one held synthetic reset, then verify success behind a navigation review and explicit Stay/Leave focus behavior, including transient departing-input focus. No reset request is forwarded to a backend. Masked original PNGs, fixed-category ledgers and named phase geometry have bounded artifact retention.

Strict native TypeScript passes. Supplemental discovery is **64 cases across 19 files** and all five workflow contracts pass. Independent source review accepted the fixture and additive wiring/allowlist; required gates, sandbox, time limits, one worker and zero retries remain unchanged. Actual native execution, lane runtime, browser focus/animation behavior, pixel acceptance and remote CI for unpublished changes remain pending. The authored fixture does not establish real reset execution or backend persistence/auth correctness.
