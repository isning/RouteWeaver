# SEC-04: real-backend account-security journey preparation

Status: **partial; real-browser execution pending**. This is not a production-readiness sign-off.

## Added evidence paths

- `web/tests/account-security-backend.ui.spec.ts`: two browser journeys using the real UI, Vite proxy and ephemeral Go control plane. No API responses are fulfilled/mocked. Existing fixture-only responsive account-security tests remain separate.
- Password change: failed reauthentication preserves the draft and sessions; a successful change rotates the HttpOnly / SameSite Strict cookie and CSRF, invalidates both a separate session and the exact former browser cookie, rejects former CSRF, and permits another UI mutation without reloading. Former password login is rejected; fresh login with the new password works. The administrator session is unaffected.
- Administrator recovery: wrong administrator password preserves the recovery form and target access; successful reset invalidates target access. Temporary-password login is confined to account security, including direct navigation and HTTP denial. Self-service replacement restores ordinary access.
- `web/tests/account-security-backend.api.spec.ts`: browser-free real-HTTP companion validates synthetic invitation setup, rotation, recovery, and denial of an ordinary user's attempted reset of another synthetic account. It is not browser evidence.

## Isolation and safety

Use only the existing loopback `--demo` harness. Accounts have unique UUID-based usernames; no real users, external credentials or shared demo administrator password are changed. API/browser contexts are closed, and no storage state is written to disk. The harness removes its ephemeral database when its owned process shuts down; an explicitly reused local demo server retains synthetic identities until shutdown. Traces, screenshots and videos are disabled for these security journeys. Assertions on cookie/CSRF changes use booleans rather than printing values.

For a future authorized browser run on a suitable host, use `CI=1` so Playwright refuses to reuse an already-running server:

```sh
cd web
CI=1 npm run test:browser -- tests/account-security-backend.ui.spec.ts --workers=1
```

Do not run this command on a host where Chromium launch is denied. No Chromium or sing-box process was launched for this change; no remote workflow was dispatched.

## Validation recorded

- Full web application TypeScript check passed.
- Explicit strict TypeScript check of the three new test files passed (the application's tsconfig does not include tests).
- Playwright discovery lists two browser tests; listing does not launch a browser.
- Real-backend API companion passed against the ephemeral demo control plane.
- Focused Go HTTP tests passed: `TestAccountSecurityHTTPRotationCSRFAndOwnership` and `TestAdminAccountDisableResetAndRetirementHTTP`.
- Existing account-security DOM tests passed: 16 tests.
- Pinned Gitleaks 8.24.3 source/index/reachable-history scan passed after its official checksum-pinned bootstrap; this is a plaintext-pattern scan, not a security certification.
- Independent source review found no blocking defect after adding explicit cross-account denial coverage; browser behavior was not independently executed.

## Remaining acceptance

Run both browser cases on an authorized host and retain their pass/failure evidence before marking SEC-04 complete. These cases do not establish TLS/reverse-proxy deployment, real-account recovery procedure, MFA enrollment/TOTP, offline operator recovery, or full-suite production readiness. No failing-before-passing browser result is claimed.
