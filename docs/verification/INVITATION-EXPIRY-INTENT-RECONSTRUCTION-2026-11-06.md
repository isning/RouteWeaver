# Invitation expiry intent reconstruction, 2026-11-06

## Scope and source findings

This is a bounded source reconstruction on saved integration commit
`4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`, not recovery of the missing
historical v114 commit or evidence that its original implementation ran.

`internal/httpapi/admin.go` decodes `expiresInHours` as an integer, assigns
24 when omitted/zero, and rejects values outside 1–168. The invitation form
starts at 72. These are separate, preserved decisions. Previously the form used
NumericInput's numeric emission: incomplete input did not update the form, and
binary floating-point rounding could erase a fractional tail before its integer
validator ran. Expiry-only partial input could therefore escape dirty tracking.

## Candidate change

- Keep expiry as raw text in the existing form and dirty comparison. Initial text
  is `72`; exact restoration to it clears expiry-only dirty state.
- Reuse `exactDraftInteger` to validate decimal intent before conversion, both in
  field validation and immediately before the request. Its existing 256-character
  and three-digit exponent bounds apply; ordinary exact decimal/exponent integers
  remain accepted, including `7.2e1` and `+024.0`.
- Empty text omits the request property and has visible helper text explaining
  the backend's 24-hour default. Whitespace, zero, partial values and fractions
  are not treated as blank. No client-invented default replaces the backend one.
- The bounded local input adapter retains the spinbutton role, numeric keyboard
  hint, min/max/current-value semantics and ArrowUp/ArrowDown integer stepping.
  Stepping clamps valid values at 1 and 168; either arrow on blank starts at 1.
  Invalid nonblank input is left untouched by either arrow and has no fabricated
  aria-valuenow. No rounding/clamping or normalization happens on blur. Existing
  numeric adapters coerce invalid drafts during stepping and therefore are not
  compatible with this requirement; the parser is reused, not duplicated.
  The shared NumericInput is unchanged.
- Pending submission, duplicate guards, explicit discard, navigation protection,
  failure preservation and stale-task ownership remain in the existing task.
  Invitation acceptance, account/security uncertainty and backend auth are not
  changed. This does not resolve ambiguous invitation-creation outcomes.

## Regression source and verification limits

Public seam: `AdminPage` invitation dialog, accessible inputs/actions, navigation
warning and captured HTTP request. The fetch boundary is stubbed; no private
component state is tested. Added cases cover initial/default/blank/bounds,
exact exponent/decimal integers, fractional precision tails, malformed and
out-of-range input, failure preservation, partial-only discard and exact revert.
Arrow-key source cases cover default increment/decrement and dirty restoration,
bounds, exact exponent input, blank, malformed/fractional/out-of-range drafts,
spinbutton semantics and disabled pending input. Existing pending/stale-task
lifecycle regression sources remain unchanged.

Tests were authored before the corresponding implementation, but **red/green is
UNRUN**. By the source-only instruction, no Node/npm, Go/gofmt, browser, server,
network, installation, push, deployment or upload was performed. Type checking,
formatting, lint, DOM tests, backend tests, build, aggregate verification and
rendered desktop/narrow/accessibility behavior are **UNRUN**. Source inspection
and `git diff --check` are not substitutes. No full acceptance claim is made.

When execution is authorized, run the focused invitation lifecycle suite with
one worker, the account/security acceptance suites, type/lint/build checks and
the required serialized integration gate. Inspect the rendered expiry/error/help
and discard focus on desktop and narrow viewports before acceptance.
