# Continuous UI and UX review

Started from `bfdfec2` on 2026-11-10. This is a coverage ledger, not a declaration that every page, component or line has passed review. Previous acceptance records remain historical evidence; this review records newly inspected behavior separately.

## Review standard

For each page and decision, identify its user task, primary action, necessary identity, current state, material consequence and recovery path. Review the smallest supporting code path and test the public user seam. Additional prose or decoration must solve a demonstrated problem. Preserve values on failure and never substitute a successful request for observed application state.

The state checklist is: initial loading, populated, confirmed empty, filtered empty, failed read, stale/background refresh, disabled/pending edit, validation failure, failed save, uncertain result, cancel/reopen, keyboard/focus, narrow layout and reduced motion. A state may be inapplicable, but must not be assumed reviewed because a neighboring page passed.

## Page inventory and task purpose

All rows below still require a complete state and rendered-layout review. Entries identify scope rather than mark completion.

| Page or task | User purpose | Current review |
| --- | --- | --- |
| Login, invitation and account security | Enter the right account and recover safely | Not yet reviewed in this pass |
| Workspace navigation and mobile menu | Find a task without losing current work | Source inspection only |
| Subscriptions, profiles and outputs | Configure, review and deliver a client subscription | Not yet reviewed in this pass |
| Subscription sources | Import and accept owned connection options | Not yet reviewed in this pass |
| Collections | Combine sources without silently changing their meaning | Not yet reviewed in this pass |
| Rule resources | Inspect and accept owned rule versions | Not yet reviewed in this pass |
| Templates and presets | Reuse configuration and review updates | Not yet reviewed in this pass |
| Inbox | Read account messages and recover acknowledgement failures | Source inspection only |
| Published routes | Offer a versioned usable entry and route | Not yet reviewed in this pass |
| Forwarding paths | Select explicit ordered managed/external hops | Source and bounded DOM review; first correction below |
| Servers and core instances | Find a server, inspect observations and manage configuration | Source and existing focused DOM tests; diagnostics correction underway |
| Fleet tasks | Review targets, execute stages and inspect actual outcomes | Not yet reviewed in this pass |
| Users and access policy | Grant and inspect effective service access | Not yet reviewed in this pass |
| Service offerings | Define user-visible limits and permitted routes | Not yet reviewed in this pass |
| Change records | Inspect attributable operations | Not yet reviewed in this pass |
| Platform settings and backup | Configure shared services and perform explicit recovery | Not yet reviewed in this pass |
| Endpoint and legacy link configuration | Maintain stable connection and forwarding intent | Server picker slice only |
| Announcements and delivery settings | Compose in-app messages and inspect channel results | Not yet reviewed in this pass |

## Shared component inventory

The shared layers are `components/ui` (registry primitives), `ui-patterns` (task/form/navigation composition), `DataTable`, `components.tsx`, and the task-specific components imported by the pages above. A passing primitive test does not certify every composed use.

This pass inspected `DataTable`, `PageNavigation`, `ResourceToolbar`, `AppForm`/`AppField`, `PageBoundary`, task overlays and choice selectors at source level. Only the choice-selector change below has new behavior evidence. Pixel layout, contrast and touch geometry remain unreviewed here. The remaining shared and task components remain open; the implementation inventory is the tracked `web/src` tree, not a hand-maintained claim of exhaustive code review.

## Completed corrections and design reasons

### Distinguish same-named servers at the routing decision

- Defect: the server combobox showed only a display name, although different stable servers can have the same name. A user could not tell which server they were assigning to a hop.
- Decision: only duplicate names receive a separate secondary stable-ID line. Unique names stay concise. Stable IDs still disambiguate identical addresses and expose no connection credentials.
- Code: `ServerEndpointSelect.tsx`.
- Public-seam evidence: new regression fails before the change, then chooses both same-named owners and verifies only the selected owner's endpoints are offered. Existing focused endpoint/path tests pass (35 tests across three files).
- Not claimed: actual desktop/narrow screenshots, production-node validation or whole-page acceptance.

### End open pickers when their task becomes disabled

- Defect: disabling a choice trigger did not end its already-open popup; options could remain active while the surrounding task was read-only or pending.
- Decision: a disabled transition closes the current popup and clears only its temporary search. Existing selected values remain. Option selection, clear and freeform creation also honor the disabled state. Re-enabling does not reopen a previous interaction.
- Code: `ui-patterns/choice-select.tsx`.
- Public-seam evidence: separate single/multi-choice regressions fail before each fix and pass after. They verify closure, retained values, one close/blur notification, fresh search on explicit reopen and subsequent normal editing. All 11 choice-selector tests pass.
- Not claimed: native-browser focus/layout acceptance. The native Chromium launch in this workspace was blocked before UI assertions; browser security was not weakened.

## Current verification boundary

Focused tests, strict TypeScript and production build pass for these slices. Broader regression and exact-commit CI are separate checks. They do not establish visual quality or comprehension. No deployment, live-node operation, production data change or historical quota decision belongs to this review.
