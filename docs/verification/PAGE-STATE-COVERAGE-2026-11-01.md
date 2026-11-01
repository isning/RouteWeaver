# Finite workspace page/state coverage — 2026-11-01

Baseline inspected: `0f3cc5ee699a4cbc9d261276c4c4437a770ea961`. This is a **bounded evidence inventory, not an all-pages pass**. UI02/UI04/PRD01 remain open wherever the cells below are open. Historical WIP50's 17-page / 107-dialog count is not current coverage evidence.

## Actual routing inventory and scope

[`App.tsx`](../../web/src/App.tsx) declares **20 accepted hash route identities**: 7 personal navigation destinations, 11 administrator navigation destinations, and 2 subscription subviews (`profiles`, `outputs`). Thus there are **18 navigation pages**, not 17. The subscription overview and its two addressable subviews share `SubscriptionsPage`, but must not be conflated when checking state/return behavior. `legacy-routes` is translated to the old route editor inside [`Admin.tsx`](../../web/src/Admin.tsx); it is not the server `routes` page. Account security is a real destination; admin MFA is a conditional section there, not another route. Login/invite/token-login are 3 modes of the unauthenticated entry surface outside these 20 identities.

Roles: **U** ordinary authenticated user, **A** administrator, **G** unauthenticated visitor, **P** password-change-required session. U/A share personal destinations; administrator template publication and MFA are additional A tasks. Every administrator destination must deny U before loading its data. G sees login, not workspace content. P is restricted to account security. These are UI boundaries only; they cannot establish server authorization.

## How to read the matrix

Each cell names a finite case, not every possible state of the page. `D#` refers to a synthetic HTTP / real rendered-component DOM test file below; only the named behavior is covered. `B#` is a browser test **source reference, UNRUN in this worktree**. `OPEN` means no dedicated case established in this pass, even if shared components or older CI passed. A loading/error test on one page does not establish that every page wires the shared component correctly. `—` means not applicable for the specified case, with reason. Narrow means actual viewport geometry, never JSDOM classes. Success means authoritative result presentation, not deployed enforcement.

The finite acceptance dimensions for each identity are: allowed/denied role entry; initial loading; authoritative empty; recoverable error without false empty; populated success; one named key mutation with failure draft retention; repeated cancel/reopen with final focus; dangerous action target/consequence; narrow access to that same task. Expanded flows/tabs not named here remain outside this closure scope rather than silently passed.

