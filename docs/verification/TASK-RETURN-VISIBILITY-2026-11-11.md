# Task opener visibility after dismissal

## Native finding

Recovery run `da66409`, artifact `13875953631`, failed the unchanged diagnostic
registration full-visibility check at 1440×640 in both invalid-field and definite
save-rejection cases. The original report's `returned-opener-geometry` records
x=795.5, y=596.25, width=106, height=44: the bottom was 640.25. Exact opener focus,
focus-visible and center hit testing passed, and settling did not fail. The
original returned/final PNG `ba9ffc82f335644cc3bded69fa28c0a32e2f2672.png` visibly
clips the bottom focus ring. The 390px cases returned fully visible. This is not
a missing-focus or lost-draft finding, and allowing fractional overflow would
not recover the clipped ring.

The existing shared overlay owner restored focus with `preventScroll: true` and
kept that edge position. The correction retains its eligibility/newer-interaction
guards and no-scroll focus return. Within the same close microtask, a still-active,
connected opener with a nonzero box is checked against the viewport with 4px
clearance (the standard 3px focus ring plus fractional-scroll rounding room).
Only an unsafe opener receives one immediate native centered scroll. Safely
visible openers do not scroll. A focus handler that redirects focus or reopens
the task prevents this recovery. No independent timer, observer, test scroll,
geometry tolerance or timeout change was added.

This is viewport-edge recovery, not a new general ancestor-clipping or sticky
occlusion detector. Existing form visibility recovery is unchanged.

## Verification

The public `TaskDialog` dismissal tracer, supplied the exact native rectangle,
first failed because no scroll was requested, while exact focus restoration
passed. After the correction the same tracer passed. Expanded public dialog and
sheet coverage includes top/left/right/bottom focus-ring edges, safely visible
openers, departed openers, newer interactions after dismissal, focus-handler
redirection and task reopening. Geometry and the browser scrolling API are
supplied at the DOM boundary; these tests do not prove rendered visibility.

- Tracer before correction: 1 expected failure.
- Tracer after correction: 1 pass.
- New visibility, existing overlay and diagnostic focus suites: 32/32 passes in
  10.09 seconds, one worker.
- Related one-worker run: 167/167 passes across nine files in 26.80 seconds:
  task-return-visibility, task-overlays, diagnostic-target-submit-focus,
  session-departure-focus, policy-return-focus, resource-modal-focus,
  publication-modal-focus, announcement-modal-focus and policy-modal-focus.
- `npm --prefix web run typecheck` (`tsc -b`) and `git diff --check` passed.

No local native browser was launched. The unchanged native diagnostic cases and
fresh original-pixel review remain required on the new exact commit. No full
aggregate run, publication or deployment is claimed by this note.

## Native rerun exposed a missed conditional-unmount branch

The subsequent exact-head native run at `9122d4d` did **not** accept the first
correction: 68 cases passed and the same two diagnostic 1440px cases failed.
Artifact `13879020889` has identical returned-opener geometry and the same PNG
content as the first failure. The earlier DOM passes remain valid only for their
exercised paths; they did not establish native recovery.

The diagnostic owner conditionally mounts `DiagnosticTargetForm`, whose dialog
uses a constant `open` prop. Closing it unmounts the hook without rendering
`open=false`. The added visibility guard therefore rejected the disposed task's
last `open=true` snapshot, even though the existing focus-restoration path ran.
The first regression host instead kept the dialog mounted with `open={state}`,
so it missed this branch.

A new public conditional-mount dialog/sheet tracer fails on the original guard
(two failures; the preceding eleven cases pass). The correction tracks the
hook's mounted lifetime in layout cleanup: a disposed task can recover its
returned opener, while a still-mounted reopened task remains protected. Exact
opener identity, connectedness and active focus checks remain in place. No
native assertion, tolerance, timeout, timer or modal owner contract changed.
Additional cases cover safely visible conditional returns, newer interaction
after unmount, and a replacement task opened by the return-focus handler.

After the lifetime correction, the same nine-file one-worker affected suite
passed **172/172 tests** in 26.03 seconds, including the two formerly failing
conditional-unmount cases and three additional guards. `tsc -b` and
`git diff --check` passed. The native failures at `9122d4d` are not relabelled as
passes. New exact-head native execution and original-pixel acceptance are still
pending; no local browser was launched.
