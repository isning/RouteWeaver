# Fixed UTC+8 policy date reconstruction

Source-only candidate reconstructed from baseline `a1fbbc3`. Historical `e7f0714` bytes and historical test results are not evidence for this candidate.

## Source contract and change

- `internal/service/cycle.go` declares `time.FixedZone("UTC+8", 8*60*60)` and accepts the existing timezone aliases. No backend or timezone policy changes.
- `web/src/PolicyDateInput.tsx` previously copied policy wall-clock fields into browser-local dates. Local `setHours` can normalize a nonexistent local DST hour even though that hour exists in fixed UTC+8.
- The component now carries policy wall-clock values in UTC fields and explicitly configures the existing Calendar for UTC carrier dates. The displayed label and wire instant remain fixed UTC+8. Calendar today is shifted to the same carrier convention.
- Unchanged confirmation retains the exact original RFC3339 string, including offset and up to nine fractional digits. Intentional edits retain existing millisecond serialization behavior. Validation, date limits, clear/cancel behavior and shared NumericInput are unchanged.

## Regression source and verification boundary

The existing public UI seam is PolicyDateInput: displayed value, calendar selection, time field, confirmation/cancellation, and onChange/onPendingChange output. Added cases cover New York one-hour gap/overlap dates, Lord Howe half-hour gap/overlap dates, exact unchanged nanosecond strings, changed calendar days, time editing, reverting and cancel/reopen.

All behavior execution is UNRUN under the current source-only restriction. No red/green result, typecheck, lint, formatter, build, browser, server or timezone-matrix pass is claimed. The original dependency tree is not materialized; Calendar timeZone prop compatibility with locked react-day-picker 10.0.2 needs authorized typechecking/runtime verification. No new dependency is introduced. Independent source review checked the carrier conversion and unchanged-string path. The locked day-picker tarball is absent from the local npm cache; its timezone integration remains unverified.

When execution is authorized, run the existing policy-calendar.dom.test.tsx and policy-control-settlement.dom.test.tsx tests with one worker in separate processes under TZ=UTC, TZ=America/New_York and TZ=Australia/Lord_Howe, then typecheck and the project aggregate gate. Run the new regressions against baseline to establish failing-before evidence. Browser checks should cover keyboard selection, displayed month/day, today highlighting near the UTC+8 date boundary, and cancel/reopen in those zones. Tests were authored before their corresponding implementation edits, but were not executed.
