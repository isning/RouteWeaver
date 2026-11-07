# Rates exact factor reconstruction, 2026-11-06

## Identity and scope

New candidate reconstructed from `a1fbbc301378e47489660791e68f8c50fcf2b93f` (retained v88 source). This is not recovery of the lost v109 commit `23e8eb918f75c09fdff2354e71cef7096f7924f8` and does not inherit its verification claims.

Only Rates factor entry and its regression source change. UserPolicy scaled fields, shared numeric controls, server validation, persisted rate revisions, and billing arithmetic are unchanged. There is no publication or deployment in this candidate.

## Source evidence and implementation

- `internal/service/cycle.go`: `RateScale = 1_000_000`; `Rate.Micros` is `int64`. `WeightedBytes` retains its existing integer multiplication and upward rounding of weighted bytes.
- `internal/store/billing.go`, `SetRate`: existing accepted micros range is inclusive 0 through `1000 * RateScale`. Rate revisions remain immutable.
- `internal/httpapi/admin.go`: `/rates` POST decodes the existing rate contract and calls `SetRate`. UI checks do not replace backend validation.
- Baseline `web/src/Rates.tsx` used `Math.round(values.factor * 1000000)`. Thus `0.0000004` could submit zero, and conversion to Number could erase digits in `1.0000000000000001` before any precision check.
- New local conversion reads the complete decimal spelling, separates sign, digits and decimal exponent, removes insignificant zeros, and requires exact integer micros before converting the bounded integer string to Number. There is no fractional rounding. Zero remains valid. Range limits come from the existing backend, not a new business rule.
- The converter expands at most ten digits and rejects an unsafe exponent shift before string expansion. Very large positive or negative exponents cannot allocate an exponent-sized string or silently become a free rate. Work still scales with the submitted text length; no arbitrary text-length business limit was introduced.
- Supported notation: ASCII decimal digits, optional leading sign, decimal point (including `.5` and `1.`), and optional signed `e`/`E` exponent. Insignificant trailing zeros are accepted. Whitespace, localized separators, hexadecimal, Infinity and incomplete notation are not accepted. Exact zero, including negative zero, remains zero.
- The existing NumericInput and numeric form value remain, including spinbutton semantics and ArrowUp/ArrowDown stepping. Its onInputText callback separately captures raw spelling in a ref and display/dirty state. Field validation runs on that raw-input trigger; mutation capture checks the exact spelling again before sending. This preserves incomplete input, excess precision and spelling through validation errors, dirty detection and failed saves without changing shared NumericInput. NumericInput still applies its existing finite-number and range constraints.
- Error text supplies either a valid-number request, the existing range, or the exact increment plus a correction action. No permanent explanatory banner was added.

## Public regression seam

`web/src/rate-factor-precision.dom.test.tsx` mounts the real RateSettings, form, query and UI providers; only fetch is stubbed at the HTTP boundary. It observes visible fields/errors/dialogs and outgoing rate JSON, not private parser calls. This is the assigned UI user-task/fetch seam, not an added private-unit seam.

The first regression was authored before the implementation, but red/green execution was prohibited and is not claimed. Remaining source cases cover:

- Sub-millionth rejection, preserved draft, correction and exact one-micro POST.
- Explicit zero, default one, upper bound, six-place decimals, redundant zeros, exponent notation, and a long mantissa with compensating exponent.
- Hidden precision beyond Number accuracy, nonintegral micros, huge exponents, range errors, incomplete and blank input without a POST.
- Raw-only changes that would previously compare equal after Number conversion still require a discard decision and survive cancellation.
- Failed-save preservation of route, raw factor and start time; editing/blur does not resubmit; an explicit retry posts the corrected integer.
- Untouched default factor saves without re-entry; spinbutton stepping and revert-to-default dismissal remain.

Existing `web/src/rate-edit-continuity.dom.test.tsx` remains unchanged and is part of the required future focused verification.

## Verification status

- Source inspection and `git diff --check`: performed; whitespace check passed.
- Focused DOM regressions: **UNRUN**.
- Existing continuity tests, TypeScript, formatting/lint, full Web and Go suites, aggregate verification harness: **UNRUN**.
- Browser, server, real HTTP/storage integration, desktop/narrow viewport rendering, keyboard/screen-reader acceptance and human content review: **UNRUN**.
- No Node, npm, Go, gofmt, browser, server, network, install, push or deploy execution was used.

This is a source candidate, not a passing test report or a ready-to-merge claim. Future authorized verification must run the new precision and existing continuity suites with one worker, TypeScript and the applicable aggregate gates. Independent review is pending at candidate handoff.

## Follow-up source review: quota example

The independent source review identified that the example sentence displayed raw input as a billable amount, including incomplete or unrepresentable drafts. The follow-up retains the raw input in the control but renders the example only after the same exact parser accepts it, using canonical `micros / 1_000_000`. Invalid input instead gets a short neutral correction request and does not reuse the previous valid amount.

Five added public UI cases cover incomplete notation, precision hidden by Number conversion, sub-millionth input, an out-of-range long mantissa, and correction to a legal exponent with a normalized example. They also assert that preview editing does not POST. These regression cases were authored before the copy implementation; execution remains **UNRUN**, with no red/green claim. `git diff --check` passed for this follow-up. No previously listed execution restriction or verification limitation has changed.
