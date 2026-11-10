# Continuous UI and UX review

Started from `bfdfec2` on 2026-11-10. This is a coverage ledger, not a declaration that every page, component or line has passed review. Previous acceptance records remain historical evidence; this review records newly inspected behavior separately.

## Review standard

For each page and decision, identify its user task, primary action, necessary identity, current state, material consequence and recovery path. Review the smallest supporting code path and test the public user seam. Additional prose or decoration must solve a demonstrated problem. Preserve values on failure and never substitute a successful request for observed application state.

The state checklist is: initial loading, populated, confirmed empty, filtered empty, failed read, stale/background refresh, disabled/pending edit, validation failure, failed save, uncertain result, cancel/reopen, keyboard/focus, narrow layout and reduced motion. A state may be inapplicable, but must not be assumed reviewed because a neighboring page passed.

## Page inventory and task purpose

All rows below still require a complete state and rendered-layout review. Entries identify scope rather than mark completion.

| Page or task | User purpose | Current review |
| --- | --- | --- |
| Login, invitation and account security | Enter the right account and recover safely | Uncertain-login recovery and neighboring DOM regressions reviewed; rendered states open |
| Workspace navigation and mobile menu | Find a task without losing current work | Source inspection only |
| Subscriptions, profiles and outputs | Configure, review and deliver a client subscription | Captured profile summary, source reads and subscription copy lifecycle reviewed; remaining publication/output states open |
| Subscription sources | Import and accept owned connection options | Not yet reviewed in this pass |
| Collections | Combine sources without silently changing their meaning | Source-catalog refresh/pause states and retained drafts reviewed; other states and rendered layout open |
| Rule resources | Inspect and accept owned rule versions | Source and 88 focused recovery tests reviewed; no new reachable defect, rendered states open |
| Templates and presets | Reuse configuration and review updates | Publication-target and extraction recovery reviewed; rendered states open |
| Inbox | Read account messages and recover acknowledgement failures | Open-sheet refresh recovery and obsolete acknowledgement errors reviewed; remaining states and rendered layout open |
| Published routes | Offer a versioned usable entry and route | Captured authorization attribution and nested catalog recovery reviewed; other states open |
| Forwarding paths | Select explicit ordered managed/external hops | Source, bounded DOM and captured layout review; corrections below |
| Servers and core instances | Find a server, inspect observations and manage configuration | Source and focused DOM tests; diagnostic receipt correction below |
| Fleet tasks | Review targets, execute stages and inspect actual outcomes | Re-preview ownership and acknowledgement recovery reviewed; remaining states and rendered layout open |
| Users and access policy | Grant and inspect effective service access | List empty/filter source inspection only; decisions and rendered states open |
| Service offerings | Define user-visible limits and permitted routes | List empty/filter source inspection only; decisions and rendered states open |
| Change records | Inspect attributable operations | Source/list regression slices reviewed; remaining states open |
| Platform settings and backup | Configure shared services and perform explicit recovery | Backup preview replacement reviewed; settings source-only, other states open |
| Endpoint and legacy link configuration | Maintain stable connection and forwarding intent | Server picker and inventory submit-recovery slices reviewed; other states open |
| Announcements and delivery settings | Compose in-app messages and inspect channel results | External test identity and outcome recovery reviewed; other states open |

## Shared component inventory

The shared layers are `components/ui` (registry primitives), `ui-patterns` (task/form/navigation composition), `DataTable`, `components.tsx`, and the task-specific components imported by the pages above. A passing primitive test does not certify every composed use.

This pass inspected `DataTable`, `PageNavigation`, `ResourceToolbar`, `AppForm`/`AppField`, `PageBoundary`, task overlays and choice selectors at source level. New public-seam evidence covers choice disabling, caller-owned busy state, opt-in inventory submission recovery and uncontrolled pagination. Task-specific corrections and their limits appear below. Actual pixel observations are limited to the identified CI captures; contrast and touch geometry have not received a comprehensive review. The remaining shared and task components remain open; the implementation inventory is the tracked `web/src` tree, not a claim of exhaustive code review.

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

### Bind external notification tests to the reviewed destination