| Hash / allowed roles | Loading / empty / read error | Success / key mutation + failure retention | Repeated cancel / keyboard focus | Dangerous context | Narrow evidence candidate |
|---|---|---|---|---|---|
| account-security U,A,P | **PASSED D24** U/A/P entry + held session list, 503 not empty, retry→empty; **PASSED D29** recovery list held→503→retry→populated account | D1 password change/failed fresh authentication; session revoke | **PASSED D1** recovery dirty-discard twice returns to Close; reason retained | D1 exact disable target/current-session consequence | B1 keyboard security/recovery 320/390; UNRUN |
| subscriptions U,A | **PASSED D23** U/A entry + held profile inventory, error not empty, retry→empty; **PASSED D29** U/A overview held→503→retry→authoritative paused policy | D2 active authorization, revoked vs published, paused service | OPEN overview re-entry focus | D2 paused platform does not grant restore | B2 mobile creation cancel; UNRUN |
| profiles U,A | **PASSED D23** U/A entry + held profile inventory, error not empty, retry→empty; D3 source request error | D3 save draft, preserve malformed native text / failed source | D3 dirty keyboard navigation; repeated cancellation OPEN | D3 save is not publication | B2 real import/save draft; UNRUN |
| outputs U,A | **PASSED D23** U/A entry + held output inventory, error not empty, retry→empty | D3 exact output review; stale-digest fresh review | OPEN repeated cancel/final focus | D3 exact output identity before republish | B3 review consequence; UNRUN |
| sources U,A | **PASSED D19** U/A entry, held loading, 503 not empty, retry→empty | D4 failed reveal/import draft, saved-422 distinction | D4 safe discard focus, pending close lock | D4 existing accepted source survives discard | B4 source row target widths; UNRUN |
| collections U,A | **PASSED D19** U/A entry, held loading, 503 not empty, retry→empty | **PASSED D21** failed save keeps exact name, source order and both processing stages; retry payload identical | **PASSED D21** twice-canceled discard retains draft and returns focus to Close | **PASSED D21** discard identifies unsaved scope and preserves saved sources; no collection delete action exposed | B5 320/390 cancel targets; UNRUN |
| resources U,A | **PASSED D19** U/A entry, held loading, 503 not empty, retry→empty | D5 pending file/reference save; file failed-save retains selected file and retry payload | **PASSED D5** file/reference dirty-discard twice returns to Close; D6 field focus | **PASSED D5** refresh names resource, consequences retained, repeated cancel restores opener; no delete action exposed | B4 long target context; UNRUN |
| templates U,A (publish A) | **PASSED D19** U/A library entry, held loading, 503 not empty, retry→empty; references tab OPEN | D7 pending apply/shared publish retain failed draft | **PASSED D7** selection/publication/update version dirty-discard twice returns to Close | D7 reviewed shared publication; downstream scope OPEN | B4 full titles/actions 390; UNRUN |
| inbox U,A | **PASSED D24** actual U/A entry; D8 loading ≠ empty; failed read + explicit retry; empty | D8 acknowledged-only read status; failed ack retains unread/full body | D8 repeated keyboard dismissal restores exact opener; late success/failure for A cannot change B’s error/body/focus; successful A still becomes read | — no destructive action; acknowledgement target D8 | B6 390 content + new 320 keyboard/error regression; UNRUN |
| published-routes A | **PASSED D22** A entry, held route read, 503 not empty, retry→empty; auxiliary infrastructure failure OPEN | D28 exact public-route save completion ownership; failed-save retention OPEN | **PASSED D28** dirty public-route dismissal twice returns to Close | D28 compatibility explained before assignment; no delete control exposed | B7 published path; UNRUN |
| routes A | **PASSED D22** A entry, held host read, 503 not empty, retry→empty | D10 saved revision invalidates consent, late checks fenced | **PASSED D28** dirty server-route dismissal twice returns to Close (no fix required) | D10 apply consequences and both consent gates | B8 server revision review; UNRUN |
| servers A | **PASSED D22** A entry, held host read, 503 not empty, retry→empty; D11 operations errors | D11 new server→core; preserve protocol/core identity | **PASSED D11** dirty server dismissal twice returns to Close; nested discard restores exact host action and page opener | D11 registration/core context; no server deletion control in this page; other nested operational decisions OPEN | B9 endpoint contract; UNRUN |
| fleet A | **PASSED D22** A entry, held batch read, 503 not empty, retry→empty; auxiliary infrastructure failure OPEN | D12 failed impact preview beside action; D3 retry known failed targets only | OPEN repeated cancel/focus | D3 changed operation invalidates old impact | B10 continuous service; UNRUN |
| users A | **PASSED D20** A entry, held loading, 503 not empty, retry→empty; D13 no matches clear search | D13 name-only failed save/retry retains owner | **PASSED D13/D25/D27** user editor, invitation and user-entry dirty-dismissal twice restore Close; drafts retained | D1 exact disable user and reauthentication | B4 full target context 320/390; UNRUN |
| services A | **PASSED D20** A entry, held loading, 503 not empty, retry→empty | D3 ordinary save preserves hidden limits/reset anchor | **PASSED D26** rate adjustment dirty-dismissal twice restores Close; service-plan editor focus OPEN | D14 authoritative affected count / frozen authorization comparison | B6 policy readability; UNRUN |
| activity A | **PASSED D20** A entry + held main inventory, 503 not empty, retry→empty; **PASSED D29** audit held→503→retry→populated record | D15 historical statuses never fresh validation | — read-only list; detail focus OPEN | — no mutation in scoped history listing | OPEN |
| settings A | **PASSED D20** A entry + initial loading/503 hides editable defaults; retry shows authoritative name; empty list — not a list | D13 cached/read races preserve accepted/newer draft; D3 channel preservation | D13 dirty workspace navigation; repeated cancel/focus OPEN | D3 backup preview invalidated by passphrase change | B11 backup controls; UNRUN |
| nodes A | **PASSED D20** A entry, held loading, 503 not empty, retry→empty | D13 pending endpoint save locks close; failure preserves input | **PASSED D13** node editor dirty-discard twice restores Close; Cancel/discard/reopen | **PASSED D13** exact deletion target, dependent-route restriction, safe-default cancel twice, no writes | B9 endpoint contract; UNRUN |
| legacy-routes A | **PASSED D20** A entry, held loading, 503 not empty, retry→empty | **PASSED D13** failed save retains exact draft and retry payload | **PASSED D13** canceled discard restores Close, save returns to exact opener | **PASSED D13** exact deletion target, assigned-user consequence, safe-default cancel twice, no writes | OPEN legacy-route narrow geometry (B2 edits server routes, not legacy routes) |
| notifications A | **PASSED D24** A entry + held announcement list, 503 not empty, retry→empty; **PASSED D29** channels configuration and delivery history held→503→explicit retry→authoritative result | D16 announcement pending/failure draft; D17 channels failure preserves secrets | **PASSED D16** announcement dirty-dismissal twice restores Close; final opener focus | D3 in-app announcements ≠ external delivery | B6 announcements/delivery failure table; UNRUN |

