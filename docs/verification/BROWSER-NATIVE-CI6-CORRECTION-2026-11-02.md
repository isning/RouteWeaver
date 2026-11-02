# Browser/native CI6 explicit recheck correction

CI run **41382776457**, job **125076970710**, remote `3a370d2` / local `916bcd5`:
one required bridge case failed at its unchanged 90-second deadline, with zero
passed/skipped/flaky cases. Artifact **13113694403** binds the build to that
remote source and retains the actual browser accessibility snapshot.

## Observed failure boundary

The previous transport-constructor correction passed, and helper initialization
completed. The browser successfully logged in and opened the managed deployment.
It then waited for a nonexistent exact `查看修改并应用` button. No publication
request or bridge `apply` command had occurred. Thus this run provides no native
activation, same-identity observation, or stopped-instance acceptance evidence.
This is unrelated to the separately reviewed production terminal-custody changes.

The fixture deliberately creates its managed deployment before attaching its
first principal. Saving that draft records the diagnostic
`MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required`.
The later principal grant updates the effective IR, but the saved diagnostic is
not itself a new validation. The actual detail therefore shows `草稿需要调整`
and the exact `重新检查` action. The UI's explicit recheck is the correct way to
obtain a fresh validated review; silently clearing the stored diagnostic or
bypassing this action would weaken the journey.

## Test-only correction

The browser case now asserts that exact initial diagnostic and action, clicks
`重新检查`, and requires the real validation POST to return HTTP 200 with
`valid: true` before using the unchanged consent/publication controls. No API
mock, selector fallback, timeout extension or product change was introduced.

The real API companion now explicitly verifies the initial saved diagnostic,
then its existing If-Match validation and publication assertions. It passed
locally (410 ms body / 11.4 s harness). The existing server-validation DOM suite
passed all seven cases, including successful recheck clearing stale diagnostics
while preserving consent and fingerprint (4.50 s suite). Strict test-file
TypeScript and discovery of the one required native browser case pass.
Independent source review found no further concrete mismatch in remaining
publication, instance-dialog, status-label or technical-detail selectors. This
source review is not browser execution. Current-tree secret scan also passes.

Actual browser/native execution after this correction remains **UNRUN**, pending
an authorized new CI run. All positive native identity/absence assertions remain
unchanged. No local browser or native process was launched for this correction.
