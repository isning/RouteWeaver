# Service-plan cycle draft continuity

2026-11-12. Isolated patch based on `876fc07` (production source `5db380e`). No main-checkout edits, publication, deployment, live data, or browser session was used.

## Reproduced failures

Leave the service plan's active rule unchanged: monthly day 1, or fixed-days 23. Enter `-` or `1e`. Native validity already blocks ordinary Preview, but raw-only Cancel closed without a discard decision. After a stale-preview conflict and explicit latest-version adoption, the promised retained copy showed the previous `1 日` / `23 天` rather than the unfinished input.

A separate precision case entered `1.0000000000000001` / `23.0000000000000001`. Number conversion rounded those fractions to the existing integers, so ordinary Preview sent the old day/days and Cancel closed directly. This does not imply that all numeric validation was absent: ordinary fractions already failed, and visible incomplete syntax already blocked native submission.

Both active values have an exact integer contract: monthly day 1–31, fixed-days length 1–3660 (`internal/service/cycle.go`). Preserving irrelevant stored parameters when the rule changes is intentional and is not treated as a defect.

## Scoped change

- The service editor owns raw cycle text and the last valid numeric day/days. Every raw edit dirties the task and invalidates latest-version and preview authority.
- The existing `operationalInteger` decimal-intent parser validates only the active parameter. Form rules and request-boundary checks reject unfinished, fractional and out-of-range active input, including direct submission that bypasses native validity.
- `CycleFields` gains optional initial spelling and validation callbacks beside its existing raw-input callback. Service plans opt in; account-cycle callers retain their existing path. Shared `NumericInput` is unchanged.
- Explicit mode changes remain available. Inactive parameters keep their last accepted numeric values and do not block Preview. Returning to an edited field restores its exact text and active validation. Untouched inactive stored values are preserved without new range errors.
- Latest adoption resets the active editor to the authoritative record and keeps old raw text only in the retained copy. A new-ID restart preserves exact spelling and independently owns the active unsaved draft even after its comparison copy is discarded.
- Retained comparisons show unfinished or alternate spelling without placing raw text in server reviews. Canonical valid strings preserve the existing comparison labels.

## Verification

Failing-before-passing evidence:

1. Initial eight tests: **4 failed / 4 passed**. Both tiny-fraction previews sent old active values; both raw-only Cancel tests closed directly. Obvious fractions and native incomplete-input controls passed.
2. Eight added ordinary `-` / `1e` cases: **8 failed**, covering raw-only Cancel and retained-copy loss for both active modes.
3. The original sixteen cases passed after the caller-owned fix. Expansion reached 54 cases.
4. A related existing collision-copy test exposed an unnecessary label change for canonical inactive values. Preserving the existing representation fixed it. An initial TypeScript error on optional indexed access was corrected by checking a local value before use.

Final command, one worker:

```sh
cd web
npm test -- --maxWorkers=1 \
  src/service-cycle-draft-continuity.dom.test.tsx \
  src/service-cycle-defaults.dom.test.tsx \
  src/service-count-draft-continuity.dom.test.tsx \
  src/policy-entitlement-edit-intent.dom.test.tsx \
  src/service-policy-comparison.dom.test.tsx
npm run build
```

Result: **152 tests passed in 5 files**, followed by TypeScript and Vite build success. The new file contributes 54 cases. It exercises ordinary and direct Preview, exact integer bounds/corrections, Cancel/Continue, native validity, explicit mode changes, inactive stored values, clean reopen, latest adoption and retained copies, held reads/previews, corrected active restart, inactive unfinished restart, and independent restarted-draft ownership. Tests observe the real editor, visible controls/comparison tables and synthetic request payloads, not private hook state.

## Bounds

- Focused DOM and build evidence only. No new full aggregate or native-browser acceptance is claimed. Actual keyboard editing, dialog dismissal and focus visibility at narrow/desktop widths still need native acceptance after integration.
- The account/user cycle editor already owns unfinished exact text; this patch does not redesign it. Existing date/anchor handling and deliberate hidden-parameter preservation remain unchanged.
- No API, backend validation, apply request, credentials, global numeric behavior redesign or deployment was included. Fixture requests are restricted to synthetic edit-context and preview endpoints.
