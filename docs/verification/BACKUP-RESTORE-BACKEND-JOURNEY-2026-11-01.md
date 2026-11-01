# OPS-01: real backup-file → fresh restore journey

Status: **OPEN / partial**. Browser execution is **UNRUN**. The API companion now verifies the exact returned target
through a second ordinary CLI, including restored login and source configuration.
The same data join is authored for the browser journey but remains **UNRUN**.
Accounting and semantic published-routing coverage remain separately scoped. No production-readiness or recovery-drill sign-off.

## Step-by-step acceptance checklist (single control plane / Linux / private invite)

1. Start an isolated ordinary CLI control plane on loopback with synthetic
   bootstrap credentials, a generated test-only master key, and a private DB directory. Authenticate normally as
   the synthetic administrator; seed a uniquely named source through the API.
2. In Settings → Backup and restore, create a backup with matching independent
   passwords. Save the actual browser download, check its `.age` name and age
   envelope, and select that exact saved file through the file chooser.
3. Make a post-backup change to the running source. This is the independent
   sentinel that must survive restore; a successful result alone is insufficient.
4. Enter a wrong backup password. Require a real HTTP 400, a visible error, no
   successful preview or restore action, and preserved file/password inputs.
5. Correct the password and preview. Show the fresh-database/no-live-replacement
   consequence. Empty/incorrect confirmation must leave restore disabled.
6. Enter the exact localized confirmation and restore. Require HTTP 201,
   `status: restored`, `activated: false`, a safe target basename, and the visible
   “restored to a new database, not enabled” result. Clear sensitive inputs.
7. Read the live source through the API and verify its post-backup change remains.
8. **API joined identity/config check PASS; browser version UNRUN:** take the
   actual restore response target, require an existing regular mode-0600 file in
   the private staging directory, and start a second normal CLI on that exact DB.
   Reuse only the test-generated key; supply **no bootstrap credentials**. A new
   cookie-free API context must log in and retrieve the pre-export source ID,
   name and content via the supported reveal API. Confirm the original running
   source still has its post-export name. Do not replace the live database.
   This deliberately does not claim restored semantic published routing choices
   or every record type; accounting obligations remain the separate Go test.
9. **PENDING authorized browser execution:** run and retain actual results on an
   authorized compatible host before closing OPS-01. Local Chromium launch is
   denied; listing/typechecking does not establish browser behavior. Remote CI
   spend/publication requires separate approval and was not initiated here.

## Added paths and evidence boundary

- `web/tests/backup-restore-backend.ui.spec.ts`: steps 1–7 authored with real HTTP,
  no route interception or fabricated preview/restore result. Temporary downloaded
  file is inside a private `mkdtemp` directory, removed in `finally`.
- `web/tests/backup-restore-backend.api.spec.ts`: browser-free real CLI companion
  passes encrypted download, multipart wrong-password rejection, preview,
  missing-confirmation and stale-digest refusal, inactive fresh restore, replay
  refusal, unchanged-live sentinel, and exact-target login/config data join.
- `web/tests/backup-restore-fixture.ts`: worker-local builds of the normal CLI
  and compiled web UI, per-test private state, loopback port-zero listeners,
  captured actual URLs, and owned-process cleanup. All inherited `ROUTEWEAVER_`
  operator configuration is removed from server environments. Keys remain in
  process environment/memory, never command arguments or log attachments.
- `web/playwright.backup.config.ts`: selects only the two OPS01 cases, without
  a shared demo server/Vite proxy. API-only selection launches no browser.
- `internal/store/backup_admission_obligations_test.go`: encrypted stream → fresh
  store preserves an actually issued outstanding byte budget. Public admission
  remains blocked pending final evidence; final replay charges exactly once,
  returns exactly the unused 70 of 100 bytes, and does not settle the live store.
- Existing `TestBackupFreshRestorePreservesSecretsIdentitiesIndexesCountersAndHistory`
  verifies identities, MFA recovery state, sessions, feed token/index, profile
  revision records, usage replay, counters and history. This is not an actual
  browser target or full semantic published-routing choice drill.
- Existing HTTP fresh-restore and multipart/large-archive tests verify real target
  data, nonactivation and source isolation at their own HTTP/store seam.

## Validation

Evidence: `evidence/ops01-backup-restore-2026-11-01/`.

- PASS: real-backend API companion, one worker, `CI=1`, test-owned normal CLI
  instances (no server reuse), compiled UI asset serving and exact-target data join.
- PASS: canonical API config executes the joined OPS01 case; unchanged default
  browser discovery includes it among 177 tests in 44 files. `verify.sh` still
  invokes these same scripts; no gate exclusions or default config edits.
- PASS: application TypeScript; explicit strict TypeScript of all three new web
  test files (application tsconfig excludes tests).
- PASS: Playwright browser discovery, one test; **browser execution UNRUN**.
- PASS: focused Go store tests (new obligation case plus existing full-state
  restore) and focused Go HTTP tests (fresh restore and multipart large archive).
- PASS: new outstanding-obligation regression under Go race detector.
- PASS: pinned Gitleaks 8.24.3 source/index/reachable-history plaintext scan;
  not a credential validity or security certification.
- No product code changed. Initial API authoring run expected source creation
  HTTP 201; observed documented handler HTTP 200 and corrected the assertion.
  This was a test-authoring mismatch, not a product regression/red-green claim.
  The joined check initially expected secret source content from the summary
  route; it now uses the existing explicit reveal route. An initial dedicated
  config inherited broad project matches; fixed to select only OPS01 projects.
  Neither authoring mismatch is claimed as a production defect.
- Independent review and full aggregate suite remain separate coordinator gates.

Reproduction after installing the locked dependencies and configured Go compiler:

```sh
cd web
CI=1 node node_modules/playwright/cli.js test --config=playwright.backup.config.ts --project=api --workers=1
npm run typecheck
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict \
  --target ES2022 --module ESNext --moduleResolution bundler \
  --esModuleInterop --skipLibCheck --types node \
  tests/backup-restore-backend.ts tests/backup-restore-backend.api.spec.ts \
  tests/backup-restore-backend.ui.spec.ts tests/backup-restore-fixture.ts \
  playwright.backup.config.ts
node node_modules/playwright/cli.js test --config=playwright.backup.config.ts --project=chromium --list
# ONLY on an authorized compatible browser host, not this denied host:
CI=1 node node_modules/playwright/cli.js test --config=playwright.backup.config.ts --project=chromium --workers=1
```

Fixtures are synthetic and never contact the `.test` source endpoint. Teardown
stops only owned CLI processes before removing their private state and builds. No real credentials,
external targets, node process, CI dispatch, push, merge or deployment was used.
