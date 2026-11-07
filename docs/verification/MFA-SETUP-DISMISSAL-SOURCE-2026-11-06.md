# MFA local setup dismissal: source reconstruction only

Baseline: a1fbbc3. This is a bounded new reconstruction, not recovery of lost v93 or v102 source. No runtime checks were performed. Node, npm, Go, gofmt, browser, servers, network, installation, publication, deployment and real accounts were out of scope.

## Source findings

- `internal/httpapi/auth.go:81–126`: setup requires a local administrator and password; enable consumes an OTP and returns a new session/cookie. No cancellation endpoint exists.
- `internal/store/mfa.go:10–49`: setup replaces a pending secret for ten minutes. Enable validates that pending secret, commits enabled state, consumes the step and clears pending material. `commitSession` revokes older sessions atomically with creation of the replacement.
- Closing the UI cannot delete the server pending secret or undo an enable. Repeating setup replaces pending material. A lost enable response may mean the account is enabled and old sessions are already revoked.
- `SessionBoundary.tsx` and `SessionLifecycle.ts` own account epoch, transport generation, cookie revalidation and private workspace isolation. A same-actor rotation is not permission to retain enrollment material.
- Baseline `Security.tsx` kept setup material in both component state and the mutation result cache, left old enable errors on a new setup, and had no callback mount ownership fence.

## Bounded changes

`Security.tsx` gives each account epoch/transport generation a separate task. Setup material is kept only in component state, not returned as mutation data. Password/OTP mutation argument copies are cleared after settlement; mutations explicitly do not retry and have zero inactive retention. Layout cleanup rejects late task-owned UI updates; synchronous submission ownership guards repeated submissions within the mounted task. Local close clears form data and mutation errors, and names the actual local-only effect. Enable success still reconciles via the existing lifecycle, rather than adopting an unverified payload.

This is reference cleanup, not secure erasure of JavaScript strings, browser memory, fetch bodies, or server secrets. Pending input is still required while an authorized request executes. Definite rejected input remains in the mounted form for correction. No secret, URI, password, OTP, CSRF token or response payload is written to storage.

## Explicit remaining design gap

Unknown-enable recovery is NOT solved. A lost response, JSON parse failure, or stale-response rejection can leave the setup UI retryable. Conversely, enable does not validate the parsed success payload: any successful HTTP response with parseable JSON (and an empty successful body parsed as null) reaches the success callback. That callback can show “二次验证已启用” before `/auth/me` confirms current state. Malformed success therefore does not always leave a retryable setup; it can instead produce premature success feedback. Setup response fields are also not runtime-validated, so missing or invalid `secret`/`uri` values can enter local setup state. These are existing unresolved response-contract limits, not addressed by the bounded cleanup. Remounts can create new local submission ownership while an old write is still in flight. Other security tasks can race these writes. The existing account-security candidate at 967c1da implements a private actor-bound reminder/gate, excludes MFA actions, and does not cover the separate legacy Admin settings entry. No independent second durable lock or warning-only recovery was added here.

A coherent follow-up needs one shared account-security write owner covering MFA setup/enable, password rotation, session revocation and administrator account actions at every entry point. It must retain only allowlisted nonsecret action metadata across remounts, distinguish dispatch refusal from unknown completion, preserve actor ownership, prevent cross-flow overlap, and reconcile session rotation before reads/writes. A fresh `mfaEnabled` value describes current state, not a receipt proving whether an earlier attempt completed. A false read while an older write remains in flight must not unlock replay. Cancellation while setup/enable is pending also needs this shared ownership contract before enabling dismissal or a new setup.

## Verification source and limits

`web/src/mfa-setup-dismissal.dom.test.tsx` exercises rendered controls with only HTTP fetch substitution: failed OTP then local close/new setup clears prior error and inputs without another enable; late setup after task removal cannot resurrect the old screen or issue another write. Existing `web/tests/mfa-backend.ui.spec.ts` and `mfa-backend.api.spec.ts` cover isolated normal-backend enrollment and session revocation; unchanged and UNRUN.

All tests, typecheck, lint, formatting, browser visual/accessibility review, backend validation and aggregate gates are UNRUN. No red/green claim, no v93/v102 equivalence claim, no production-readiness claim. Source review does not establish runtime correctness; integration requires the unrun verification above and resolution of any review findings. Public UI/HTTP tests cannot prove heap erasure. Additional tests for actor switches, same-actor rotation, response loss, cross-flow exclusion and pending dismissal belong to the shared-owner work and remain absent here.