- Defect: the editor preserved its initial settings baseline while background reads could replace the saved email recipients or Webhook. Test confirmation named the old baseline, but the server used current saved settings. A confirmed action could therefore reach a different destination.
- Decision: keep editable drafts separate from authoritative saved settings. External test decisions capture the saved revision, block unresolved reads and saving, and require fresh confirmation after a target change. The server checks that revision in the enqueue transaction; existing dispatch revision checks prevent a later settings change from retargeting queued work. Optional API revision preserves existing clients' explicit current-settings contract.
- Recovery and ownership: cancellation, duplicate activation, departed tasks and late responses do not revive a decision. Conflict refreshes settings without resending. A cancelled delivery has its own warning and asks for renewed review; it is neither a queued-success claim nor proof that no previous delivery attempt occurred.
- Evidence: saved-target and stale-revision regressions fail before the fix. Ninety-one focused notification tests passed before the six-outcome feedback matrix was added; the final affected two-file run passes 63 tests. Independent review reran 57 cases and identified the cancelled-result feedback correction. Both complete Go service/HTTP packages pass, and TypeScript passes. All deliveries use synthetic transports. Actual external delivery and rendered-layout acceptance are not claimed.

### Recover password login after an uncertain response

- Defect: invitation acceptance reconciled the current session after a lost or malformed response, but ordinary password login did not. A successful server cookie could leave the user on the login form and invite another password/verification-code submission.
- Decision: uncertain password-login responses now use the same read-only session check. Only the authoritative session read selects the account. Definite credential rejection keeps the inputs without an extra request; an unavailable session read offers read-only reconnect without replaying credentials. Invitation-specific wording and administrator-token behavior remain unchanged.
- Evidence: the lost-response regression fails before the change. Eleven new cases cover lost bodies/responses, malformed or incomplete sessions, six definite rejection statuses, preserved password/code input and failed-read recovery. All 159 focused account/session/mobile-navigation tests across eight files pass, along with TypeScript. This is synthetic DOM and source evidence, not a live-account or visual verification.

### Return invalid inventory submissions to a usable field

- Defect: the server, core and listener editors use a native form-owned Save button in the dialog footer. Invalid submission rendered field alerts but left keyboard focus at Save, away from the fields requiring correction.
- Decision: only InventoryEditor opts into task-owned submit-error focus recovery. After validation errors render, focus the first visible enabled invalid native control. Newer interaction, changed/closed task or outdated validation cancels recovery. Hidden/inert/disabled controls are skipped; specialized failure callbacks retain sole ownership. Existing dialog focus-reveal behavior handles scrolling.
- Additional task-lifetime finding: same-stack native submit then close/reopen before validation microtasks settle could run rc-form's latest callback against the reopened task. InventoryEditor now captures and consumes native submission ownership, clearing it on every committed task transition. This race was reproduced at the owner seam, not by ordinary sequential clicks; a moved focus alone still does not cancel a valid save.
- Evidence: all three actual invalid-editor cases fail before and pass after, asserting the exact first field. Twenty-seven new cases cover external footer, native keyboard-submit seams, hidden/disabled candidates, custom callbacks, newer interaction, close/reopen of the same entity and overlapping validation. Seventy-six focused form/inventory tests pass, including coordinator reruns; TypeScript passes. Independent source review found no blocker. Native-browser focus/scroll acceptance remains open.

### Keep a list on its confirmed visible page

- Defect: an uncontrolled table on page 3 visually moved to page 2 after a confirmed removal reduced its row count. Internal page state remained 3, so a later added record unexpectedly jumped the table back to page 3 without a navigation action.
- Decision: confirmed bounds changes commit the visible page for internally owned pagination. A still-valid page remains unchanged. Controlled parents retain ownership; passive refresh emits no page-change callback. Temporary loading rows and disabled pagination do not overwrite the remembered position. A confirmed local-filter clamp follows the same visible-page contract instead of silently restoring an earlier hidden page.
- Evidence: authoritative shrink/grow regression fails before and passes after. Five new cases cover the above boundaries; 33 focused table/history/navigation tests and TypeScript pass. Coordinator independently reran all five. Users/services empty-versus-filtered states and activity-list presentation were inspected without additional demonstrated defects. No browser-layout or full-page acceptance is claimed.

### Give selected platform entries an accurate connection summary

- Observed defect: the 390px first-profile screenshot from synthetic CI run `42851399972` showed a platform entry selected as the default destination, but emphasized `0 个有效连接`; the usable selected entry appeared only as a secondary `另有 1 个平台入口` sentence. The count covered materialized own connections, not every selected destination.
- Decision: when platform entries are selected, show equally weighted, separately scoped own-connection and platform-entry counts. Keep publication-time credential resolution as a separate fact. Entry-only, mixed and own-only configurations remain distinct; direct-only configurations keep their existing concise explanation.
- Read boundaries: pending, paused, background-refresh and failed catalog reads never show cached entry counts as confirmed availability. Missing selections remain visible. Unselected platform-catalog states do not displace an own-only/direct-only summary; the selector still retains its error and retry.
- Evidence: entry-only/mixed hierarchy and irrelevant-catalog regressions fail before their fixes. Focused profile/source suites, application/spec typechecks and browser discovery pass; coordinator independently reran the affected DOM files. The desktop/390px invitation journey now asserts equal visual weight and captures the full summary. Corrected pixels remain pending CI; the original screenshot establishes a content-hierarchy defect, not a routing failure.

