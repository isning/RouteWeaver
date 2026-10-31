# Local account security and trusted proxies

## Account versus subscription user

A local **Account** authenticates a person. The existing domain **User** controls subscription entitlement; its enable/delete APIs are not account deprovisioning. Deleting a domain User still denies feed delivery without deleting the local identity or its private data. Use the account security actions to disable or retire a person's access.

- Disable: blocks login, existing sessions, and feed delivery. Subscription choices are preserved. Enable removes the account block but does not override a disabled/missing User or other entitlement limits.
- Retire: permanent account disablement, session revocation and feed denial. Private data and audit history remain; this is not erasure and the username is not recycled.
- Reset password: administrator sets a temporary password. All target sessions are revoked. The next login can only use the account security/password workflow until the person changes that password; existing MFA still applies.
- Reset MFA: explicitly clears enrolled/pending MFA and revokes all target sessions; it does not change the password. Confirm the person's identity through your organization's recovery process before using it.

All administrative account mutations require a local browser session, CSRF, fresh administrator password, and a new TOTP when enrolled. Each mutation and its required audit record commit together. A privileged API bearer cannot call these recovery actions. Self-targeted administration, retired-account changes and removal of the final active administrator are rejected. Self-service password changes require the current password and fresh MFA, rotate the browser cookie and CSRF, revoke every older session, and preserve other accounts' sessions. Do not reuse the TOTP used for login; wait for the authenticator's next code.

The browser must adopt the successful password-change response's `csrfToken` and `user` together. Wrong reauthentication returns 403 without signing the current session out. Missing/expired session returns 401. Concurrent state changes return 409; storage/audit failures return 500 without committing the change.

## HTTP contract

- `POST /api/auth/password`: `{currentPassword,newPassword,totp?}` → normal `{user,csrfToken}` session response.
- `GET /api/auth/sessions`: `[{id,expiresAt,current}]`. IDs are independently random, never bearer tokens, session digests or CSRF values. Only owned, unexpired sessions are shown; active sessions are capped at 32, oldest expiry first. Expired sessions are cleaned opportunistically. Older sessions receive presentation IDs on listing.
- `POST /api/auth/sessions/revoke-others`: `{currentPassword,totp?}` → `{ok:true}`.
- `DELETE /api/auth/sessions/{id}`: owner-only → `{ok:true,current:boolean}`. Revoking current also clears the browser cookie.
- `GET /api/admin/accounts`: safe account summaries only.
- `POST /api/admin/accounts/{id}/security`: `{action,currentPassword,totp?,newPassword?,reason}`. Actions: `disable`, `enable`, `retire`, `reset-password`, `reset-mfa`. Reason is 3–500 bytes and must not contain passwords or MFA secrets. Response is the safe target account summary.

Passwords are 12–72 UTF-8 bytes, use product-standard bcrypt cost 10, and are never returned. Unknown/disabled logins perform the same bcrypt work before a uniform credentials failure. Invalid/corrupt/non-product-cost hashes (including malformed salt encodings with valid cost headers) fail closed using the dummy comparison rather than consuming attacker-selected bcrypt cost. No delays or sleeps are used. The timing regression catches the former early return; it is not a mathematical constant-time proof.

## Reverse-proxy configuration

By default no forwarded address is trusted. Configure `--trusted-proxy-cidrs '127.0.0.1/32,::1/128'` only when these are the actual immediate proxy addresses. Never trust an entire shared client network. `/0` is rejected. An invalid configuration refuses HTTP service. The existing explicit `--public-origin https://console.example.com` configures browser origin/cookie behavior independently; forwarded Host/Proto remain untrusted.

The proxy must overwrite X-Forwarded-For with its observed client address, or append the observed immediate peer to a correctly maintained chain. RouteWeaver walks the chain from right to left through trusted hops and stops at the nearest untrusted hop. Malformed, duplicate or excessive (>32 hop) headers fall back to the socket peer. A client cannot choose its source by sending headers directly to an untrusted peer.

Five-minute fixed-window budgets are separate for login, invite acceptance and authenticated security operations: 20 account/source attempts, 100 per account across sources, 200 per source and 1000 globally per purpose. Blocked narrow buckets do not keep consuming broader budgets. Keys are bounded hashes for account names; at most 10,000 buckets are retained, with expired entries cleaned when capacity is reached. A saturated limiter fails closed for new keys. These are single-process defenses, not distributed abuse protection; deploy one control-plane writer and enforce suitable upstream network limits. Publicly shared NATs may still hit the broader source cap. Limits are not a guarantee against intentional account lockout or a large distributed attack.

## Lost initial administrator / offline recovery

Recovery is an explicit **offline local operator** command, not a web endpoint or a recovery-token bypass. The operator needs the existing database and its master encryption key. It can only recover an existing, non-retired administrator; it cannot create an identity, recover an ordinary user, recycle a retired username or decrypt a database without the key.

1. Stop every control-plane process using the database. Keep an encrypted backup under the existing backup procedure.
2. Run the same control-plane binary with `--db /absolute/path/state.db --recover-account admin-name --recover-reason 'Verified operator recovery reference'`. Supply the temporary password through private standard input (12–72 bytes, one line). Never place it in command arguments, shell history, logs or a checked-in file. Supply the normal `ROUTEWEAVER_MASTER_KEY` through your established protected environment mechanism.
3. To recover a lost authenticator, additionally pass `--recover-disable-mfa`; omission preserves MFA. The operation revokes all old sessions, enables the administrator and requires a new password at next login. The recovery audit and mutations commit atomically. No listener starts in recovery mode.
4. Start the normal service, sign in with the temporary password (and retained MFA if applicable), change it, then re-enroll lost MFA. Remove temporary handling material according to your secret-management process.

The CLI and `Store.Open` share one filesystem-only path normalizer: SQLite `file:` URIs, `:memory:`, and paths containing `?`, `#` or NUL are rejected before filesystem mutation. Existing symlink ancestors are resolved, and the identical absolute plain path is used for locking and SQLite; query parameters are never silently interpreted.

Normal service and recovery both hold an exclusive nonblocking OS advisory lock on the database inode for their entire lifetime. This catches canonical path, symlink and hardlink aliases and refuses recovery while another participating service is running. Do not replace/unlink the live database or run older binaries/tools that do not participate in this lock; an advisory lock cannot control nonparticipating software. Linux and macOS are supported; other platforms fail closed. Linux lock behavior is tested locally; Darwin cross-compilation is separate from real macOS runtime verification. Direct Store handles used by tests remain independent of the CLI process lock.

## Credential presentation

Ordinary profile/source summaries, saves and previews use shared presentation redaction, including transport URL query/fragment data. Authorized reveal and exported client artifacts retain real credentials; persisted intent is not rewritten. Redacted UI data must not be saved as an authoritative replacement for unrevealed credentials. Security-action audit records never contain passwords or TOTP values.