### Role cases (separate from successful page rendering)

D18 enumerates all 11 administrator hashes with an ordinary `user` session: no administrator navigation, visible denial, and **only `/api/auth/me` requested**. This closes those 11 UI-denial cases only. It does not assert backend authorization or allowed A entry for all pages. The allowed shell case opens servers; D19 closes user/admin entry for resources, collections and templates; D20 closes admin entry for nodes, users, services and legacy-routes. D23/D24 complete the remaining allowed U/A route entries; G remains separately scoped. G login/invite failure permutations remain OPEN here (`session-recovery.dom.test.tsx` and B1 are candidates). D24 passes ordinary-user P forced-password entry; other required-password role/session permutations remain OPEN.

## Evidence registry

All D tests stub HTTP with synthetic data. They do not run the business backend, external delivery, real traffic, or Linux process enforcement. File links are evidence entry points, not a claim that every test in a file covers every cell.

- D1: [`account-security.dom.test.tsx`](../../web/src/account-security.dom.test.tsx).
- D2: [`subscription-overview-status.dom.test.tsx`](../../web/src/subscription-overview-status.dom.test.tsx).
- D3: [`workspace.dom.test.tsx`](../../web/src/workspace.dom.test.tsx).
- D4: [`source-editor.dom.test.tsx`](../../web/src/source-editor.dom.test.tsx).
- D5: [`resource-modal-lifecycle.dom.test.tsx`](../../web/src/resource-modal-lifecycle.dom.test.tsx).
- D6: [`resource-modal-focus.dom.test.tsx`](../../web/src/resource-modal-focus.dom.test.tsx).
- D7: [`template-task-lifecycle.dom.test.tsx`](../../web/src/template-task-lifecycle.dom.test.tsx).
- D8: [`inbox-read-state.dom.test.tsx`](../../web/src/inbox-read-state.dom.test.tsx).
- D9: [`published-routing.dom.test.tsx`](../../web/src/published-routing.dom.test.tsx).
- D10: [`server-review-revision.dom.test.tsx`](../../web/src/server-review-revision.dom.test.tsx).
- D11: [`infrastructure-creation.dom.test.tsx`](../../web/src/infrastructure-creation.dom.test.tsx).
- D12: [`fleet-pending-operation.dom.test.tsx`](../../web/src/fleet-pending-operation.dom.test.tsx).
- D13: [`admin-task-lifecycle.dom.test.tsx`](../../web/src/admin-task-lifecycle.dom.test.tsx).
- D14: [`policy-confirmation-content.dom.test.tsx`](../../web/src/policy-confirmation-content.dom.test.tsx).
- D15: [`admin-history-presentation.dom.test.tsx`](../../web/src/admin-history-presentation.dom.test.tsx).
- D16: [`announcement-modal-focus.dom.test.tsx`](../../web/src/announcement-modal-focus.dom.test.tsx).
- D17: [`notification-channel-draft.dom.test.tsx`](../../web/src/notification-channel-draft.dom.test.tsx).
- D18: [`workspace-shell.dom.test.tsx`](../../web/src/workspace-shell.dom.test.tsx).
- B1: [`account-security.ui.spec.ts`](../../web/tests/account-security.ui.spec.ts) — UNRUN here.
- B2: [`workspace.ui.spec.ts`](../../web/tests/workspace.ui.spec.ts) — UNRUN here.
- B3: [`output-review-consequence.ui.spec.ts`](../../web/tests/output-review-consequence.ui.spec.ts) — UNRUN here.
- B4: [`action-context-and-template-layout.ui.spec.ts`](../../web/tests/action-context-and-template-layout.ui.spec.ts) — UNRUN here.
- B5: [`confirmation.ui.spec.ts`](../../web/tests/confirmation.ui.spec.ts) — UNRUN here.
- B6: [`notification-readability.ui.spec.ts`](../../web/tests/notification-readability.ui.spec.ts) — UNRUN here.
- B7: [`published-route-path.ui.spec.ts`](../../web/tests/published-route-path.ui.spec.ts) — UNRUN here.
- B8: [`server-review-revision.ui.spec.ts`](../../web/tests/server-review-revision.ui.spec.ts) — UNRUN here.
- B9: [`shadcn-endpoint-contract.ui.spec.ts`](../../web/tests/shadcn-endpoint-contract.ui.spec.ts) — UNRUN here.
- B10: [`fleet-continuous-service.ui.spec.ts`](../../web/tests/fleet-continuous-service.ui.spec.ts) — UNRUN here.
- B11: [`backup-control-layout.ui.spec.ts`](../../web/tests/backup-control-layout.ui.spec.ts) — UNRUN here.

