# Disabled date lifecycle component fixture

`../disabled-date-lifecycle.ui.spec.ts` renders the real `AppForm`, `AppField`,
`PolicyDateInput`, Radix popover and production CSS. The test-only owner changes
its disabled prop and immediately re-enables after the picker reports closing.
It does not establish that every production owning task reaches this state.

The compiled fixture is served using Playwright request fulfillment at a private
synthetic origin. Its catch-all request handler rejects and records any other
origin or non-GET method, and the test asserts none occurred. It introduces no application endpoint or backend mutation.
The suite retains the normal sandbox and real CSS motion. Native animation events
bound the retained-exit inspection; no forced presence, changed animation duration,
paused animation or mock accessibility implementation is used. DOM `inert`,
`aria-hidden`, disabled controls and native focus attempts cover the retired UI;
this is not a screen-reader certification.

The test checks the unconfirmed draft cannot change the exact stored RFC3339
string, a subsequent unedited confirmation submits that same string, and delayed
exit cleanup does not take focus away from a newer task. The owner prop change is
driven with a DOM button click to avoid an unrelated outside-pointer dismissal.

Validation in the restricted workspace: fixture Vite build, explicit strict
TypeScript check (fixture and spec), and Playwright discovery passed. The existing
local host-socket startup restriction was not retried or bypassed. Native results
must be checked for the exact source in CI and recorded in the continuous UX
review ledger. Authored coverage alone is not a native pass or a
failing-before-passing production defect claim.

Run through the existing Chromium project on an authorized host:

```sh
npx playwright test --project=chromium tests/disabled-date-lifecycle.ui.spec.ts
```
