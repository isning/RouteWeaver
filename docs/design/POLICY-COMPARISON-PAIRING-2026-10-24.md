# Policy comparison: keep corresponding values together

> Historical proposal record. The staged/unrun status and future-tense statements below describe this proposal at its preparation time, not the current combined candidate. See [combined verification and limits](../verification/POLICY-CONFIRMATION-COMPARISON-2026-10-24.md) for subsequent RED, finite DOM, browser and pixel outcomes. Original rationale and history are preserved.

2026-10-24. **Staged, not executed or integrated.** This iteration builds on the reviewed confirmation-content candidate, not canonical. It does not resolve the separate saved-profile DOM deadline failure or inherit an earlier candidate's test/browser passes.

## Evidence and bounded decision

The six populated `comparison-collapsed`, `authorization-expanded`, and `authorization-rules` PNGs at desktop1440 and narrow390 were inspected as actual pixels. The prior independent all16-image review records the same concerns:

- The default narrow comparison displays user/before only. The horizontally shifted capture displays after, with fragments of the preceding column: the operator must remember values across panels.
- Desktop independently stacked summaries duplicate field labels and put corresponding values on different vertical baselines when one side wraps.
- The after policy already contains and displays the reviewed service name, but each service-derived limit repeats its raw service ID.
- The narrow full/rules capture ends before the entire rule body and lower actions. This is an evidence gap, not proof of unreachable controls; normal vertical scrolling is not itself a defect.

Evidence remains in the preceding candidate's `browser-run-20261024/browser/results/` and `PIXEL-INDEPENDENT-REVIEW.md`. These observations are not fresh candidate pixels, user-comprehension research, or Google/Cloudflare certification.

Equal-width summary columns would not align independently wrapping fields. Stacking the whole before summary above the whole after summary would still require memory. Therefore only the populated comparison is changed to one paired-field representation per user, not separate desktop/mobile products.

## One representation, responsive layout

- Each user has one identity heading and a semantic table named by that heading. Every value cell identifies its field row header and its `变更前` or `变更后` column header. Native semantics are explicit while CSS changes visual layout.
- Desktop has one field label and two values in the same grid row. Narrow layout moves that same label above its two side-by-side values. There is one DOM tree, no viewport-dependent JavaScript, no duplicated values, and no horizontal minimum table width.
- Local `min-width: 0` and wrapping preserve complete long names and IDs without clipping or ellipsis. The existing visual tokens remain in use; no global KeyValue or table style is changed.
- Ant List owns the affected-user collection with stable `userId` keys and exactly five users per page. Size changing is explicitly disabled so collections above50 do not offer a nonfunctional selector. Pagination remains available for all authoritative affected rows.
- The existing global full-authorization checkbox remains. Changed-only selection still uses unchanged `policyDifferenceFields`. A nonempty affected row with no projected differences retains its user and one `当前生效授权保持不变` statement; it is not removed or relabelled zero impact. Full view reveals all nine fields.

`policyDisplayFields` and `PolicyFieldValue` inside the existing `AccessPolicy.tsx` module now supply both saved summaries and review cells. Status/tag, byte/rate units, zero/unlimited values, route labels, date formatting, account-cycle labels/anchor/timezone, provenance wording and duplicate-no-plan suppression are shared, not independently reimplemented. The business comparison projection is not modified.

## Identity references are not display metadata

Selected-service identity comes only from `policy.serviceId`. Its exact matching embedded service can supply the reviewed name; otherwise the existing catalog-name fallback or selected ID is shown. An unresolved label is not `无方案`. Conversely, a stray embedded service with no selected reference must not invent a selected plan: that state remains `无方案`.

Each `service:<id>` provenance reference is resolved separately. An embedded name is eligible only when its ID matches that particular reference; otherwise existing catalog/ID fallback remains. The `+direct` suffix, personal/account/group sources, absent-source label and unknown-source fallback stay intact. No submitted target name substitutes for another reference, no catalog is mutated, and no new query is added. Matched per-side snapshot names take precedence over later catalog renames.

