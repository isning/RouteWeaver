# Opened forwarding-path review — 2026-10-23

## Task and defect

An operator opens saved path A, another editor saves B, then the operator chooses “查看修改并应用”. Previously `/validate` checked the latest server record B but the confirmation still displayed A. The returned B fingerprint could authorize B without the operator seeing that forwarding intent. A fingerprint check only at publication did not protect this earlier review boundary.

## Contract

- Ordinary administrator deployment reads and saves already return an opaque `revisionToken`, derived from the entire stored record, including omitted secrets. Do not expose the underlying secret or include example tokens in documentation.
- `POST /server-deployments/{id}/validate` now **requires `If-Match` with the revision from the opened record**. This is mandatory for browser and other API callers. Missing or stale revisions receive HTTP 409 with `code: SERVER_DRAFT_CHANGED`, no artifacts and no usable fingerprint. Callers must explicitly reopen the full safe record and review it; they must not refresh only the token or automatically retry the old intent.
- Validation reads the raw record once, checks its token, and decodes/renders that same snapshot. Existing inventory validation and redaction remain. Publication retains its fingerprint check and atomic compare-and-write; a changed post-check fingerprint uses the same typed recovery.
- The UI binds a check to deployment ID and opened revision. A changed revision invalidates the check and consent. Stale validation keeps the previous visible path, disables the unusable check action and offers one explicit “重新载入转发路径” recovery. Reload replaces the complete safe view; the user must check again and confirm again. Closing a stale publication dialog retains that recovery in the path detail.
- Narrow recovery uses the existing 700 px notice stacking pattern, with a 44 px recovery target. No new UI mode, automatic apply, automatic publication or permanent helper block is introduced.

## Verification and limits

- Observed HTTP RED: both a missing revision and an old opened revision previously returned HTTP 200 and B's usable fingerprint. The initial DOM RED exposed the missing header contract. The first DOM attempt after implementation also failed a nested-dialog role lookup because the new fixture omitted the existing production-style Ant ID setup; that fixture correction is retained separately from the product change.
- HTTP: 39 affected non-native top-level cases passed after explicit caller migration. New coverage includes missing/stale/exact revisions, secret-only drift, a later save before publication, sanitized responses and instances remaining unregistered. The native test caller was updated and compiled, but native execution was not run.
- DOM: four new public-workspace tasks passed: explicit reload/fresh consent, post-check drift, late check after a same-ID save, and old-account response exclusion. A separate five-file run was **42/45**, with three existing 10-second test-body deadlines. Their causes are unconfirmed; that run is not green and is not replaced by a union of later results.
- First built local-browser run: two actual A→B tasks at 1440 and 390 px passed, with no `/publish` request and unregistered instance state. Pixel review identified a cramped new narrow recovery notice; the final layout/action follow-up is verified separately below.
- Runner evidence preserves an isolated-snapshot VCS-stamping build failure (no browser task started), followed by an incorrectly scoped 92-test discovery that was interrupted after four logged local collection-task completions. Neither is P1 task evidence. Corrected discovery explicitly listed only the two intended browser tasks. All work used local synthetic fixtures; no native/live application, deployment or external-client state is established.
- Unknown application-response reconciliation remains a separate known contract gap: a network failure is not proof that the server did not queue an operation. This revision-binding fix does not add durable operation receipts or make repeated application idempotent.

Independent source review and exact source/build evidence are retained outside the deliverable source in the private apply-review evidence directory. No whole-suite, all-browser, accessibility-conformance or product-certification claim is made.

## Final recovery-layout verification

The refined candidate passed all four new DOM tasks again, typecheck, Vite build, and both rebuilt local-browser tasks. The post-check conflict test also closes the confirmation and recovers from the retained detail notice. At 390 px, the recovery description has more than 260 px of width, its button is below the description and at least 44 px high, and the stale check button is disabled. Actual 1440/390 screenshots were inspected: the old direct path remains visible before reload; the new reject path appears in the fresh review with unchecked consent and disabled application. Browser assertions confirm zero application requests and unregistered instance state.

These are separate bounded runs, not a green replacement for the earlier 42/45 run. The two existing browser API fixture callers were explicitly migrated but not executed in this focused slice. Backend production bytes are unchanged from the 39-case HTTP pass. The final source review covers revision binding, mandatory caller migration, stale-response/account boundaries and the refined recovery state; canonical integration is a separate allowlisted action.

## Neighboring staged-application boundary (source review)

“分阶段应用修改” starts a separate Fleet task with only the path ID and action. It does not pass the opened IR, validation fingerprint or consent. The explicit “预览影响与差异” request reads the current stored path and returns rendered, authoritative per-target configuration differences. The review table exposes those returned differences, followed by a new unchecked confirmation. Creating the batch recomputes the plan fingerprint and atomically compares its inputs; the result is a planned batch, not execution. The initial path label and target choices can still originate from cached inventory, while the actual proposed differences come from the fresh preview response. This is a source-confirmed separate review boundary, not a newly executed Fleet browser task or proof of universal Fleet usability.
