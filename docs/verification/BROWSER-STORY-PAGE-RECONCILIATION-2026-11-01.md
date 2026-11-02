# Exact browser story/page reconciliation — CI3/CI4

Latest measured browser source: `81dd62054e36b45c4c2f2c670d121ad3a7553b68`, tree `b51789930b37bb00c3b31da9a573785acbbbb15a`; [CI4](https://github.com/isning/RouteWeaver/actions/runs/41351035317). **191 passed /4 failed /195 unique,0 skipped/flaky**. Inspected23650ca contains prepared fixes, not a newly tested source. No product/test files, ticket statuses, remote runs or deployment changed by this documentation task.

CI3 exact aaabe51:183/195,12failed. CI4 supersedes only directly re-executed named cases; it does not erase the earlier failures. Full non-browser CI is outside this reconciliation. [Machine-readable case ledger](BROWSER-STORY-PAGE-RECONCILIATION-2026-11-01.json) preserves every mapped exact test ID/title/outcome/attempt.

## Finite story work IDs

| Evidence / work ID | Direct story IDs | CI4 result and remaining boundary |
|---|---|---|
| processing-browser | C201,C202,C203 | 1/1 passed. E02 named joined editor→compare→save/reopen→selected publish scope satisfied; E03/E05 and E01 remain. |
| cycle-browser | S01,S02,A01,A02,A03 | 4/4 passed. E10 four named cycle/renewal/reset/user-view journeys satisfied; synthetic meter input is not payload/history proof. |
| template-browser | C501,M01 | 2/2 passed. Both joined409/re-review/apply/selected publication/feed-preservation flows completed. Images caught entrance translucency; settled visual capture pending. |
| collection-delete-browser | C102 | 1/1 passed. I02 narrow dependency/no-delete/cancel/focus case passed; controlled HTTP, not backend authorization. Full integration E01 remains. |
| endpoint-impact-browser | F02,K02 | 0/1 passed. E04 impact rendered, then Escape→Save focus failed. Prepared focus fix unverified; not closed. |
| account-browser | A01,M03 | 2/2 passed. Real isolated-CLI password/session/admin-recovery journeys, no secret screenshots. |
| mfa-browser | M03 | 1/1 passed. Real isolated-CLI TOTP enrollment/login/admin recovery; no recovery-code or secret-image claim. |
| backup-browser | M02 | 1/1 passed. Real isolated-CLI downloaded file→exact restored DB identity/config join; original live state unchanged. |
| provider-confirmation-browser / I01 | K04 | Controlled320 opt-in consequences/cancel/focus passed. No native/stock traffic/provider-billing extension. |


## Previously pending indexed browser selectors

These exact indexed selectors also passed on CI4 attempt 0; no additional story work ID is closed solely by that result. Scope and backend/fixture boundaries remain as stated in the story index.

| Evidence ID | Story IDs | Indexed selectors passed |
|---|---|---:|
| ordered-route-browser | F02 | 1 |
| route-exit-browser | F02,K02 | 1 |
| collection-browser | C102 | 1 |
| dynamic-browser | C301 | 1 |
| rotation-browser | C602 | 2 |
| invite-browser | A01 | 1 |
| first-feed-browser | S01 | 1 |

## Page matrix B IDs

| ID / source file | Exact case count | Outcome / limits |
|---|---:|---|
| B1 / [account-security.ui.spec.ts](../../web/tests/account-security.ui.spec.ts) | 5 | 5 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B2 / [workspace.ui.spec.ts](../../web/tests/workspace.ui.spec.ts) | 3 | 3 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B3 / [output-review-consequence.ui.spec.ts](../../web/tests/output-review-consequence.ui.spec.ts) | 2 | 2 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B4 / [action-context-and-template-layout.ui.spec.ts](../../web/tests/action-context-and-template-layout.ui.spec.ts) | 18 | 18 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B5 / [confirmation.ui.spec.ts](../../web/tests/confirmation.ui.spec.ts) | 3 | 3 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B6 / [notification-readability.ui.spec.ts](../../web/tests/notification-readability.ui.spec.ts) | 5 | 5 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B7 / [published-route-path.ui.spec.ts](../../web/tests/published-route-path.ui.spec.ts) | 8 | 8 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B8 / [server-review-revision.ui.spec.ts](../../web/tests/server-review-revision.ui.spec.ts) | 2 | 2 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B9 / [shadcn-endpoint-contract.ui.spec.ts](../../web/tests/shadcn-endpoint-contract.ui.spec.ts) | 3 | 3 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B10 / [fleet-continuous-service.ui.spec.ts](../../web/tests/fleet-continuous-service.ui.spec.ts) | 3 | 3 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B11 / [backup-control-layout.ui.spec.ts](../../web/tests/backup-control-layout.ui.spec.ts) | 2 | 2 passed, 0 failed. Named file cases only; not every state/role of the page. |
| B12 / [history-legacy-narrow.ui.spec.ts](../../web/tests/history-legacy-narrow.ui.spec.ts) | 6 | 3 passed, 3 failed. Legacy320/390/640 passed; activity320/390/640 geometry failed. No activity settled screenshot acceptance. |
| B13 / [collection-delete.ui.spec.ts](../../web/tests/collection-delete.ui.spec.ts) | 1 | 1 passed, 0 failed. Controlled dependency decision at320, not backend delete proof. |

## Four failures and evidence limits

Endpoint320 focus plus activity320/390/640 geometry remain FAILED at the measured SHA. Prepared product focus fix and bounded settled-motion measurement/capture changes have local checks but no new browser result. Template functional success is not settled screenshot success. B1–B11 passing their files does not close unnamed OPEN cells in UI02/UI04/PRD01. E02/E10 are removed only from story remaining-work references; their named satisfied scope remains recorded. All other remaining work and24 ticket statuses are unchanged.

Artifacts were downloaded read-only and their head SHA/ZIP SHA256 checked. Receipt `checklist-evidence-20261101/browser-41351035317/RECEIPT.md`, SHA256 `3358c85ecf697a9e625ff60daab7d19e1f8338232dc9fb9c211a2fbfc775bee8`. Current documents are reconciled from actual reports, not from source-file presence or aggregate success.

## Documentation validation

Re-read all four detailed reports: 195 unique IDs, 191 expected and 4 unexpected outcomes. The ledger's 29 groups map to 81 unique cases; each title, outcome and retry/status pair matches its report. Checked 35 stories / 82 evidence groups, unchanged story statuses/ticket prerequisites and recorded green baseline, and Markdown table integrity. `git diff --check` passed. No application tests, browser execution, full static gate or secret scan were rerun by this documentation-only pass.
