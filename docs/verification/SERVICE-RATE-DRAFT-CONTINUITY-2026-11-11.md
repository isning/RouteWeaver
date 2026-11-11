# Service-rate draft continuity

2026-11-11. Local patch based on `09a4db8`; no publication, deployment, live data, or browser session was used.

## Reproduced failure

The public `ServicePolicyEditor` seam opened a saved rate of 250000 bytes/second (2 Mbps). Replacing the visible rate with `-` and clicking **预览影响** sent the old 250000-byte rate. The new regression expected no preview request and failed with that exact payload before the production patch.

`ByteQuantityInput` retained incomplete text locally without changing the numeric form value. The service editor therefore neither owned that edit nor validated it. Unmounting the limits accordion also discarded the component-local spelling. Complete negative input and an empty field already changed form storage and were separate cases, not evidence for the same native-submit bypass.

## Scoped change

- The service editor owns raw rate text and the last accepted exact rate. Raw-only edits dirty the task and invalidate latest-version and preview authority. Submission checks this ownership even when native validation is bypassed.
- Edited Mbps values use the existing exact-decimal byte parser with a 125000 scale. Fractions are accepted only when they represent whole bytes/second within the safe integer limit. Untouched stored rates never round-trip through displayed Mbps.
- The rate field opts into raw-text validation and a mount-time spelling. Accordion close/reopen retains both incomplete and valid spelling. Preview opens a collapsed invalid rate before ordinary form validation and existing submit-error focus recovery run.
- Explicit discard keeps the last accepted rate, including a valid unsaved change, rather than restoring the original saved rate. The recovery text identifies that choice in Mbps terms and does not claim it was saved.
- Latest-version adoption starts from the authoritative rate and keeps the previous raw spelling only in the retained comparison. A collision restart carries its own active dirty ownership even after its comparison copy is discarded.
- `ByteQuantityInput` gains an opt-in initializer. Later authoritative value or unit changes supersede it without emitting a user change. `NumericInput` is unchanged. Other `LimitFields` callers retain their existing validation path.

## Verification

Failing-before-passing observations:

1. The initial editor regression failed on the old 250000-byte preview request for visible `-`, then passed after the caller-owned patch.
2. Independent review found the proposed numeric synchronization could ignore a unit-only change. Two public GiB → Mbps → GiB rerender regressions failed with stale `1` / `+01.000` instead of `8589.934592`. Tracking the displayed unit fixed both.

Final focused command, one worker:

```sh
cd web
npm test -- --maxWorkers=1 \
  src/service-limit-draft-continuity.dom.test.tsx \
  src/byte-quantity.dom.test.tsx \
  src/policy-service-edit-intent.dom.test.tsx \
  src/policy-control-settlement.dom.test.tsx
npm run build
```

Result: **86 tests passed in 4 files**, followed by TypeScript and Vite build success. The new service-rate file contributes 27 cases; the existing byte-input file gains 4 cases. An earlier build exposed unsupported `exact` options on role queries; these were removed because string accessible names already match exactly, and the final command passed.

The public tests cover partial/invalid rates, ordinary and direct submission, exact-byte correction to 375000, zero and safe-integer bounds, dirty Cancel/Continue, explicit discard and clean reopen, collapsed-field focus recovery, accepted spelling through remount, stale reads/previews, retained text versus authoritative adoption, collision restart and active-draft ownership, and unit/value reset precedence. No private hook state or implementation callback is asserted.

## Bounds

- This is focused DOM and build evidence, not a new aggregate or native-browser acceptance claim. Actual accordion animation, viewport geometry, keyboard input and physical focus visibility still need native acceptance after integration.
- Online-IP and connection-count raw inputs use `NumericInput` and native custom validity while mounted. Their accordion continuity remains a distinct follow-up risk; this patch does not claim to fix those fields.
- No API, server validation, live mutations, credentials, global numeric-control behavior redesign, or deployment was included.