### Let a cleared backup preview start a new inspection

- Defect: clearing inputs during a pending backup preview reset visible loading but retained the old inspection owner. After selecting a replacement file/password, the enabled validation button silently refused to submit until the abandoned request finished.
- Decision: explicit clearing retires both preview-ownership references as well as its visible inputs. A later explicit validation owns its exact replacement file/password; old completion cannot replace its preview, clear its pending state or expose a restore decision. Clearing does not abort a submitted server request or change restore-operation ownership.
- Evidence: the public DOM regression fails before the two-line fix. Four synthetic races cover obsolete success/failure both before and after replacement completion, exact submitted inputs, no automatic request, duplicate activation and fresh restore confirmation. Thirty-five focused backup tests and TypeScript pass; coordinator independently reran all four new cases. No real backup, restore or upload was performed, and no browser-layout claim is made.

### Restart conflicted notification editing only by explicit choice

- Defect: after a settings-save conflict, rereading the latest saved settings updated test-target identity but not the form's original baseline revision. Repeated Save remained conflicted; blindly rebasing the full-record PUT would overwrite concurrent untouched values.
- Decision: retain the local draft and offer `载入最新设置`. This makes a fresh read, then asks before replacing unsaved local edits and secret replacement/removal intentions. Cancel, failed reads and cancelled loading preserve the draft. Confirmation changes only local values/baseline; saving and any external test remain separate actions. This is an explicit restart, not a merge.
- Ownership and safety: a changed query identity/revision invalidates approval. Retired reads cannot replace a newer decision. Recovery and test-send confirmations are mutually exclusive. The new recovery read rejects incomplete required shapes before cache acceptance, and prepares all replacement values before any form reset; this does not claim comprehensive initial-query/domain validation.
- Evidence: initial conflict recovery and malformed-payload regressions fail before their fixes. Seventy-seven focused notification tests pass, with an independent 14-case recovery rerun and source review. Cases include old pending reads, immediate retry after cancellation, departed tasks, incomplete payloads, preserved secret intentions and a subsequent Save using the explicitly accepted revision. TypeScript passes; no actual settings mutation or external send was performed.

### Keep search Enter separate from clearing the selected resource

- Observed failure: supplemental browser run `42857558136` passed six journeys but both same-named-server cases stopped after searching for the second server: an unrelated clear action remained before the matching result. A public DOM reproduction confirmed Enter invoked `undefined`, clearing the current choice rather than selecting the searched server.
- Decision: explicit `清除选择` remains available with an empty/whitespace search. Resource searches contain matching resources only; no-match and disabled-result Enter cannot clear a selection. The existing browser assertions remain unchanged.
- Evidence: the keyboard regression fails before the one-condition fix. All 14 choice-selector tests pass, including searched replacement, no-match/disabled retention, explicit clearing after removing search, and prior disabled/reopen behavior. Coordinator independently reran the same suite. TypeScript passes. Local native-browser startup is blocked by host socket restrictions; no sandbox setting was weakened. Corrected browser rerun remains pending.

### Read service-plan identity from its actual catalog

- Observed defect: an operator-line CI capture displayed a generated service ID as the authorization source despite the fixture having a readable service name. Both the line detail and its principal-to-authorization editor read services from `/state`, whose real API response does not include that catalog. Refreshing the same endpoint could never resolve the name or populate those choices.
- Decision: both callers share the established independent `/services` query. Detail attribution distinguishes pending, failed and confirmed-missing catalog states, offers retry and retains the stable ID in contextual details. Nested authorization editing disables only unresolved service choices and preserves the selected ID and unrelated fields. Other callers and shared policy-source formatting remain unchanged.
- Review correction: the new missing-plan notice also reads service ID, so its field-update dependency must include that ID, not only service mode. A dirty draft changing to an available plan now clears the stale warning.
- Evidence: real-API-shape detail and dirty-warning regressions fail before their fixes. Twenty-one line-workflow tests pass, plus 49 adjacent policy/routing tests; new cases cover catalog failure/retry, unrelated dirty edits and changing users during an in-flight catalog read. Independent review identified and verified the dependency correction. Application/spec typechecks and browser discovery pass. The real operator journey now asserts the created plan's name in both nested editing and detail; new browser pixels remain pending.

