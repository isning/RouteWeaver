# Independent route browsing during inventory recovery

## Finding and scope

The route list previously combined its own query with the infrastructure query in one blocking `QueryState`. A failed optional host/link/inventory read hid independently loaded route names, addresses, and detail openers. Rows already support deployment-ID fallback when enrichment is absent. This follow-up separates inventory availability from route-list loading/error state without changing route-list error handling.

Inventory failure, pending reads, and offline pause have explicit guidance on the page and inside an open route detail. The retry action is `重试读取转发路径`. New route creation, editing, exit retargeting, and principal-entry preparation require a successful idle inventory read. Existing editors and drafts remain mounted. Unknown inventory is not presented as an unsupported entry capability; unsupported prerequisites appear only after inventory is known. Detail resolution still performs its independent authoritative route read.

## Verification

- Initial public-UI regression failed before implementation and passed afterward.
- Independent review caught a newly exposed principal-entry path that treated undefined deployment as unsupported. Three of six recovery assertions failed before that correction; guards and unknown-state presentation were corrected before publication.
- Final focused route subset: 101 tests across seven files passed, one worker. Six new recovery cases cover initial failure, ordinary focus-driven refresh failure, pending inventory browsing, preserved open draft, independently blocking route-list error, and selected-user capability recovery without a false unsupported claim.
- App TypeScript and Vite build passed. Diff whitespace check passed.
- New `route-inventory-recovery.ui.spec.ts` uses the real App with loopback-only GET fixtures at 390 and 1440 pixels. It rejects external/unexpected API requests and covers initial inventory failure, retained browsing, disabled detail actions, in-sheet retry and recovered actions. It attaches original viewport images and a sanitized ledger to the HTML report. Strict native TypeScript passed; native execution is pending.
- Supplemental recovery discovery now has 34 cases across 11 files; five workflow contract tests passed. Required gates, sandboxed Chrome provenance, fixtures, timeout/retry settings, and artifact safety boundaries are unchanged.

## Limits

This is source/DOM acceptance, not fresh browser or pixel acceptance. Native editing validity, offline-paused interaction, keyboard retry and settled focus after recovery are not newly accepted by the pointer-only synthetic fixture. Existing backend validation and operation-specific review remain authoritative. The latest complete 4,013-test local DOM result predates this route change and is not claimed for it. Publication remains blocked pending user authorization; no alternate remote write, deployment, real-node action or credential operation was performed.

Final independent source review accepted the corrected principal-launch guards, unknown-state presentation, fixture and supplemental configuration with no remaining source blocker. It did not claim a native run or rendered review.
