# Product task-experience review — 2026-10-19

## Scope and evidence boundary

Independent review of the current web worktree against `AGENTS.md`, `docs/product/UI-SPEC.md`, `INTERACTIONS.md`, `CAPABILITY-REGISTER.md`, and the public task seams in RW-04, RW-06, RW-12, RW-23 and RW-24. The existing console implementation was reviewed rather than replaced. This is not a clean-commit or complete release-acceptance review; other backend and console work continued concurrently.

The recovered pinned Matt Pocock TDD/review guidance was read. The already documented public seams were used: real React task interactions in jsdom and the API boundary, with HTTP fixtures rather than internal-component mocks. Each of the seven new task regressions was observed failing before its corresponding fix. This pass did not spawn a second reviewer or run a formal two-agent diff review; the standards and specification findings are separated below.

Evidence labels used here:

- **Observed DOM:** actual React/Ant Design components, with synthetic HTTP boundary responses and browser-environment shims. This establishes interaction and data-flow behavior, not pixels or real HTTP authorization.
- **Code-inferred:** inspected implementation/contracts. Not equivalent to executing the complete task.
- **Unrun browser:** no successful desktop/mobile browser render, screenshot comparison, screen-reader test, focus-trap sweep or contrast audit in this pass.
- **Real API:** not rerun by this narrow review. The previously documented request-suite result is separate evidence, not a new browser result.

No live VPS, real user account, external notification, publication or browser-security bypass was used. The previously reported normal sandboxed Chromium startup denial and cloud-browser localhost failure remain unresolved; no new evidence justified repeating those routes.

## Useful result

The landing page now leads with subscription retrieval rather than a large quota hero. Lower-frequency personal configuration tools are grouped separately, and the mobile navigation is a real dismissible drawer instead of an offscreen but keyboard-accessible sidebar. Existing features remain reachable.

Two consequential errors were fixed: a stale subscription URL could previously conceal a new access denial, and closing a processing collection could silently discard changes. Source deletion now checks and names references before offering a destructive action, while frequent refresh and edit stay on the source row.

This is a materially safer, more task-focused interface, not a claim that the full task-first specification or visual acceptance is complete.

## Standards review

### Fixed findings

1. **Current server authority was obscured by cached client state.** `AccessSubscription` fell back to `output.feedPath`/`output.url`; when such a value existed, the current `/access` error was suppressed. Retrieval now requires the fresh successful access result, with no output-summary fallback. While rechecking or denied, copy/download/link controls are absent and the same sheet exposes the error and retry. The server remains authoritative; this was a presentation/eligibility bug, not evidence that the feed server accepted a denied request.
   - Observed DOM: a published output carrying an old feed path plus a current 403 cannot expose that link or its copy/download actions.
   - `web/src/Subscriptions.tsx`, `web/src/task-experience.dom.test.tsx`.

2. **Closed mobile navigation remained discoverable by keyboard/accessibility APIs.** CSS translation alone did not remove its links, and there was no dialog-level Escape/focus behavior. The app now uses the existing Ant Design Drawer only on narrow screens, destroys the closed navigation content, declares expanded/control state on its trigger and makes the sidebar scrollable on short screens.
   - Observed DOM: closed navigation is absent; opening exposes a named navigation dialog; Escape dismisses it and restores the trigger's focus.
   - Full browser focus containment and responsive geometry remain unrun.
   - `web/src/App.tsx`, `web/src/styles.css`, new task regression.

3. **Collection dismissal bypassed the unsaved-change guard.** The processing drawer previously called `changeDraft(null)` directly on Close/Escape. It now compares against the opened baseline, confirms discarding changed source/order/processing values, preserves them on Continue editing, and prevents editing/dismissal during a pending save.
   - Observed DOM: Continue editing preserves the entered collection name; explicit discard followed by reopening starts a clean form.
   - Code-inferred: the same dirty comparison covers ordered sources and processing steps; the pending-save content uses `inert` and close guards.
   - `web/src/Sources.tsx`, new task regression.