The unresolved-name-versus-no-plan issue is a **source-only finding** in the old formatter, not a pixel-observed wrong-plan incident. Missing/mismatched/stray metadata fixtures are explicit display-contract negative cases, not claims about current resolver output. Browser unknown-service metadata simulation is out of scope for this round; it remains DOM/model coverage.

## Server revision and review-instance lifecycle

A server consistency revision and a local UI review instance are different lifecycles. Distinct local proposals may be reviewed against the same server revision. Domain concurrency tokens must not be used as UI reset identities.

The controlled review page resets to1 beside existing consent/full/rules resets only after the current preview succeeds. Returning with another proposal resets even when its revision string is equal; a503 on apply keeps the current review page and full-view state. Version ownership, frozen change/target, preview/apply payloads, CAS,409 invalidation, cancellation and pending guards remain unchanged. This is source reasoning plus a staged regression, not a backend change or user-study conclusion.

## Preserved boundaries

Zero-authoritative-row and blocked-summary conditions, every blocker, exact count, explicit consent, stable action/busy names, no-reset consequence, save-versus-applied boundary, and local rules disclosure are unchanged. No dangerous-action shortcut, automatic apply, invented deployment result, request-schema change, new architecture module or external operation is introduced. User-group administration outside this review retains its existing Table.

## Guidance used

This is a project adaptation of [CONTENT-DESIGN-RULES.md](CONTENT-DESIGN-RULES.md), [UX-METHODOLOGY.md](UX-METHODOLOGY.md) UX-05/12, and the existing [source register](UX-GUIDELINE-SOURCES.md):

- GS-06, [IBM Carbon Data table guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines): structure should support comparison.
- GS-01, [WCAG2.2 fixed Recommendation](https://www.w3.org/TR/2024/REC-WCAG22-20241212/): retain programmatic relationships and inspect responsive access. This candidate is not a full conformance claim.
- GS-35/37, [Carbon Modal](https://www.carbondesignsystem.com/building-blocks/core/components/modal/guidelines) and [GOV.UK Details](https://design-system.service.gov.uk/components/details/): decision consequences stay visible; only supplemental rules are disclosed.

Existing registration dates and limits apply; this is not a new external-guideline audit or a vendor-mandated layout.

## Staged verification scope

Production delta: `AccessPolicy.tsx`, `access-policy-model.ts`, and scoped `styles.css` only.

- New `policy-comparison-pairing.dom.test.tsx`:14 cases covering field/column/user associations, full/status/validity/cycle, zero projected differences, five-user pagination, same-revision fresh proposals,503 page retention, over50 fixed-size behavior, blockers, long identities/catalog changes, and six selected-service reference/name cases.
- `policy-review-model.test.ts`: eight added provenance-resolution cases; its four exact-difference tests remain unchanged.
- Existing `access-policy.dom.test.tsx` changes only two full-view label counts from two copies to one. Existing confirmation-content tests migrate only structural/user-heading and unchanged-statement expectations; actual values, provenance, requests, consent and recovery assertions remain.
- No timeout increase, internal-hook mock, test skip or new execution seam. Native `beforeEach` captures the owner, including parameterized cases. The public seams are the real rendered review/summary and intercepted HTTP; pure source resolution uses its existing exported model helper.

The one-file RED overlay contains only the new paired DOM file for a selected public comparison tracer atop the prior content source. It intentionally excludes the model test that calls a new optional argument, avoiding a baseline typecheck/setup failure masquerading as behavioral RED. The GREEN delta carries the complete tests and production changes. No RED/GREEN has been run by this author.

The coordinator must approve and serialize runtime against frozen composed source, verify exact values/associations, inspect both paired values on the same visible field at desktop/narrow, and capture the lower expanded-rules/decision area through normal scrolling. The separate profile deadline remains an independent blocker.
