# Backup export deadline error delivery

## Scope and behavior

Export reserves a1second error-response write allowance upfront while retaining the original operation/read deadline and scrypt workFactor18. Completed successful archives tighten their write deadline to the original operation deadline before200; late nil completion and cancellation cannot authorize a successful download. Unsupported deadline control fails closed for export. No expired-deadline renewal, background encryption/response race, KDF reduction or changed default10minute duration.

A pre-success generation deadline error uses503 and stable reason `backup_export_deadline_exceeded`. Only requestFile for exact `/admin/backups`, status503 and that reason is localized to “备份创建超时。请检查服务资源和备份时限后重新创建。” Auth, validation, unknown reasons, other paths and transport errors retain existing behavior. The dialog and input remain available; this does not claim create mutation variables never retain credentials.

Delivery is best effort: synchronous noninterruptible work, cleanup or disconnect can exceed the reserved window. Buffered writes can arrive after deadlines; no hard byte-arrival guarantee is asserted. No JSON replacement or extended budget after successful200 begins.

## Prior observation retained, not repaired by a success claim

The unchanged original300-row >16MiB HTTP success test failed at initial export EOF on current canonical source. One separate diagnostic measured age.Encrypt29.1797s of the configured30s budget, followed by source validation DeadlineExceeded and socket error-write timeout. This was whole age.Encrypt/KDF/header setup, not a pure KDF CPU measurement or proof that race overhead caused it. Emission and copy were not reached. The30s race fixture differs from the default10minute service setting.

Original large HTTP success assertions remain unchanged and their failure is not reinterpreted as a pass. No automatic whole40000/package or original large HTTP rerun was performed for this candidate.

## Verification

- Behavioral RED: expired generation and late-nil completion produced EOF instead of delivered503; success transition absent; unsupported success control not fail-closed. UI trusted503 did not localize.
- GREEN race Go:11 export socket/operation cases cover delivered error, late nil, ordinary success, real socket timeout without success-reserve reuse, unsupported initial/success controls, cancellation during success transition, record/generic failures, beyond-reserve delivery uncertainty, unauthorized exclusion and same-router gate release/retry. Final-operation substitute preserves real auth/decode/private spool/deadlines/headers/cleanup; synthetic ciphertext is not a crypto E2E claim.
- Existing13 publication/restore/HTTP cases also passed, including real archive export/preview/fresh restore. Export invalid-input allowance assertion was explicitly updated to distinguish error reserve from successful-copy deadline.
- UI57 tests across4 files passed (14new export API/DOM cases plus43 existing restore cases); typecheck and production build passed.
- Built UI two controlled503 browser scenarios at1440px/390px passed: pending state, localized error, retained inputs/dialog, no download/success/automatic retry. Four screenshots retained. This is intercepted response UI evidence, not real timeout generation end-to-end.
- Independent review identified and closed a cancellation-after-tightening gap with deterministic coverage. No remaining source-review blocker. Independent actual-pixel review of all four screenshots found no blocker: readable localized error, clean390px wrapping, masked retained inputs and distinct pending/error controls; recorded in browser/VISUAL-REVIEW.md.

Canonical source remained unchanged during candidate work. Browser build/test source manifest was identical before/after; final candidate differs from materialized canonical in exactly six source/test files. Source was frozen during green stages; their runners record commands/results but did not independently snapshot source per stage. Original large HTTP test bytes remain identical.

Evidence outside repository: backup-export-error-candidate-20261024 red/green stage logs/receipts, browser/receipt.json and four screenshots, integration proposal hashes. Historical observations: backup-current-http-acceptance-20261024/RESULT.md and phase-proposal/RESULT.md.
