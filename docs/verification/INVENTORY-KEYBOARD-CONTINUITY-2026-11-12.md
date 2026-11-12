# Inventory keyboard continuity

## Verified gaps and bounded changes

An empty-result Clear search action in Users, Nodes, Services and legacy route configurations removed its own focused button and left focus on the document body. Both handlers now clear through the same owned search ref and synchronously return focus to that still-mounted input. SearchField's inline clear behavior and Users retry ownership guards remain unchanged.

In Services, a toolbar refresh can rename a row outside the active query while its independent editor is open. The opening context, current draft and page remain intact, but Cancel previously had no eligible original opener to restore. Services now explicitly supplies its search field as a close-time fallback, threaded through both loading/error and ready editor sheets. An eligible original opener still wins. Existing task, newer-focus, active-dialog, disabled, hidden/inert and visibility guards apply; unrelated dialogs have no default fallback. No global selector, timer, production test-only attribute, page reset or policy behavior was added.

## Evidence

The expanded original-source regression recorded six intended failures and five passing controls. The search-only change left only the two service departed-opener failures; both changes passed all eleven original tasks. Final coverage adds loading/error/late-opening, retained dirty draft and cancelled discard, plus overlay lifecycle and focus-ownership negatives: 14 inventory cases and 23 shared-overlay cases.

The immutable five-file candidate `ee74e673d65d11bdf2d4098e268fb4f1bc3056030b5fe711366780b8d4445e94` received independent source/test review without actionable findings. All five integrated file hashes matched. Integrated focused execution passed 181 tests in twelve files with one worker (39.33 seconds), followed by explicit typecheck and production build. This includes existing inventory, table, toolbar, service submit and shared-focus controls.

The whole-row-absence case is a supplementary changed-response control, not a claim that the UI exposes service deletion. Same-ID rename out of an active filter is the ordinary task establishing the missing-opener defect.

## Remaining verification

These are DOM/HTTP-read-boundary results, not native keyboard, animation, viewport, screen-reader or pixel acceptance. Tests cover explicit hidden/inert/aria-hidden ancestors and target style hiding, not every CSS-hidden ancestor combination. Whole frontend regression and bounded mobile/desktop native evidence must be reported separately. No writes, real data, deployment or Go behavior is involved.