### Keep copy feedback with the current subscription access task

- Defect: a pending clipboard call checked only whether the dialog remained open. After access revision/URL changes, an authoritative rejection or a nested recovery decision, it could still announce success or tell the user to manually select a link no longer displayed.
- Decision: copy feedback belongs to a committed access lifecycle. Changed identity, read authority, URL, delivery mode, recovery or dismissal retires old feedback; unchanged successful same-link refetch preserves legitimate feedback. Bundle mode cannot start a link-copy action. Already-submitted browser clipboard writes cannot be cancelled or recalled by this change.
- Review correction: the backend can retain a feed URL in a bundle response, so URL equality alone is insufficient. Delivery mode is part of ownership, including feed-to-bundle-to-feed transitions.
- Evidence: four initial stale-feedback cases and four delivery-transition cases fail before their respective fixes. Seventy-six related access/rotation/bundle tests pass, including 22 clipboard scenarios independently rerun after review. TypeScript passes. StrictMode was source-reviewed, not separately exercised; no live subscription or clipboard operation and no geometry acceptance are claimed.

### Finish notification exits before destroying the test environment

- Evidence gap: the frozen `57c0487` frontend run completed 3,717 tests successfully but retained one old search assertion (corrected in `40df9fb`) and two unhandled React/Sonner callbacks after jsdom teardown. This was not an all-green run.
- Cause: Sonner's exit-removal timeout can outlive immediate RTL unmount. Clearing the public toast queue does not mean its mounted notification has finished leaving. A deterministic queued/dismissing regression retains one pending timer with the old cleanup; an ordinary focused run can pass because the race is timing-sensitive.
- Decision: only the two affected suites use a test helper that lets queued publication render, dismisses while the host remains mounted, waits for actual notification removal and then unmounts. Production code, global setup, assertion strength and timeout budgets remain unchanged. The helper does not promise to repair a host already unmounted elsewhere.
- Verification: queued, active and dismissing ownership cases pass; three implementation repetitions plus an independent coordinator repetition pass all 28 focused tests without unhandled errors. TypeScript passes. The next frozen full run remains necessary; no exception is suppressed.

## Rendered-evidence follow-up

`web/tests/server-path-workspace.ui.spec.ts` now adds same-named, same-address server journeys at 1440 and 390 pixels. The real isolated backend creates synthetic records; keyboard selection, explicit owner replacement, endpoint filtering and persisted draft identity are asserted. Capture points show the two identity choices, retained first server and second server's endpoints. No fleet task or runtime application is requested.

Application/spec TypeScript checks and discovery pass (four tests in that file, two newly added). Browser execution and actual pixel review remain pending CI. The supported cloud-browser attempt could not reach the local demo URL despite the launch session reporting ready; a separate command also could not reach that session. The exact isolation cause is unconfirmed. The demo was stopped, and no public tunnel or security bypass was used.

### First supplemental pixel review

Run `42857558136` at `8910172` completed six of eight cases successfully and preserved artifact `13782968543`; both duplicate-server failures exposed the keyboard-clear defect above, so the run is not green. Artifact SHA256 matched its upload receipt. Eight actual desktop/narrow captures were inspected: target-instance identity/state/actions now stack legibly, platform and own-connection counts have clear equal hierarchy, and duplicate-server choices retain complete distinct IDs without horizontal clipping. Target-card occlusion records confirm the sampled controls were unobscured.

These observations cover the captured regions only. The narrow first-profile image ends within its lower source controls, and the narrow selected-east image does not show Save. Their offscreen reachability is not established by those pixels.

The corrected run `42859483432` at `57c0487` subsequently passed all eight unchanged browser cases, including searched same-name server replacement, endpoint ownership and persisted draft identity at both widths. A frozen full-suite run then exposed one older DOM assertion that still required the unrelated clear item during search. That integration test now verifies explicit clear before typing and keyboard Enter selecting only the searched replacement while an older append is pending; the 31 related workspace/choice tests pass. This updates the intentional search contract without relaxing the browser assertions or stale-append safeguards.

### Keep a short browser review running during continuous delivery

