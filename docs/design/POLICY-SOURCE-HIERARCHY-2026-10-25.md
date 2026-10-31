# Authorization review: shared provenance and truthful update wording

2026-10-25. **Staged proposal; candidate typecheck, tests and rendered acceptance are not yet run.** The baseline is the verified recovered WIP37 source archive, not the older executor checkout. Its extracted inventory is `efd493d5c5e22aa6e6fc4ea2ea8a2c5e21ebb81dc841b9f79b4c162a17c44087`; the documented historical canonical digest is `d361f5693c6ab01e55fb6118068fc73ed44a2fdd6f77de450def6d17e1b40ab8`. The recovery preserves two historical archive/file-mode differences rather than silently normalizing them. No baseline files were changed for this proposal.

## Observed problem, not a new comparison-layout failure

Actual restored long-name desktop pixels show four repeated two-line plan-source annotations beneath otherwise aligned values. Fresh short-name baseline captures at1440×1000 and390×844 confirm that both values are already readable together; eight repeated source annotations remain. The target is information hierarchy and lifecycle meaning, not smaller type or an arbitrary line-count reduction.

Fresh evidence is in the external `wip37-confirmation-baseline-corrected-20261025` bundle: desktop initial PNG SHA `b641051915f0123ab38861f74df7580189e7b1205006de8ebf5d50bd1ac7533d`, narrow initial SHA `06228153b078666db5527a1c6768041a698e67d5d444d5b145fe3410b517458e`. The supplemental narrow-limits capture has identical bytes and adds no coverage. The narrow footer lies below the initial viewport; this is not evidence of an unreachable action. The original populated narrow stress PNG was not recovered. Candidate pixels must be reviewed separately.

## One bounded source context

Only the existing four contiguous numeric fields form `周期额度与访问限制`: quota, online IPs, concurrent logical streams and per-logical-entry rate. Two or more displayed members get the same visible group whether their sources are shared or mixed. A single displayed limit stays in its original inline row. Status, selected service, routes, validity and account cycle remain outside this group; changed-only selection and field order are unchanged.

A paired full-source row replaces repeated numeric annotations only when each side has one identical, nonempty raw provenance token across all displayed group members. Eligible numeric tokens are `individual`, `account`, or an unsuffixed `service:<id>` with that side's exact matching embedded service ID and nonempty snapshot name. Display-string equality, the reviewed target, catalog-only names, missing metadata and selected-service assumptions are not eligibility evidence. Mixed, unsupported, suffixed, missing, unresolved, unnamed or mismatched source cases retain complete inline details and existing catalog/ID fallback; there is no shared-default/exception legend.

The row says `来源` for equal tokens and `来源变更` for different tokens. Its complete before/after source labels remain visible even when numeric values are equal or changed-only omits the service row. Each consolidated value retains its own field/column headers and describes itself with its column's visible source cell. There is no tooltip-only source or invented hidden replacement fact.

Within one user's currently visible comparison, different referenced service IDs with identical resolved labels receive contextual ID suffixes. This includes mixed same-column references, not just opposite sides of one row. Each label uses its own side's snapshot and existing fallback; the same ID renamed between snapshots is not a different-identity warning. Original qualifiers such as `+direct` stay in the detail. Unique labels do not gain IDs. The independent `PolicySummary`, existing source formatter and business difference projection are unchanged.

This keeps the main questions close: **which limit changes, from what to what, and which source controls it?** Contextual short labels would still repeat annotations and need an additional referent when the service row is omitted. Hiding all provenance would conceal source-only changes. The selected shared row avoids both, but its heading/tint must not overpower the values in actual candidate pixels.

## Updating authorization is not saving a harmless draft

`internal/httpapi/access_policy.go` calls `ApplyPolicyChange`; `internal/store/effective_policy.go` commits the reviewed policy after revision, snapshot, initial-calendar and budget/blocker checks. Subsequent admission, budget and delivery-eligibility calculations consume that policy. This endpoint does not enqueue node deployment. Existing leased traffic is not evidence of synchronous universal application or of being unaffected.

Accordingly, this review uses `更新授权` for both the visible primary action and accessible name, `平台授权已更新` for successful feedback, `我已核对本次授权变更` for explicit consent, and `暂时无法更新授权` for the blocker heading. Every backend blocker string remains unchanged. The boundary is `受管入口配置不会自动应用。`, consistent with the separate route workflow in `PublishedRoutes.tsx` that says entry preparation has not submitted deployment and offers `检查并应用`. The no-reset consequence remains. This wording does not promise rollback after errors, deployment success, or synchronous live-traffic effects.

## Scope and verification contract

Production changes are limited to `AccessPolicy.tsx` and local comparison CSS. No backend, API payload, preview/CAS, ownership, action guard, consent gate, zero/blocked condition, five-user pagination, review-instance reset or retry behavior changes. Summary formatting is reused, not independently reimplemented; independent summaries retain their inline sources.

The new public-seam DOM file stages21 expanded cases: shared numeric/source associations; unchanged selected-service context; source-only equal values; paired and same-column same-name identities; mixed before/after; seven fallback forms; one-field fallback; full-view/standalone-summary separation; long snapshot names/catalog refresh; zero-row service/group/entitlement update wording and exact request body; blocked shared comparison. Negative missing/mismatched/multiple-plan DTOs are display-contract fixtures, not claimed backend resolver output. HTTP-boundary mocks do not establish actual persistence or runtime enforcement.

Five existing test files migrate only inspected policy-review labels; paired-review full-view row-header counts include the added group heading. Existing exact values, source details, actions, request assertions,409/503 protections, native owners, waits and budgets remain. The tests-only RED overlay contains only the new file, selecting its first public group/source tracer; no model API change is needed to reach the baseline failure. Runtime remains coordinator-owned and requires a reviewed frozen manifest.

## Guidance and limits

This is a project adaptation of [content rules](CONTENT-DESIGN-RULES.md), [UX-05/12 and independent-context safeguards](UX-METHODOLOGY.md), and the [registered sources](UX-GUIDELINE-SOURCES.md), not an external mandated layout:

- GS-16, [GOV.UK Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces): improve structure before adding explanation; prioritize clear task information.
- GS-06, [Carbon Data table guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines): organize data for the user's comparison task.
- GS-37, [GOV.UK Details](https://design-system.service.gov.uk/components/details/): supplemental information may be disclosed; necessary decision information should remain visible.

These three primary pages were reread on2026-10-25; their registered authority/context limitations remain. Group eligibility, contextual identity disambiguation and the precise Chinese copy are project synthesis. Passing automation, screenshot inspection and real user comprehension are separate evidence. This proposal makes no Google/Cloudflare certification or overall product-maturity claim.

## Post-validation status — 2026-10-25

This annotation was added after validation; it is documentation, not executed source. The final fifteen-path composition uses an owned, labelled/described outer error-summary group and a passive inner alert. Earlier direct-alert focus and failed capture/test evidence remain historical, not superseded passes. Semantic DOM150, focused browser8/18 and the real saved-service preview1/2 passed within their declared scopes. See `docs/verification/POLICY-FLOW-EXPERIENCE-2026-10-25.md` for exact evidence and exclusions. Integration and the next composed full gate still require separate admission.
