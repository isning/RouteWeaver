# Bounded server diagnostic cancellation decision

Base: `6742d04`. This closes the concrete functional DOM remainder behind the
page matrix's vague “other nested operational decisions” label, not every server
operation or node enforcement scenario.

## Red → minimal correction → green

The real `ServersPage` journey opens a host, its connection diagnostics, and the
selected running diagnostic result. Its actual cancellation alertdialog did not
name the selected target. The new target assertion failed against unchanged
production source: the dialog contained only “取消这次测试？” and general consequences.
The sole product change names the target and diagnostic kind in the existing
confirmation title. Existing consequence text, mutation endpoint, status logic,
confirmation implementation, defaults, and execution behavior are unchanged.

`diagnostic-cancel-context.dom.test.tsx` establishes four controlled-HTTP cases:
- Selected target/consequence and two safe dismissals, zero writes and exact
  cancellation-opener focus, reached through the server page.
- Authoritative running → `cancel_requested`: request acknowledgement is not
  presented as stopped/completed.
- Authoritative undispatched queued → `cancelled`: an actual canceled response
  is presented as canceled, not incorrectly forced to remain pending.
- Rejected cancellation preserves the selected running job and error; explicit
  retry targets the same job and presents its authoritative acknowledgement.

These are real component/page wiring with synthetic HTTP, not live diagnostic
traffic or backend cancellation authorization evidence. No blanket assertion
that all accepted cancellations must remain pending is made.

## Verification

- Baseline RED: `/tmp/diagnostic-cancel-red.log`, exact missing-target assertion.
- Initial target/focus GREEN: `/tmp/diagnostic-cancel-green1.log`.
- Four focused cases GREEN: `/tmp/diagnostic-cancel-green.log`.
- Broader focused suite: **73/73 DOM tests across four files**, single worker;
  `/tmp/diagnostic-cancel-final.log`.
- Final application typecheck and final four-case rerun: respective logs
  `/tmp/diagnostic-cancel-ts.log`, `/tmp/diagnostic-cancel-final4.log`.
- Standalone strict browser-source typecheck:
  `/tmp/diagnostic-cancel-browser-ts.log`.
- Existing locked dependencies installed using `npm ci --ignore-scripts --offline`
  with the preexisting checklist-tools cache. Two incomplete-cache setup attempts
  did not run tests. One initial GREEN command had the wrong working directory;
  the corrected invocation passed. Initial test-source typecheck rejected the
  Playwright-only `exact` role option on RTL queries; corrected without weakening
  their string-name matching.

## Native browser remainder

`diagnostic-cancel-context.ui.spec.ts` adds one controlled 320px actual-App case:
server → selected diagnostic → named cancel decision, settled geometry, both
buttons in viewport, twice Escape/exact opener focus, no unexpected API request
or write. It is **UNRUN** here and must pass coordinator-authorized CI before
claiming native focus/geometry closure. No local browser, Go/native process,
remote CI, push, deployment or live diagnostic request was performed.