4. **Source deletion was beside everyday actions and described the wrong consequence.** A red trash icon next to refresh/edit said a configuration might need to reselect nodes, but `deleteTenant` actually rejects referenced sources. Delete now lives in More. Before confirmation, the UI reads the existing owner-scoped masked collection/profile lists; blocking references are named and the user is told to remove those references first. With no references, deletion still requires a focused consequence confirmation. The server's existing dependency check remains the final authority if a reference changes after review.
   - Observed DOM: refresh/edit remain directly available; deletion is under More; a referenced source names its collection and profile and sends no DELETE.
   - Code-inferred: the unreferenced branch uses the existing delete API after confirmation; no new delete/impact endpoint or persistence model was added.
   - `web/src/Sources.tsx`, `internal/httpapi/tenant.go`, new task regression.

### Preserved strengths and limits

- Source/profile editing continues to fetch authorized reveal records only after an explicit edit/copy action. Existing DOM regressions for secret-preserving edit and retained failed import values remained in the full test run.
- Stable identities, separate save/preview/publish actions, exact-output update reviews and stale-success fences were not replaced with local guesses.
- No generic framework, backend abstraction, fabricated health status or proof-status banner was introduced.
- The new deletion impact read is advisory, not an atomic authorization decision. Server validation must continue to reject changed references.

## Specification review

### Narrow improvements made

| Task | Change | Evidence |
| --- | --- | --- |
| Open the everyday workspace | Personal navigation keeps subscription, client configuration, sources and messages prominent; collections, rules, templates and publication management are under Configuration tools. An active advanced destination opens its group and retains current-page semantics. | Observed DOM for opening tools and navigating to rules; code-inferred direct-link behavior. |
| Retrieve the right subscription | Published subscriptions are before usage. Multiple outputs have a named selector beside Adjust routing and Get subscription instead of always retrieving the first item. Row retrieval also updates the chosen output. | Observed DOM verifies reading order and that selecting Travel requests only Travel's access endpoint. |
| Start without a published output | The dead disabled Get subscription button is absent. The empty state gives one active Set up subscription action and explains that a platform route or private airport can be used. | Observed DOM verifies the setup destination. This is not yet a setup wizard. |
| Inspect allowance only when needed | Remaining, used and total quota are compact; actual traffic, cycle/reset/timezone and expiry stay available in disclosure. Available platform routes remain reachable separately. No value missing from the API becomes a fabricated zero. | Code-inferred; DOM confirms usage follows retrieval. |
| Work on a narrow screen | Navigation moves into Drawer; long subscription names can wrap; selector/actions wrap; the subscription row's tiny mobile text/button sizes were increased. | Interaction semantics tested in DOM; width, touch geometry and visual balance are unrun browser checks. |
| Remove a private source | Frequent actions stay near their row; the uncommon destructive action is separated and names current blocking dependencies. | Observed DOM and server code review. |
| Edit processing safely | Collection close confirmation and retained draft values now match global navigation's preservation behavior. | Observed DOM. |

### Remaining product gaps, not closed by this review

1. **The first-use/basic-routing task is still too technical (RW-07/RW-23).** Set up subscription enters the existing profile workflow; Adjust routing opens the full profile list/editor. There is not yet the specified compact application-group/default-traffic editor, named published-routing summary, or guided entitled-route setup. The new selector chooses a published output, not an arbitrary new client generation. These require a deliberate task slice and positive acceptance, not relabeling the existing editor or inventing published data.

2. **Material source refresh still lacks candidate acceptance (RW-04).** At review time `refreshSource` parses and saves a complete candidate immediately; the UI reports refresh success without Added/Removed/Connection changed and affected-group review. `parseSource` also rejects a zero-endpoint feed as an error, rather than offering the specified valid-empty removal update, and incomplete input is blocked rather than offering reviewed partial acceptance. This pass preserved those server contracts and did not fake a client-only review. Failed refresh retains the previous accepted snapshot, which is a useful existing safeguard but does not close the refresh acceptance requirements.

