# WIP49 source-bound verification

Status: **accepted bounded UI/motion source checkpoint**. The same owner-private demo was published successfully at 05:42 UTC. Artifact saving remains a subsequent operation requiring external receipts.

## Scope

This pass refines layout and interaction motion using the existing shadcn/Radix interface. It also repairs browser-found sidebar and task-exit lifecycle regressions introduced or exposed by longer exit presence. It does not add backend/protocol functionality. See `../design/WIP49-UI-REFINEMENT.md` and `../design/WIP49-MOTION.md`.

## Checks and evidence

- Static repository checks passed in R1 and R2. Public receipts: `CHECKPOINT-EVIDENCE/WIP49/static-r1.passed.json` and `static-r2.passed.json` from repository root.
- Historical focused failing-before tests are retained in `CHECKPOINT-EVIDENCE/WIP49/focused-before.failed.json`. They are not full-suite failures, and the inventory run's filtered skips are not passes.
- Final frontend R1 **failed**: 1,816 passed / one failed out of 1,817 tests, zero pending, in 160 physical files. Typecheck passed; the production build stage was not started in that aggregate. All 381 frozen source/configuration files were unchanged. The failure was an exact-focus assertion after dirty-dialog cancellation. DOM removal preceded Radix unmount autofocus and the task overlay microtask; the test now separately awaits the exact original opener. Production behavior and the no-write assertion remain unchanged. Public receipt: `CHECKPOINT-EVIDENCE/WIP49/frontend-r1.failed.json`. The failing run remains historical; focused repair coverage passed 74 tests, followed by the fresh full result below.
- Actual browser review found and retested exiting-sidebar Tab/focus behavior and wrong-task closing presentation. Final collection/settings/editor screenshots and computed motion timings were captured. Public receipt: `CHECKPOINT-EVIDENCE/WIP49/visual-motion.passed.json`. These reviewed states remain distinct from full frontend behavior evidence.
- Final R2: **1,817 / 1,817 tests passed in 160 physical files**, zero failures/pending, and typecheck passed. The 381-file source/configuration freeze remained unchanged. R1→R2 changed only the focus-observer test, not production code.
- The original R2 aggregate was interrupted by a tool-level registry network block after test completion and the build header. There is no original aggregate exit receipt, so it is **not** labelled exit0. The registry request's cause was not established. A separate same-source production build completed successfully using installed local dependencies with offline mode and update notifications disabled, exit0; the denied registry request was not retried. Public receipt: `CHECKPOINT-EVIDENCE/WIP49/frontend-final.passed.json`.
- Independent source review reported no blocking issue in the reviewed changes. This is not a full security/architecture proof.

## Actual-review limits

The retained form-accordion lifecycle was intentionally not changed. Reduced-motion behavior has source/class-contract coverage, but the reviewed browser did not provide preference emulation; no actual reduced-motion run is claimed. The current resource fixture is empty, so populated-list visual acceptance is not claimed. Authored narrow CSS viewports are not physical mobile-device/touch or assistive-technology certification.

The Site-only subscription-origin fixture uses an unverified `.demo.invalid` draft and no real token; all writes remain read-only failures and external requests are blocked by the adapter. Its final supported offline build and 12 containment tests passed; private deployment succeeded at 2026-10-30 05:42:54 UTC, commit `f8d53d7ca5edccb81d417f6e6bed4efa16c27bf3`. Public receipt: `CHECKPOINT-EVIDENCE/WIP49/private-demo-deployment.json`. This fixture is not canonical backend behavior or evidence of a successful origin verification.

## Inherited backend evidence

480 backend/harness files (cmd, internal, runtimes, scripts and Go modules) were compared with the verified WIP48 source with no content or mode changes. This source comparison does not constitute a new backend/runtime test. WIP48/WIP47 API/native/backend results remain historical provenance on their recorded source scope, not rerun WIP49 results.

Prior full native Chromium automation and sing-box runtime restrictions remain explicit; collected/unrun tests are not passes. Hysteria2, TUIC, XHTTP and other previously unsupported capabilities remain unsupported. No blanket panel parity, all-feature completion, Google certification, production-readiness or live VPS changes are claimed.

## Preservation and delivery

The exact WIP48 checkpoint status is retained at `CHECKPOINT-EVIDENCE/WIP49/historical-wip48-checkpoint-status.json`. All 211 existing methods entries and prior README bytes must remain intact; new mirrors belong under `snapshots/WIP49/`. Canonical source retains the real backend; the existing owner-private Site remains an isolated read-only demonstration. Private demo publication is recorded separately from canonical source acceptance. Final archive saving still requires actual successful external receipts.
