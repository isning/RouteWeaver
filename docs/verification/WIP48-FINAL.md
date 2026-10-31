# WIP48 source-bound verification

Status: **accepted bounded UI source checkpoint**. Final frontend and actual visual review passed. The existing owner-private sample Site was updated successfully at 03:26 UTC; artifact saving remains a subsequent operation with separate receipts.

## Scope

WIP48 refines the composition of the existing shadcn interface: shared page rhythm, navigation, tables, endpoint forms, server cards, forwarding summaries, subscription grouping/usage and row actions. It does not add protocols or change the backend. See `../design/WIP48-UI-POLISH.md` for the concrete visual problems and acceptance criteria.

The initial actual-browser baseline and subsequent candidate reviews are separate from behavior tests. Final comparison must show improvements on the same representative routes/states; passing tests alone is not evidence of polish.

## Final verification

- `scripts/verify.sh static`: passed initially and again after staging new source/docs. Public scoped receipts: `CHECKPOINT-EVIDENCE/WIP48/static-r1.passed.json` and `static-r2.passed.json` from repository root.
- First final frontend attempt: **failed at typecheck**, because two test calls used an unsupported `getByRole` option. The calls were corrected to anchored name regular expressions; no behavior assertion was waived. Vitest and production build were **not started** in that attempt. Historical receipt: `CHECKPOINT-EVIDENCE/WIP48/frontend-r1.typecheck-failed.json`.
- Second final frontend attempt: **1,806 / 1,806 tests passed in 158 physical files**, zero failures/pending; typecheck and production build passed. The 379-file web source/configuration freeze remained unchanged. Public receipt: `CHECKPOINT-EVIDENCE/WIP48/frontend-final.passed.json`. This repaired run is distinct from the initial typecheck failure; no failed attempt is relabelled.
- Final actual-browser visual comparison: **accepted in the reviewed states**. Desktop 1180×757 and authored child CSS viewport 390×568 were compared through three candidate rounds. The final pass rechecked list hierarchy, subscription action visibility, compact server/forwarding summaries, endpoint form density and the narrow navigation-sheet gap. Public receipt: `CHECKPOINT-EVIDENCE/WIP48/visual-r3.passed.json`.
- Additional safe interaction checks passed: correctly named endpoint delete target, safe initial focus and exact cancellation focus return; source-menu Return/Escape and opener return; separate discoverability of single-item background comparison and per-subscription review. No mutation/confirmation was executed.

## Inherited evidence and limits

WIP47's bounded backend/API/native evidence remains historical provenance, not newly executed WIP48 tests. It comprises main Go and managed runtime vet/race/build passes on their recorded unchanged scope, 17 API request cases, 112 pinned native parser configurations and eight new Xray loopback cases. No backend runtime test rerun is claimed for this presentation-only pass. 480 backend/test-harness files (cmd, internal, runtimes, scripts and Go module files) were compared with the verified WIP47 source: no content or mode changes. This source comparison is recorded in `CHECKPOINT-EVIDENCE/WIP48/backend-provenance.unchanged.json`; it is not a new runtime pass.

WIP47's full native Chromium matrix remained unrun after launch was blocked; collected cases were not passing tests. Its sing-box runtime remained unrun due the host netlink restriction, although parser checks passed. This pass does not erase those limits. Authored narrow CSS viewports are not physical phone/touch, browser zoom or a comprehensive accessibility audit.

Hysteria2, TUIC, XHTTP and other explicitly unsupported WIP47 features remain unsupported. This is not blanket 3x-ui/s-ui parity, Google-level certification, a claim that every product feature is complete, or production-readiness.

## Delivery boundary

The canonical source retains the real backend. The existing owner-private test Site uses isolated read-only sample data and does not operate real nodes or credentials. WIP48 private demo publication succeeded at 2026-10-30 03:26:31 UTC, source commit `71cc2077626bfca5f90a23c15b823c421fc9a6fa`; its supported build and 11 containment tests passed. Public receipt: `CHECKPOINT-EVIDENCE/WIP48/private-demo-deployment.json`. Artifact saving remains pending and can only be established by successful external receipts. The exact WIP47 checkpoint status is preserved at `CHECKPOINT-EVIDENCE/WIP48/historical-wip47-checkpoint-status.json`. Prior methods archive entries and README bytes must remain intact in the next artifact version.
