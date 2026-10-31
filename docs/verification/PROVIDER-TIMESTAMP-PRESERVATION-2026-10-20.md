# Provider timestamp preservation

## Defect and product consequence

The observation settings form displays browser-local date/time to minute precision. Previously, saving an unrelated quota edit reparsed all three displayed timestamps. This silently truncated existing seconds/fractions and could change the supplier billing window (and consequently its baseline identity).

## Change

Preserve the original timestamp string when the local control still equals its initial minute-resolution display. Convert explicitly changed values from browser-local time to ISO. Clearing the optional service expiry still removes it. Unlimited service without a cycle remains unchanged.

## Evidence

- Existing public form/save regression strengthened with offset timestamps and fractional seconds. Before fix, changing only quota submitted rounded UTC timestamps rather than originals; failing output captured in `/tmp/provider-time-red.log`.
- After fix, the same UI-to-request test preserves cycle start/end/expiry exactly while changing quota. Added explicit date-edit and expiry-clear flow.
- A focused run exposed an existing test harness ordering dependency: ResizeObserver was stubbed once but unstubbed after every test. Moved that browser API shim to beforeEach, without changing product code or weakening assertions.
- Focused provider flows: 5 passed, 27 intentionally unselected; typecheck passed. Full Web regression is tracked separately and must finish before reporting all tests passed.
- This is a frontend form/save boundary test, not a live supplier billing or VPS traffic test. No real provider configuration was changed.

Full Web regression: 29 files / 271 tests passed in 157.07 seconds; production build passed. Existing large shared-chunk warning remains. Log: `/tmp/provider-time-web-regression.log`.