## Verification of this candidate

- RED: new message-switch regression failed against the baseline (5 inbox cases passed, 1 failed): message A’s acknowledgement error was rendered under already-read message B.
- Fix: reset the acknowledgement mutation presentation when selecting a message, before optionally acknowledging that selected message. No backend behavior changed.
- GREEN: 18 focused DOM files / **239 tests passed** (218 in the 16-file evidence run, 21 inbox/shell cases in the second run), one worker per invocation. All D1–D18 files above were executed. This is not a full frontend suite pass.
- The first cold inbox/shell run had an existing allowed-admin server-heading test fail (20 passed / 1 failed); the unchanged test passed on rerun. No timeout or assertion was weakened. That transient failure remains disclosed; it is not evidence of a reproduced product defect.
- Added 2 inbox DOM cases and expanded 1 denied-route case to 11 cases (net +12 DOM tests). Added 1 320px browser regression; source/list/typecheck only, actual Chromium **UNRUN** under host restriction.
- No backend, browser execution, deployment, remote CI, or publication was performed in this worktree. Browser references that use real APIs (for example B2) remain source candidates, not rerun backend proof; B1/B4/B6 and other intercepted flows are synthetic UI checks.

## Remaining closure work (bounded, not hidden by a green count)

1. Primary read-state cases and SR1–SR6 are established. Template-reference inventory and the explicitly named alternate infrastructure dependency failures remain OPEN; do not infer these from other query cases.
2. Allowed U/A route entries and all 11 ordinary-user admin denials are established as UI cases. G entry and server authorization remain separate; P ordinary-user forced-password entry is covered, not every role/session permutation.
3. Close remaining OPEN mutation/failure-retention and dangerous-context cells. Collection and legacy-route retry, endpoint/legacy deletion cancellation, resource refresh identity, and many dirty-dismissal focus cases are now explicit; actual backend destructive outcomes and untested nested operational decisions are not inferred.
4. Verify repeated cancel and final focus for the OPEN page tasks. DOM shared-overlay behavior is not a substitute for actual page wiring or browser animation completion.
5. Run the new browser regression in the coordinator’s next authorized CI batch, and map actual screenshots/results at 320/390/640 to the named tasks. Existing browser source references and the historical 174/177 counts cannot close these cells.
6. Reconcile this inventory against the exact integrated commit after sibling changes. UI02/UI04/PRD01 are **not marked complete by this document**.


