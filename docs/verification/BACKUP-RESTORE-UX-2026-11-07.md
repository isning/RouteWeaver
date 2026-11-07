# Encrypted backup recovery: current UI acceptance candidate

Source inspected: `52c0eb0b56058bf5ac7b6e2e4f541f49789f0854`, plus the six-file candidate listed below. **Current behavior tests, browser execution, independent pixel review and final CI are pending.** This record does not declare a current acceptance pass.

## Finding and bounded correction

The existing actual-file browser journey already joins encrypted download, wrong-password correction, archive inspection, exact confirmation, inactive fresh restore, a second normal CLI on the exact returned target, restored login/source content, and the original live source sentinel. It had one default-desktop case, no explicit captures, and only asserted that an alert appeared after a wrong password.

Source review found that preview's `backup.ErrInvalid` HTTP 400 reached the Chinese UI unchanged as `backup cannot be authenticated or is incomplete; check the passphrase and file`. The candidate adds `reason: backup_archive_unverified` only for that error in the existing preview endpoint. The original safe `detail` remains available. Other preview errors and every other endpoint retain their existing behavior.

The browser API adapter translates only exact `/admin/backups/preview` + HTTP 400 + that known reason to:

> 备份无法验证。请核对密码，并确认文件完整后重试。

This does not infer whether the password or archive is wrong. It does not relabel authorization, resource-limit, transport, malformed-response, or unknown failures as an archive/password rejection.

## Existing journey extended, not duplicated

The same isolated normal-CLI test is parameterized at 1440×1000 and 390×844. Each case keeps a fresh private temporary database/key and genuinely downloaded encrypted archive. It asserts:

1. Export disclosure, actual `.age` download and age envelope; file selection alone does not upload or restore.
2. Real HTTP 400, exact actionable recovery text, retained filename/password, enabled inspection retry and no successful inspection/restore action.
3. Corrected input, real successful inspection, fresh-target/nonreplacement/restart impact, archive details and credential-review consequence. Empty/wrong confirmation remains disabled; inspection and typing the exact phrase send no restore.
4. Keyboard traversal to the uncovered restore action; one explicit Enter produces HTTP 201, `activated: false`, cleared inputs and the exact inactive target result.
5. The existing fixture validates the returned target's safe basename, actual regular mode-0600 file, and exact location. A second ordinary CLI uses that target without bootstrap credentials; a new cookie-free API context verifies restored login/source data. The original running database retains its post-export source change. No live database is replaced or switched.

Four captures per width are authored: `backup-export-decision`, `backup-password-rejected`, `backup-restore-decision`, and `backup-restored-inactive`. They wait for actual finite task motion, retain readable filename/confirmation/consequences/target, and mask only password inputs inside the current task. Traces, video and automatic screenshots remain off. The real export toast is allowed to finish before the next decision is captured; no animation is disabled or timeout increased.

The export capture is a viewport image. Restore captures are full-page images so the file, error/inspection, consequences and result can be independently inspected together; they do **not** prove those elements are simultaneously visible in one narrow viewport. Keyboard focus and final-action visibility/occlusion have separate assertions. Screenshots are not yet available for this candidate.

## Historical evidence remains separate

`BACKUP-RESTORE-BACKEND-JOURNEY-2026-11-01.md` contains the original authoring-time **UNRUN** browser status. The later [exact browser reconciliation](BROWSER-STORY-PAGE-RECONCILIATION-2026-11-01.md) records the existing backup browser journey as **1/1 passed** at `81dd62054e36b45c4c2f2c670d121ad3a7553b68`, [CI run 41351035317](https://github.com/isning/RouteWeaver/actions/runs/41351035317), with its checked artifact receipt. That historical functional pass supersedes the earlier UNRUN status for that exact journey/source only. This candidate does not rewrite the historical report or treat that older pass as current desktop/narrow visual acceptance.

## Candidate checks and review boundary

- HTTP seam assertions were authored before the handler correction: wrong-password and unverified-file errors share the known reason; a different password-format rejection retains its own detail without the reason.
- Adapter seam assertions were authored before the translation: known reason, wrong endpoint/status/unknown reason, malformed response, transport loss, and successful ordered multipart inspection.
- Local `git diff --check` and Node v24.22.1 native TypeScript syntax checks passed. Syntax parsing does not resolve imports, typecheck or execute tests.
- The repository's locked web dependencies and Go 1.27.3 compiler are absent locally. No dependency installation or substitute cached runtime was used. Go tests, frontend tests/types, browser execution, actual images, independent review and final exact-source CI remain pending. No executed failing-before-passing result is claimed.
- No archive-format, restore/storage, authentication, accounting, runtime policy, endpoint, deadline, deployment or live-data change is included.

Frozen review scope:

- `internal/httpapi/backup.go`
- `internal/httpapi/backup_test.go`
- `web/src/api.ts`
- `web/src/backup-preview-api.test.ts`
- `web/tests/backup-restore-backend.ui.spec.ts`
- `docs/verification/BACKUP-RESTORE-UX-2026-11-07.md`

Required verification on the authorized exact toolchain: focused HTTP backup test; frontend API test and types; both existing OPS01 API/browser cases through `playwright.backup.config.ts` (now two browser viewports); independent review of all eight captures; required aggregate CI for the final source. The coordinator owns publication and final evidence reconciliation.
