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
| Templates and presets | Reuse configuration and review updates | Publication-target and extraction recovery reviewed; rendered states open |
| Inbox | Read account messages and recover acknowledgement failures | Source inspection only |
| Published routes | Offer a versioned usable entry and route | Not yet reviewed in this pass |
| Forwarding paths | Select explicit ordered managed/external hops | Source, bounded DOM and captured layout review; corrections below |
| Servers and core instances | Find a server, inspect observations and manage configuration | Source and focused DOM tests; diagnostic receipt correction below |
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

### Preserve busy state for custom task lifecycles

- Defect: `ActionButton` overwrote an explicitly supplied `aria-busy` when its separate `pending` prop was omitted. The authenticated configuration-bundle download is one affected caller: the action was disabled but its ongoing work was not exposed through the requested accessibility state.
- Decision: the built-in pending lifecycle still forces busy; otherwise preserve the caller's native busy value. This does not add a second loading message or alter click behavior.
- Public-seam evidence: both ordinary buttons and link-composed actions fail before the fix and pass afterwards, including clearing busy on completion. Eight focused button/target-size tests pass.

### Keep accepted diagnostics inspectable through failed reads

- Defect: submitting a diagnostic retained only its ID, while the details panel required the asynchronously refreshed list to contain its record. A delayed, failed or incomplete list produced a blank details sheet even though a job had been accepted.
- Decision: retain the accepted receipt in the mounted task, distinguish it from current list observations, and keep a read-only refresh available. Retrying explicitly cancels the prior query owner, including a hanging initial read with no cached data. Late responses cannot displace the replacement read. No second test is submitted.
- Identity and freshness: refreshed records must match the confirmed request and arrive after the receipt's cached-list boundary. A confirmed terminal result cannot become active again because of an older list state. Missing or mismatched results retain the confirmed target and cancellation ID. Receipt retention is not persistence across page reload.
- Public-seam evidence: ten new full-panel tests cover successful submission/reconciliation, delayed/failed/initially hanging reads, explicit retry, late results, missing/wrong host/target/limits, stale cached queued records and retained terminal results. Four focused diagnostic suites pass (27 tests), with red-before-green evidence for the original blank panel and all three review-discovered recovery edges.
- Independent review found and drove correction of disabled retry, cached receipt regression and initial-read deduplication. No live diagnostic traffic or visual acceptance is claimed.

### Preserve the chosen shared-template publication target

- Defect: when a catalog refresh removed the selected template, publication re-resolved that selection as absent and generated a new template ID. The same reviewed draft could silently change from updating an existing template to creating another one.
- Decision: retain the explicit selected ID and readable identity. An unresolved or missing existing target blocks publishing, preserves the reviewed draft, and exposes catalog recovery. Creating a new template remains an explicit selection.
- Public-seam evidence: disappearance regression fails before the fix; missing and failed-refresh recovery cases preserve inputs and publish only the original ID/version after authoritative recovery. Four focused template suites pass (49 tests), strict TypeScript passes, and an independent source review found no blocking issue.
- No whole-page or visual acceptance claim.

### Keep an emptied JSON draft editable

- Defect: the extracted shared-structure textarea was rendered only while its string was truthy. Select-all/delete removed the editor and its focus, preventing ordinary replacement typing.
- Decision: distinguish not-yet-extracted (`null`) from an intentionally empty editing draft. Preserve the same editor and review reset while empty; publishing remains blocked until nonempty valid content is reviewed. Explicit source, type or publication-location changes still reset extraction.
- Public-seam evidence: new regression fails before the change, then verifies retained DOM/focus, empty/invalid input rejection before HTTP, correction and explicit re-review, plus source/type reset. Twenty-six surrounding tests and strict TypeScript pass.

### Distinguish unavailable extraction sources from empty catalogs

- Defect: the publication dialog received only `data || []` for profile/collection sources. Read failures appeared as empty choices without an explanation or recovery action.
- Decision: preserve the full query state for the active template kind. Loading, paused, failure, confirmed empty and missing selected identity are separate. Extraction requires a confirmed available source; an already extracted reviewed draft remains independently publishable when a source list fails. Retry keeps the entered name, JSON and review.
- Public-seam evidence: failed-source regression first fails, then six new catalog cases cover retry, both template kinds, retained reviewed drafts, missing source, pending versus empty and paused/resumed reads. Thirty-two surrounding tests pass; independent review re-ran all six new cases successfully. TypeScript and build pass.
- Boundary: shared `api.list` historically normalizes wire `null` to `[]`; this change does not redefine that decoder. Pending initial reads show a loading state, not an ineffective retry that would reuse the same pending request.

### Group target-instance identity and observations

- Observed defect: synthetic CI screenshots from run `42851399972`, artifact `13781261854` (`browser-diagnostics-2-of-4`), show the forwarding-path detail's target instance rendered as adjacent miniature columns. At 390px the server/core/listener names and `未设置持续服务授权` break into short fragments while the technical-details control retains a wide single line. The desktop capture shows the same ungrouped structure less severely. Evidence files: `setup-path-awaiting-principals-390.png` and `setup-path-awaiting-principals-1440.png` under the forwarding-setup test results. Raw artifacts remain private and are not repository content.
- Cause and decision: `InstanceObservation` returns multiple semantic blocks, which became direct flex siblings of the identity heading. The route-detail caller now supplies an explicit observation wrapper and a named target group. Identity, observation state, authorization and technical details stack in reading order at both widths; full labels remain, with wrap-safe sizing and separators between instances. No change to the shared observation component or its other callers is needed.
- Public-seam evidence: new DOM regression fails before the named grouping exists, then verifies server/core/listener identity, actual unregistered state, authorization status, refresh and technical-detail access in the same target group without mutation. The existing real-backend forwarding journey now checks vertical ordering of those groups and captures `setup-target-instance-grouped-1440.png` / `setup-target-instance-grouped-390.png` with unobscured controls.
- Verification boundary: the old CI job confirms both forwarding-setup journeys completed before the job was cancelled; that run is not an all-green gate. All 54 focused policy-editor DOM tests, application/spec typechecks and browser test discovery pass locally. Updated browser execution and visual assessment of the corrected pixels remain pending CI. No live-node action or runtime application was performed.

## Rendered-evidence follow-up

`web/tests/server-path-workspace.ui.spec.ts` now adds same-named, same-address server journeys at 1440 and 390 pixels. The real isolated backend creates synthetic records; keyboard selection, explicit owner replacement, endpoint filtering and persisted draft identity are asserted. Capture points show the two identity choices, retained first server and second server's endpoints. No fleet task or runtime application is requested.

Application/spec TypeScript checks and discovery pass (four tests in that file, two newly added). Browser execution and actual pixel review remain pending CI. The supported cloud-browser attempt could not reach the local demo URL despite the launch session reporting ready; a separate command also could not reach that session. The exact isolation cause is unconfirmed. The demo was stopped, and no public tunnel or security bypass was used.

## Current verification boundary

Focused tests, strict TypeScript and production build pass for these slices. Broader regression and exact-commit CI are separate checks. They do not establish visual quality or comprehension. No deployment, live-node operation, production data change or historical quota decision belongs to this review.