## Follow-on bounded closure after `5c0c93c`

- D19: [`material-page-read-states.dom.test.tsx`](../../web/src/material-page-read-states.dom.test.tsx), six real-App cases: resources/collections/templates × user/admin. Each explicitly holds the primary read, asserts loading and no empty, returns 503, asserts error and no empty, retries, then asserts authoritative empty. Auxiliary HTTP is synthetic and unexpected endpoints fail the case. This does not cover populated success, secondary tabs, mutations, or backend role authorization.
- D20: [`admin-task-lifecycle.dom.test.tsx`](../../web/src/admin-task-lifecycle.dom.test.tsx), four exact hash cases: nodes/users/services/legacy-routes × admin. Same explicit primary-read lifecycle, with real workspace routing and no writes.
- D8 adds two late-acknowledgement cases (200/503) after B has opened; both passed. Success still invalidates/refetches A, so presentation dismissal does not cancel legitimate backend-side work.
- D5 adds a failing-before-fix resource-refresh decision case. Baseline confirmation omitted the selected resource identity; the title now names it (or its stable ID fallback), retaining refresh consequences. Two cancellations must send no writes and restore the exact opener.
- Shell cold-import investigation: an isolated diagnostic import measured **908 ms cold / 0 ms cached** for `Infrastructure` against RTL's unchanged default 1000 ms heading wait. The original failure did not retain enough untruncated main-content evidence to prove its sole cause; do not report a product-loader failure or a conclusive performance diagnosis. The shell's navigation-only test now prepares this module in `beforeAll`, outside the interaction deadline, without widening any timeout. A new controlled pending-import test in [`page-recovery.dom.test.tsx`](../../web/src/page-recovery.dom.test.tsx) explicitly asserts loading and available navigation until release, alongside existing rejected-import/error recovery cases. The diagnostic scratch test was removed; measurement remains in `/tmp/page-state-import-measurement.json`.
- Updated cells say **PASSED** only for these named scenarios. All remaining OPEN cells and browser UNRUN status remain unchanged.


## Second follow-on bounded closure after `10cb7c6`

- D19 now includes sources × user/admin (eight total allowed-role/read-state cases). Initial HTTP states are closed only for these four material page lists; no automatic secondary-dialog closure.
- D21: [`collection-source-task.dom.test.tsx`](../../web/src/collection-source-task.dom.test.tsx) adds a failed-save case using a two-source recipe with per-source and merged processing. Exact payload survives failure, two canceled discards, safe-default focus, and a successful explicit retry; the saved result appears and dirty state clears. Full file plus D19: **27 passed**.
- D22: [`network-page-read-states.dom.test.tsx`](../../web/src/network-page-read-states.dom.test.tsx) passes four real-App administrator route cases (servers/routes/published-routes/fleet), each with held primary inventory read, 503 without false empty, and explicit retry to empty. **4 passed**. No agent process or deployed state is exercised.
- Remaining read-state rows: account-security session list, subscriptions/profiles/outputs, activity, settings, and notifications. Remaining mutation/danger/focus/browser OPEN cells are unchanged; no broad all-pages completion is claimed.


## Third follow-on bounded closure after `0f8e4d1`

- D23: [`subscription-overview-status.dom.test.tsx`](../../web/src/subscription-overview-status.dom.test.tsx), six actual-App cases for subscriptions/profiles/outputs × user/admin. Held inventory → named error without false empty → explicit targeted retry → authoritative empty, preserving the exact hash. Full file: **27 passed**. Overview service-query states remain separate.
- D24: [`account-notification-read-states.dom.test.tsx`](../../web/src/account-notification-read-states.dom.test.tsx), account sessions for U/A/P plus administrator announcements. Assertions scope to the relevant section so concurrent admin-recovery loading is not accidentally counted as the session state. Password-required entry remains confined to security; no ordinary subscription request is accepted by the fixture. **4 passed**.
- D20 adds administrator activity's main-inventory lifecycle and settings loading/error without editable invented defaults, then successful authoritative configuration. Settings is not an empty-list domain; empty is not asserted there. Secondary audit/settings tabs remain open.
- D13 adds nodes/legacy-route deletion decisions: exact target, actual dependency/user consequence, safe-default focus, twice-canceled keyboard dismissal restoring the precise trigger, and zero writes. These do not establish successful backend deletion or dependency rejection.
- There is now an explicitly exercised primary read-state scenario on **all 20 route identities**, but this is not every query, tab, role, mutation or viewport. The table still exposes those remaining OPEN cells. In particular, browser states remain UNRUN in this worktree and UI02/UI04/PRD01 are not automatically complete.