The supplemental `ux-visual-focus.yml` workflow runs four isolated specs on this review branch: the original eight server/path/invitation cases plus two existing service-focus cases at 390×900 and 390×640, one worker and one running job. New pushes replace the pending run, not the running review. It retains the pinned setup, vendor Chrome provenance and enabled browser sandbox, and uses the existing isolated production fixtures. Full Repository quality and its required aggregate remain unchanged.

Artifacts identify their exact commit and include only deliberate synthetic captures, reports and the browser-environment receipt. Intermediate commits may have no supplemental run. A completed subset is not full browser acceptance, and an upload attempt does not guarantee screenshots after an early startup failure. Contract tests, discovery, typechecks, the full 102-test static helper suite and pinned actionlint pass; the first eight-case run completed with the bounded results recorded above.

### Measure actual keyboard-focus paint before changing it

Source-level neutral-color calculation gives the current light opaque ring 2.593:1 against white and its half-opacity halo about 1.545:1. These values alone do not establish every control fails: solid borders, primary fills, outlines, invalid-state overrides and wrapper-owned paint can provide different indicators. Existing focus/clipping captures did not supply paired neutral focused/unfocused evidence. No production color or component style has been changed.

The two existing service-focus tests retain all prior assertions and now attach paired screenshots and computed paint/context after native Shift+Tab/Tab for an outline Cancel button and blank name input, on both openings. Evidence records actual ancestors, pseudo-elements, adjacent hit surfaces, geometry and opacity without reading field values. Measurements are diagnostic, not a compliance verdict. Desktop, unchecked checkbox, tabs, sidebar and comprehensive dark/error-state comparison remain unsampled. Ten-case supplemental discovery, focused typechecks, 25 independent workflow/distribution tests and pinned actionlint pass. The new paired browser captures remain pending.

## Current verification boundary

Focused tests, strict TypeScript and production build pass for these slices. A frozen tree corresponding to `81865ca` passed all 3,656 frontend tests in 290 files. Later form, pagination, summary and backup changes have their separately recorded focused evidence; they are not retroactively covered by that earlier full run. Exact-commit CI remains a separate check. They do not establish visual quality or comprehension. No deployment, live-node operation, production data change or historical quota decision belongs to this review.

### Require a new acknowledgement after rechecking a fleet plan

- Defect: after a successful acknowledged preview, explicitly previewing again left the old reviewed plan and enabled Create action present during the replacement request and after a failed replacement. The user could create from a check they had just attempted to supersede.
- Decision: starting the explicit recheck advances its ownership revision and clears only the prior review and acknowledgement. Input selections remain; successful recovery requires a fresh acknowledgement before creating a pending batch. No batch is executed by preview or acknowledgement.
- Evidence: public FleetPlanForm regression fails before the correction, then verifies pending/failure invalidation, retained selected instance, successful retry and renewed acknowledgement without a create request. Thirty-eight focused tests across three files and TypeScript pass; coordinator independently reviewed the source and reran all seven pending-operation cases. This is bounded source/DOM evidence, not actual-node or rendered-layout acceptance.

### Keep inbox recovery inside the open message

- Defects: a message-sheet refresh failure had recovery controls only behind the modal. Separately, a failed mark-read request could retain its error even after an authoritative refresh confirmed the message was read, including an older failure arriving after that confirmation.
- Decision: failed reads offer a focusable retry within the message sheet, preserving its full content. Once the displayed message has confirmed read state, obsolete acknowledgement errors are not presented as an outstanding task. No automatic mutation retry or duplicate acknowledgement is introduced.
- Evidence: three public-task cases fail before and pass after the correction, including Tab/Enter recovery and both acknowledgement/refetch orderings. Nineteen inbox cases and TypeScript pass; coordinator independently reran 28 inbox/time-label/decision-copy cases across three files and reviewed source. Paused-state behavior is unchanged. Native-browser layout and focus restoration after the successful read remain outside this bounded DOM review.

### Distinguish collection source loading from confirmed emptiness

- Defects: an empty cached source catalog was labeled empty during an in-flight refresh. An initial offline read described indefinite loading instead of its paused network state.
- Decision: keep initial loading, cached refresh, paused waiting and confirmed empty states distinct. Only a checked source catalog claims no available sources; existing source selections, ordering, processing and local collection name remain intact across reconnection. The change does not infer current availability from cached names.
- Evidence: two public CollectionsPage regressions fail before and pass after the correction. They check cached-empty refresh completion, pause/resume and retained draft/name/selected source. Forty-six focused recovery/source-task/preview cases and TypeScript pass; coordinator independently reran all 21 collection-editor recovery cases and reviewed the state conditions. This is source/DOM evidence, not native-browser content/layout acceptance.