3. **Visual/mobile acceptance remains a release gate (RW-23/RW-24).** jsdom does not establish pixel layout, contrast, diagram usability, drag behavior, viewport overflow or real screen-reader output. The existing Playwright browser scenarios and fresh screenshots must run in a supported environment after all active feature changes integrate. No 'perfect design' or complete mature-product acceptance is claimed.

### Other requested journeys inspected, without widening this patch

- **Graph/form route editing:** `ServerRoutes.tsx` defaults to ordered editing, offers add/change/move/remove without dragging, keeps graph movement separate from route order, reveals selected endpoints deliberately and announces changed paths. Native graphical interaction and real narrow-screen layout were not run here.
- **Groups/rules/client preview:** the profile editor retains separate input/group/rule/runtime sections, ordered controls, explicit final action, saved draft and publish flow. Existing model/DOM tests are retained; the simplified ordinary-user task described above is still absent.
- **Fleet stages/retry:** `Fleet.tsx` places stage actions beside target outcomes, requires prior stages to succeed, limits retries to failed selections and preserves the request identity on explicit resubmission. It does not label queued work applied. Exact execution/runtime evidence belongs to the fleet verification report, not this UI review.
- **Provider/resource facts:** `NodeObservation.tsx` distinguishes CPU/memory/load, NIC rates/cumulative counters, provider statement/baseline sources, unknown values and user quota. Technical evidence is disclosed in context; no synthetic balance or health claim was added.
- **Role/service separation:** personal and administration views remain separate, with role-gated admin rendering and server-side authorization unchanged. New group/connection-limit and subscription-origin work was still in progress and was not certified by this review.
- **Failure/empty states:** actual query failures remain distinct from empty lists; import failures preserve form values; subscription access denial retains a concrete retry surface. An empty state is not a substitute for a missing runtime observation.

## Verification

New file: `web/src/task-experience.dom.test.tsx` (seven task regressions). Recorded red-to-green sequence:

1. Closed mobile navigation was still present → absent closed, dialog open, Escape/focus return pass.
2. Rules appeared in the everyday navigation → deliberate tools disclosure and navigation pass.
3. First-use setup action was missing and Get subscription was disabled → actionable setup/no dead retrieval pass.
4. A current 403 was hidden behind the cached feed path → error/retry with no stale-link controls pass.
5. Source deletion appeared as a direct row button → More plus named dependencies/no DELETE pass.
6. Published retrieval followed the quota hero and had no explicit output selection → retrieval-first order and selected-output access pass.
7. Collection Close discarded the form → Continue retains values, explicit discard resets pass.

Final command output is retained in `docs/verification/product-ux-review-2026-10-19/`:

- `typecheck.log`: strict TypeScript gate **passed**.
- `dom.log`: full model and React DOM suite **passed, 62 tests in 7 files**, including the seven new tasks.
- `build.log`: production bundle gate **passed**. The existing shared framework chunk-size warning is not a visual/performance acceptance result.
- `git diff --check` on this patch's files also passed. These are the 2026-10-19 19:46–19:48 UTC review checkpoint results, before the other in-progress feature UI work is integrated.

The successful-link DOM case emits jsdom's unsupported canvas-context warning from the QR component. It does not assert rendered QR pixels. Ant Design's test-mode ID reuse also means the collection confirmation and selector-opened access sheet are asserted through the visible dialog and its contents, not by treating test-mode generated IDs as production accessibility evidence.

No local ticket is marked verified by this review. RW-04/RW-06/RW-12/RW-23/RW-24 can link this as partial task/interaction evidence; their broader prerequisite, native, real-API and browser requirements remain independent.