## Fourth follow-on: exact legacy-route focus and inbox entry

- New D13 failure-before-fix: after a failed legacy-route save, closing and then canceling the discard confirmation left focus on `body`. `RouteEditor` passed `confirming` as sheet `pending`, removing its captured Close button. Pending now means the actual save only; the existing `confirming` close guard and inert editing body still prevent concurrent actions. The test retains the exact draft and request payload, cancels discard safely, retries explicitly and returns focus to the original page opener after save.
- D24 now also verifies actual inbox entry/read states for both user and administrator. All allowed U/A route-entry combinations in this matrix now have explicit actual-App entry evidence; this is UI permission presentation, not backend authorization.
- D13 + D24: **31 passed** after the focus fix. Browser proof for this focus change is still UNRUN.
- Corrected the legacy-route browser candidate: the ordered edit in `workspace.ui.spec.ts` exercises server `routes`, not `legacy-routes`; that narrow cell is OPEN rather than borrowing unrelated evidence.


## Fifth follow-on: confirmed nested-discard focus defects

The task overlay removes its header Close button while `pending`. Thirteen additional pending expressions were using *a nested discard confirmation* as if it were an in-flight save. Fourteen targeted cases reproduced focus falling to `body` after cancellation; a server-route control case passed unchanged. Only proven sites changed: pending continues to reflect real save/apply activity, while existing confirming guards, disabled submit actions and inert editor bodies remain. No shared overlay rewrite.

Bounded cases (each cancels twice, checks retained input and zero unintended writes):
- D5 resource file import and public reference.
- D7 template selection, shared-template publication, and update-version choice.
- D16 announcement editor.
- D13 endpoint and user editors.
- D25 [`invite-task-lifecycle.dom.test.tsx`](../../web/src/invite-task-lifecycle.dom.test.tsx): invitation recipient.
- D11 server inventory name.
- D26 [`rate-edit-continuity.dom.test.tsx`](../../web/src/rate-edit-continuity.dom.test.tsx): rate value.
- D1 account recovery reason.
- D27 [`user-entry-task-ownership.dom.test.tsx`](../../web/src/user-entry-task-ownership.dom.test.tsx): entry name.
- D28 [`public-onboarding.dom.test.tsx`](../../web/src/public-onboarding.dom.test.tsx): public-route name; server-route name is the passing unchanged control. This file, not D9, exercises actual `PublishedRoutesPage`. D9 is client-output presentation evidence and is no longer attributed to the administrator public-route page.

Red logs: `/tmp/page-state-{related-focus,template-focus,admin-focus,operational-focus,route-template-focus}-red.log`. An intermediate broad run included an incompletely authored template-update fixture and failed; after providing its required preview response, the actual focus assertion reproduced the bug. No product assertion or timeout was weakened. Native browser animation/geometry is still UNRUN for these new cases.


Final validation for fifth follow-on: **158/158 DOM tests passed across all ten affected test files**, one worker, against the final production changes (`/tmp/page-state-final-close-focus.log`). Typecheck passed (`/tmp/page-state-fifth-tsc.log`); all 20 matrix identities and evidence links were checked. Independent read-only source review found no blocking production regression: real mutation locks remain, duplicate discard is guarded by the current confirmation handle/local guards, and nested modal ownership is unchanged. Review found and corrected an outdated P-entry evidence sentence. Review did not execute browsers or backend tests.


## Sixth follow-on: bounded secondary reads after `ca43db7`

D29: [`secondary-read-states.dom.test.tsx`](../../web/src/secondary-read-states.dom.test.tsx), six actual-App scenarios:

