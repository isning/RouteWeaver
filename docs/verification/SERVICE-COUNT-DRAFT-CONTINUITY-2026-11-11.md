# Service count-limit draft continuity

2026-11-11. Local patch based on `bebe37d`, following the separate service-rate fix. No shared numeric control, API, deployment, credentials or live data was changed.

## Verified distinction

With saved online-IP/connection limits of 2/10, the public service editor correctly blocked ordinary Preview while visible `NumericInput` controls contained `-` / `1e`: native custom validity was already active.

The defect appeared at the ownership boundary:

- Collapsing the limits accordion unmounted the invalid control. Ordinary Preview then sent the old 2/10 counts.
- Reopening replaced the raw spelling with the old number.
- Cancel closed a raw-only edit without a discard decision.
- Direct form submission bypassed native validity and also sent the old numbers.

The initial 10-case public regression had **2 passing native-validity controls and 8 failing ownership cases**. The same file passed all 10 cases after the caller-owned change. Complete negative/fractional values are covered separately and are not used to claim visible native validity was absent.

## Change

- `ServicePolicyEditor` owns exact raw count text and each last accepted count, alongside existing rate ownership. Every raw edit dirties the task and invalidates latest-read and preview authority.
- `LimitFields` provides opt-in callbacks, validation and remount spellings for these two service-editor fields. `NumericInput` and other callers retain their existing behavior, including native custom validity.
- Count parsing uses scale 1 in the existing bounded exact-decimal parser. Zero and exact scientific notation are supported; fractions cannot round into integers, and unsafe values remain invalid.
- Submit validation checks raw ownership after accordion collapse or native-validity bypass. The caller opens a collapsed invalid field before the existing form validation/focus recovery runs.
- Discard settles only the selected field to its previous valid draft count. Latest adoption resets active fields to authoritative saved values while preserving raw text in the retained comparison. Restarted creation carries exact valid spelling and independent active-draft ownership.

## Focused verification

```sh
cd web
npm test -- --maxWorkers=1 \
  src/service-count-draft-continuity.dom.test.tsx \
  src/service-limit-draft-continuity.dom.test.tsx \
  src/byte-quantity.dom.test.tsx \
  src/policy-service-edit-intent.dom.test.tsx \
  src/policy-control-settlement.dom.test.tsx
npm run build
```

Final result: **121 tests passed in 5 files**, one worker, followed by TypeScript and Vite build success. The new count file contributes 35 public-task cases.

Coverage includes the native-visible distinction, collapsed/direct submission, reveal and focused correction, exact integer bounds and zero, separate field discard, Cancel/Continue and clean reopen, retained/latest reset, held read/preview invalidation, and collision restart followed by copy discard. Assertions observe controls, focus, decisions, comparisons and synthetic preview requests rather than private hook state.

## Bounds

This is focused DOM/build evidence, not an aggregate-suite or native-browser acceptance claim. Actual keyboard input, native validation presentation, animation and focus visibility at narrow/desktop viewports remain native acceptance work. No live mutation, publication or deployment was performed for this patch.
