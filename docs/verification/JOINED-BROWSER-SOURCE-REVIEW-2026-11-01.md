# Independent E09/E13 browser source review

Reviewed author commits `e225b03bd1eca856b93d438610caa95cf1580b86`
(E09) and `2bd8ead131b64a0bd2517e1b1f7545a8abb2a050` (E13),
both based on `23650ca`. This is source/DOM review, not a browser run.

## Standards and reliability

One concrete E09 measurement defect: `fits()` read a task's bounding box as
soon as it became visible, while the actual TaskSheet/confirmation entrance
transition could still be running. This is the same unsafe measurement order
observed in CI4 history geometry. The test now calls existing bounded
`settledTask()` before measuring. The document and task width bounds are
unchanged; no sleeps, animation disabling, fixture response changes or product
edits were introduced.

E09 now also observes browser-origin API requests after authenticated entry:
no non-GET/HEAD requests through download and canceled rotation, then exactly
one POST for the selected output's rotation through close/reopen. This makes
the no-write/exact-target contract explicit in addition to unchanged feed bytes.
The ledger records method/path only, not tokens, credentials or bodies.

## Spec and selector review

- E13 labels, dialog title, checkbox, saved-draft status and `.key-value`
  current-link selector match `SubscriptionOriginSettings.tsx` and `KeyValue`.
  Write/refresh listeners are installed before actions. Inputs remain disabled
  during mutations; subsequent fills wait on real actionability. All eight
  expected browser writes retain exact status/order assertions. The other
  authenticated context creates actual stale revisions; no fulfilled routes
  or backend simulation were added. No concrete E13 defect identified.
- E09 selectors match `Subscriptions.tsx` and the actual confirmation title,
  description and action. Scoped access and alertdialog roles avoid duplicate
  Close controls. Menus use ArrowDown; page actions use bounded Tab traversal.
  The actual same-origin `<a download>` remains keyboard-activated, downloaded
  bytes must equal the owner's published bytes, and Escape must return to the
  exact Get subscription opener. Rotation's automatically opened access task
  is closed before reopening through that opener.
- The actual isolated normal CLI fixture, invited ordinary account, legacy
  configured service grant, selected old-link 404, replacement byte equality,
  sibling and foreign-account invariants remain intact. Legacy grant coverage
  is not managed runtime enforcement. E13 custom domains are only reserved
  draft strings; no external DNS/HTTPS verification is claimed.

## Checks and limits

Exact-lock `npm ci --ignore-scripts --offline` completed. Explicit strict
TypeScript including both browser entrypoints passed (normal app tsconfig does
not include `tests`). Application typecheck passed. Discovery found four cases
(two widths per journey), not executions. Two existing actual-component DOM
suites, `subscription-origin.dom.test.tsx` and `task-experience.dom.test.tsx`,
passed **15/15**, single-worker configuration. `git diff --check` passed.
Initial attempts used nonexistent helper-test paths and a TypeScript CLI without
`--ignoreConfig`; those failed setup commands are not counted as tests.

The source-visible measurement risk was corrected without running a browser;
no runtime red/green is claimed. All four new browser cases remain UNRUN until
coordinator-authorized CI. This pass launched no browser, CI, push or deployment.
