# Real MFA enrollment, login and recovery journey — 2026-11-01

Scope: SEC04/M03, single-control-plane private invitation deployment. Tests use unique synthetic invited administrators/users against the ephemeral loopback demo. The shared demo administrator's password and MFA configuration are never changed. No recovery codes are implemented or assumed.

## Added evidence

- `web/tests/mfa-backend.api.spec.ts`: administrator-only setup/confirmation; missing CSRF and wrong enrollment password; pending enrollment stays disabled; incorrect confirmation does not revoke sessions; successful confirmation rotates CSRF and revokes older sessions; password-only, wrong-code and replay login denial; actual next-time-step TOTP login; sensitive password mutation still requires MFA; failed administrator reauthentication and self-reset protection; scoped administrator reset-MFA revokes target sessions and permits subsequent password login; unrelated user and recovery administrator remain usable.
- `web/tests/mfa-backend.ui.spec.ts`: real browser forms for setup, incorrect confirmation, enrollment, password-only/wrong/replayed-code rejection, successful TOTP login, failed and successful administrator reset-MFA, and subsequent password login. No fulfilled API fixtures or session shortcut.
- `web/tests/mfa-backend.ts`: RFC 6238 SHA-1 helper for the account's own synthetic secret, checked against an independent published vector. The helper waits for an actual next 30-second timestep rather than forging future accepted codes or changing the production clock. Traces, screenshots and videos remain disabled for these secret-bearing flows.

## Executed locally

- Real API companion: **2/2 passed**. Cold compiler/server startup included in 1.9-minute total; lifecycle test 8.4 seconds (including waiting for the next real timestep).
- Focused Go tests passed in `internal/store` and `internal/httpapi`: MFA enable/session revocation, fresh MFA/live session, concurrent administrator continuity, scoped offline recovery, and administrator account lifecycle HTTP.
- App `npm run typecheck`: passed.
- Separate strict TypeScript check of all new test/helper files: passed (the ordinary app tsconfig does not include tests).
- Playwright Chromium `--list`: one browser journey discovered. **Discovery is not execution.**
- `git diff --check`: passed.
- Independent read-only source review checked UI selectors and backend contracts; no blocking findings. Suggested ordinary-user denial and post-invalid-confirmation state assertions were added before API execution.

## Limits

The browser journey has not run locally: prior host Chromium restrictions remain authoritative. The coordinator owns authorized CI browser execution and the combined gate. No local browser or native-core launch, push, CI dispatch, production change or credential change was performed by this worker.

The API self-reset rejection is **not** last-active-administrator coverage. Existing Go `TestConcurrentAdministratorsCannotDisableEachOther` covers administrator continuity in an isolated database; no shared demo accounts are disabled to manufacture that condition. Existing Go security tests separately cover fresh MFA/live-session requirements and explicit offline administrator recovery. No new production bug or red/green production fix is claimed by this addition.