| Scenario | Allowed role / endpoint | Named result and guard |
|---|---|---|
| SR1 recovery accounts | A, `/admin/accounts` | Held and 503 states do not show “没有账号记录”; explicit retry shows the exact recovered account. |
| SR2 audit list | A, `/audit` | Held and 503 states do not show “暂无管理操作记录”; retry shows the recovered audit target. |
| SR3 notification history | A, `/admin/notifications/outbox` | Held and 503 states do not show “暂无发送记录”; retry presents an actual failed delivery, not invented delivery success. |
| SR4 channel configuration | A, `/admin/notification-settings` | No editable invented defaults while loading/error; retry presents authoritative interval 24. Configuration is not treated as an empty-list domain. |
| SR5 service overview | U and A, `/me/overview` | Loading/error remains unknown (no invented unlimited quota), then retry shows authoritative paused policy. Independently loaded empty subscriptions remain visible throughout. |

D30: [`template-selection-recovery.dom.test.tsx`](../../web/src/template-selection-recovery.dom.test.tsx) is reused for version/target/source/collection/platform dependency distinctions instead of adding a second harness. Its new SR6 case deliberately holds a source reload after choosing a target, pinned v1 and binding, then returns failure, then explicitly retries. The same target/version/mode/binding survives, unavailable is not empty, apply stays disabled until recovery, and no write occurs. Existing cases additionally cover failed selected-version reads, confirmed version removal without silent latest-version substitution, failed target reads, collection-backed candidates and paused reads. These are synthetic HTTP/real component cases, not real backend acceptance.

An attempted extra channel-background-refetch probe used the outer QueryClient; the real App intentionally isolates its workspace QueryClient and disables automatic window-focus refetch. That was a test-seam mismatch, not a demonstrated production failure. It is **not included as passed coverage**. Channel failed-save draft retention remains D17; arbitrary background-refresh permutations are outside SR4's initial-read scenario. No production code changed in this follow-on.

## Frozen capability/scenario boundary for UI02/UI04

This matrix is a finite acceptance list, not “every possible UI state.” Closure means a named cell has appropriate evidence against the integrated candidate, with no unresolved failure in that named scenario. Do not expand it silently from newly imagined combinations, and do not close it from a suite count.

1. **Route/role universe:** the 20 listed accepted hashes; U/A allowed entry; ordinary-user denial for 11 admin hashes; the explicitly tested U password-required security path. G login/invite/session failures and other password-required permutations remain separately named scope, not a Cartesian product of all routes and all possible session races.
2. **Read universe:** one stated primary read per route plus SR1–SR6 and the already named dependency cases. Pending, synthetic 503, explicit retry, authoritative empty *or* populated/configuration result are distinct. This does not require every HTTP status on every query. Template-reference inventory and alternate infrastructure-dependency errors remain specifically OPEN where the table says so.
3. **Mutation universe:** only the key tasks named in each row, including the stated failure/draft retention and dangerous decision context. Successful backend persistence, destructive authorization, real external delivery and deployed Linux enforcement require their separate backend/operations evidence; UI fixtures never close those gates.
4. **Interruption universe:** the named pending-action, twice-canceled dirty-dismissal, exact final-focus and stale-completion cases. Shared primitives do not establish every page’s wiring. Remaining overview/profile/output/fleet/service-plan/settings/detail-focus cells stay OPEN until mapped to their specific case.
5. **Viewport/accessibility universe:** native browser evidence at the named 320/390/640 configurations and desktop task checks; JSDOM does not prove geometry, animation timing, assistive-technology behavior or human comprehension. Existing B references are UNRUN in this worktree and require integrated browser evidence. Not a promise about every viewport, device, language, or browser engine.
6. **Change control:** adding a new route, role capability, dangerous operation or materially different editor/read contract requires deliberate revision of this list. Cosmetic variants or the infinite set of input/action permutations do not retroactively make the acceptance goal unbounded. Completion still requires closing the existing named OPEN cells, not deleting them.

Sixth-follow-on verification: **20/20 focused DOM tests passed** across D29/D30; typecheck passed; no full frontend suite, backend, browser, remote CI or publication executed. Logs: `/tmp/page-state-secondary-bounded.log` and `/tmp/page-state-secondary-bounded-tsc.log`.
