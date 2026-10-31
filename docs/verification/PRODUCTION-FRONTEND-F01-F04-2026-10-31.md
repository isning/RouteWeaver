# Production frontend remediation F01–F04 (2026-10-31)

Source: exact remote audit tree `774d13f87b43ef68e9ed0fafd296bc352f11c559`, locally reconstructed commit `0cd3e4b6ce19a73e3e869dc3eaa1e185b7e2bb9f`. No deployment or real-account operation.

## Changes and evidence

- F01: announcement title column now has a 12rem minimum while preserving the existing table overflow and named row-action context. Correction to the audit's source explanation: this exact baseline **already had** a 700px table minimum; the missing title-column minimum remained the relevant shrinkage risk. Existing screenshot findings are not reclassified as passing. Browser tests now assert title width/line bounds at 320/390/1440 and keyboard editing at short/reflow viewports. The 640×400 viewport models 1280×800 at 200% layout reflow; it is not a test of native browser zoom controls.
- F02: notification channels remain registered while collapsed, including replacement/clear-secret fields. Submitted values come from the validated current form rather than missing fields falling back to the baseline. Success explicitly empties replacement-secret controls. Never-opened channels retain stored settings and do not send secret replacements.
- F03: each legacy reveal has its own owner and AbortController. Retarget, cancel, close and account change invalidate old responses/errors. Writes capture the entry ID and credential version before mutation execution. Dirty cancellation uses the existing focus-aware discard confirmation. Pending reads name the target and can be canceled. Managed rotation remains independently dismissible.
- F04: revoked legacy entries open a new, empty connection/credential draft using only safe name/route/entry identity and a fresh credential version. They never request revoked-secret reveal. Managed-principal provisioning is unchanged.

## Executed checks

Dependencies: exact lockfile `npm ci --ignore-scripts` succeeded (449 packages); no prior node_modules were reused. Offline install initially lacked cached zod; the ordinary permitted registry install succeeded.

Public UI → HTTP regression seams:

1. F02 original test failed with `https://old.example` instead of edited `https://new.example`, then passed with mounted channel fields.
2. Expanded F02 test exposed the successful-save password control retaining its synthetic secret after setting `undefined`; explicit empty strings fixed it.
3. F03 original test failed with `Entry A` replacing `B unsaved edit`, then passed with request ownership.
4. F04 regression failed because the revoked reveal returned 404 and no editor opened; after the fresh draft fix, its no-reveal/new-version submission assertions passed.
5. Relevant existing managed-rotation dismissal regression initially caught an overbroad pending-close guard; the guard was narrowed to legacy form saves, preserving managed behavior.

Final focused run: **65 tests passed across 6 files**, single worker: notification-channel-draft, user-entry-task-ownership, settings-tab-continuity, announcement-modal-focus, rotation-recovery, workspace (all `.dom.test.tsx`). TypeScript typecheck passed. These are component/HTTP-boundary tests, not real backend persistence or native browser layout evidence.

## Remaining verification

Browser additions in `web/tests/action-table-targets.ui.spec.ts` await authorized private CI. No local Chrome launch, sandbox workaround, new screenshot, real SMTP/Webhook delivery, or real credential operation was performed. Full integration/typecheck after composition and backend revoked-version/feed acceptance remain coordinator gates; focused UI tests do not establish production readiness.

Design references consulted: repository AGENTS/content rules; pinned mattpocock TDD/codebase-design/tests/mocking at 49dd158d1076134a641b33efb035946536778336; current official shadcn table/sheet/theming guidance and the user-selected refactoring-ui reference. Existing semantic tokens and overlay/form adapters were retained.
