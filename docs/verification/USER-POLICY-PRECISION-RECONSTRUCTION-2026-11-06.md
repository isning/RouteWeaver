# UserPolicy numeric precision: source reconstruction

## Identity and scope

This is a new reconstruction on baseline `a1fbbc301378e47489660791e68f8c50fcf2b93f` (v88), not a recovery or byte-identical copy of the unavailable historical v109 commit `23e8eb918f75c09fdff2354e71cef7096f7924f8`.

Production edits are limited to `web/src/UserPolicyEditor.tsx`. Test source is in `web/src/policy-entitlement-edit-intent.dom.test.tsx`. No shared controls, backend, billing arithmetic, dependencies, deployment or published artifacts change.

## Contract traced in source

- `ByteQuantityInput.tsx` stores bytes, displaying GiB using 1073741824 and Mbps using 125000 bytes per second. It emits its Number conversion before notifying its caller of raw input. `numeric-input.tsx` has the same ordering for unscaled input.
- `PolicyFields.tsx` already uses nonnegative safe-integer rules for overrides and fixed days. This change does not introduce a new business maximum. Backend `internal/service/cycle.go` uses integer fields and validates monthly days 1–31 and fixed cycles 1–3660. Backend remains authoritative for business rules.
- `internal/store/effective_policy.go` rejects negative overrides; `internal/service/effective.go` distinguishes absent override/inheritance from explicit zero. No inheritance or unlimited semantics change.
- The old raw-input check compared `Number(text) * scale` against an already rounded form value. For example, `17.0000000000000001` can compare equal to 17, losing the entered fractional intent.

## Changes

Edited raw text for quota, online IP count, logical-stream count, entry rate, monthly day and fixed-cycle days is parsed as a decimal coefficient and exponent using exact integer arithmetic. Only nonnegative safe integers in stored units settle. Trailing decimal zeroes and scientific notation remain supported. Nonzero sub-byte, hidden fractional and unsafe values stay pending and cannot reach preview until corrected or explicitly discarded.

Representable scaled values are written exactly into form state if the control's floating multiplication differs, e.g. 0.000984 Mbps means 123 bytes per second. Parsing rejects raw text over 4096 characters before regex/BigInt work; this is a parser-resource guard, not a new quota/rate maximum. Exponents are normalized and lexically bounded before Number conversion; no BigInt exponent or arbitrarily large power of ten is constructed. BigInt conversion errors leave the edit pending. This is not a denial-of-service proof for the shared controls, which still receive the raw text first.

Parsing occurs only on edits, never when mounting, opening an accordion, reading current values or submitting untouched fields. Stored values are not recreated from the rendered unit conversion. Existing controls, stepping, clear/required validation, explicit discard, draft retention and latest-version review remain in place. When exact settlement corrects floating residue, the existing controlled component can normalize the raw spelling (for example, removing trailing zeros); numeric intent, not every valid spelling, is preserved. For invalid raw input the control may already have emitted a rounded current value. Explicit discard keeps the current value named in the visible notice, not necessarily the original saved value; no preview is permitted before correction or this deliberate discard. The existing pending-input notice and recovery action are reused; no permanent verification banners are added.

## Regression source and verification status

The approved seam is the rendered editor and its HTTP fetch boundary. Tests use real controls/form/review with fetch responses stubbed; they do not import the private parser. The first hidden-fraction regression was written before the production change, but no red/green execution is claimed.

Added source covers:

- Hidden precision in all six raw inputs; exact correction and preview payloads.
- Sub-byte GiB and Mbps rejection; one byte in each unit; 29 bytes/second conversion.
- Unsafe integers, scientific notation, huge positive exponents, oversized pastes and exact zero.
- Exact floating-residue settlement and the resulting controlled display normalization; explicit discard of hidden precision retains the visibly reported current value.
- Canceling close/discard while preserving raw text, then explicit raw-input discard.
- Untouched safe stored bytes whose Mbps display loses decimal information.
- Clear/required validation, stepping, unlimited zero and disabled inheritance.
- Latest-context read invalidation by hidden-precision editing after a baseline conflict (extending the existing late-response test). Existing complete draft/review/apply regression source remains unchanged.

Performed: source inspection and `git diff --check` only. These are not runtime behavior evidence.

**UNRUN:** all Vitest tests, TypeScript, lint, build, browser/visual checks, Go tests, backend integration, full verification harness and deployment checks. Execution was intentionally restricted to Git/Python/text tools; no Node/npm/Go/gofmt, browser, server, install, network, push or deploy was performed. No pass counts, full-system acceptance or equivalence to the lost historical revision are claimed. Independent source review and eventual executable verification are still required.
