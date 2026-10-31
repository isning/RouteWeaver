# Account security UI (2026-10-31)

Implements the supported local-browser contract in `docs/security/ACCOUNT-SECURITY.md` (backend change `90e80bb`, composed by coordinator). No actual accounts were changed.

## User tasks

- `#account-security` is available to ordinary users and administrators through workspace navigation and the account menu, not only platform settings.
- Self-service password change requires the current password and fresh TOTP when enrolled, validates 12–72 UTF-8 bytes and confirmation, then passes the returned user/CSRF pair to the session lifecycle. The lifecycle commits the rotated transport before refreshing private queries. Other sessions are revoked by the backend; downloaded node credentials are explicitly outside this effect.
- Session listing identifies current versus other sessions without inventing device/IP metadata. Individual revocation requires a target/consequence confirmation; current-session revocation forgets local authentication. Revoke-others requires fresh credentials and retains the current session.
- Forced password-change users see only account security, without rendering ordinary workspace pages, admin recovery, or MFA enrollment. Existing administrator-only MFA setup remains available on this page once password change is complete; no unsupported ordinary-user enrollment is exposed.
- Administrators can disable/enable, permanently retire, reset password or reset enrolled MFA. Target name/username, action-specific consequences, required reason and fresh administrator credentials are in the task dialog. Retirement requires the typed login name. Reset password does not send credentials anywhere and explains required change on next login. Self and retired targets are not offered administrative mutation; server enforcement remains authoritative.

## Task lifetime and errors

Password/recovery drafts survive ordinary errors. Wrong fresh authentication is shown as a retryable error, not an invented successful change. Recovery close/navigation uses dirty guards; success/close/account replacement clears secret fields. Mutations are single-flight and do not automatically retry. Account-keyed task ownership ignores late completion after switching accounts. Expired-session failure uses the existing concealed recovery boundary and does not resend the operation. Session IDs are opaque identifiers, never cookie tokens or digests.

## Executed verification

- Red: new page was unavailable; ordinary-user navigation/forced-password tests failed before routing implementation. Administrative recovery test failed before the management task existed.
- Green: **16 new UI/HTTP-boundary tests** cover password/CSRF handoff, ordinary-user navigation, forced-change routing, fresh MFA, byte length and confirmation, fresh-auth error retention, other/current session revocation, stale account completion, expiry, all five administrator actions, and failed recovery/discard retention.
- Combined focused regression run: **90 tests passed in 5 files** (`account-security`, `session-recovery`, `navigation`, `navigation-focus`, `workspace`, all `.dom.test.tsx`), with one worker. This overlaps earlier F01–F04 evidence and must not be added as disjoint coverage.
- TypeScript typecheck passed using the exact-lock dependencies installed for F01–F04. Playwright list-only collection is recorded separately; collection is not browser execution.

## Pending coordinator gates

`web/tests/account-security.ui.spec.ts` adds read-only synthetic 320×360, 390×844, 640×400 reflow and desktop keyboard/focus/overflow checks plus forced-change isolation. These browser tests are deliberately **not run locally** because the host browser denial remains authoritative. Private CI must execute and inspect resulting screenshots before claiming rendered acceptance. Backend/HTTP tests independently establish credential/session/account policy; these UI fixtures do not establish full real-backend browser workflows or live credential recovery. No production-ready claim follows from these focused checks.
