# Source-editor fixture wave ownership

## Scope

The source-task-layout and source-editor DOM integration fixtures now explicitly disable decorative Ant Design click waves with `ConfigProvider wave={{ disabled: true }}` in their three render wrappers. Production motion and production wave behavior are unchanged. Existing real user events, focus/visibility checks, task assertions, cleanup and test budgets are unchanged.

The supported `wave.disabled` option is documented in the official [ConfigProvider WaveConfig API](https://ant.design/components/config-provider/#waveconfig), checked on 2026-10-24. The documentation currently displays version 6.6.7; the installed 6.6.6 declaration also exposes `WaveConfig.disabled?: boolean`. This is an API-supported fixture choice, not a claim that upstream recommends disabling waves in all tests.

## Source-backed ownership

The investigated installation uses Ant Design **6.6.6** and `@rc-component/motion` **1.3.3**. Relative to `web/node_modules`:

- `antd/lib/_util/wave/index.js` uses visibility to decide whether a click can trigger a wave. These fixtures deliberately provide visible `offsetParent` values for nested-dialog focus testing.
- `antd/lib/_util/wave/useWave.js` respects `wave.disabled`; unmount cleanup cancels a pending initial animation frame, not an already-created wave root.
- `antd/lib/_util/wave/WaveEffect.js` creates a separate React root in an inserted holder and gives its `CSSMotion` a native 5000 ms deadline. That independently created root does not inherit the fixture's `motion:false` context.
- `@rc-component/util/lib/React/render.js` creates and owns that separate root. RTL cleanup only unmounts roots registered with RTL; removing the containing DOM is not equivalent to unmounting this independent React root.
- `@rc-component/motion/lib/hooks/useStatus.js` creates the deadline and cancels it when its own motion component unmounts. Its completion path obtains the DOM element through `CSSMotion` and `findDOMNode`; the latter reads global `HTMLElement`.

This explains how a wave deadline can outlive parent cleanup and later encounter an already-torn-down jsdom environment. It does not implicate the App hook-modal holder, which remains inside the mounted App tree.

## Diagnostic evidence

A private, bounded ownership diagnostic used an actual visible AntD Button click under `theme.token.motion:false`. After three observed animation-frame opportunities, the wave-active DOM and independent root were present. Actual RTL cleanup detached its holder, but retained the same independent root and an uncanceled native 5000 ms `useStatus` timer. The root and holder subsequently disappeared approximately **5007.87 ms** after timer creation; cancellation was observed at completion.

The wave-disabled counterpart preserved the click callback and button focus and created neither an independent wave root nor that deadline over equivalent frame opportunities.

Native callbacks, delays and arguments were forwarded unchanged. No environment globals such as `HTMLElement`/`window` were deleted to manufacture an error; existing visibility/ResizeObserver fixtures were retained. No errors were suppressed, timer callbacks manually invoked, or artificial missing-HTMLElement exception generated. Completion was observed through RTL `waitFor` against actual root/holder removal. Only this new diagnostic had a 6500 ms observation window, derived from the existing 5000 ms library deadline plus observation margin; its native 10 s test budget was unchanged. The diagnostic is not part of the product test suite.

## Verification and limits

| Stage | Result |
| --- | --- |
| Initial preflight | Diagnostic-only typing error: holder marker used `object` rather than React DOM `Root`; stopped before tests |
| Corrected preflight | Typecheck passed after that exact type-only correction |
| Ownership diagnostic | 2/2 passed; no unhandled errors |
| `source-task-layout.dom.test.tsx` | 6/6 passed |
| `source-editor.dom.test.tsx` | 8/8 passed |
| Focused invocation | Exit 0; no unhandled errors; one worker; retries disabled |

The failed initial preflight and corrected run are retained separately in private verification evidence. An exclusive QA lock covered fresh source materialization and all verification. Canonical source hashes and file modes were unchanged during the runs; only private compiler build metadata changed after the source snapshot.

The original aggregate's two 10 s test-body failures occurred in other files and are not resolved by this change. A new full aggregate run is still required. Historical window errors are not claimed resolved. These results establish a matching teardown mechanism and a narrow fixture correction, not universal proof that every historical motion error had this owner.
