# Invited-user creation uncertainty: source reconstruction

## Identity and evidence status

This is a new bounded reconstruction on a1fbbc3 (recovered integration v88), not recovery of historical v133 commit 579cdbd3f6d629296d0fc9be6fdcb0d786d72a39 and not a claim of exact behavior or tree parity. The historical report described explicit account-login recovery after uncertain creation, no automatic credential replay, uncertainty remaining through a later 4xx, and authoritative `/auth/me` validation. It also described uncertainty as non-durable across mode exit/reload. Those are the bounded requirements used here.

ALL runtime verification is UNRUN. No Node, npm, Go, gofmt, browser, server, network, install, push or deployment was used. No real account, invitation or credential operation was performed. Authored regression source is not passing evidence. Red-before-green execution was unavailable under the source-only constraint; no TDD execution claim is made. Git diff whitespace checks and manual source reading are the only checks performed.

## Source scope

- `web/src/App.tsx`: public login/invitation form only, including adjacent login-mode ownership needed to prevent stale validation and credential crossover.
- `web/src/invite-uncertainty.dom.test.tsx`: public App/UI plus HTTP fetch boundary regression source, real SessionBoundary, SessionLifecycle, form and API implementations. No internal application collaborator mocks.
- This verification record. No server/API/session-lifecycle implementation, dependency, configuration, generated bundle, or deployment change.

## Inspected contracts and behavior

`internal/httpapi/auth.go` calls `AcceptInvite` before `establish`; session establishment may fail after the account has been created. `internal/store/identity.go` consumes the invitation in account creation. A 500, transport rejection, unreadable response body, malformed JSON, or structurally invalid success must therefore not tell the user that the account does not exist. Known rejection statuses retain ordinary editing and the server error, without asserting global account nonexistence.

Within the current invitation form, an unknown outcome adds a task-specific warning and points to explicit account login using the account/password just chosen. Further attempts are still explicit submissions; a later 400/other known rejection cannot clear this earlier uncertainty. Existing transient form fields retain their values on failure. There is no stored copy of attempted credentials and no automatic login. An unknown invitation outcome also triggers read-only session reconciliation, including stale attempts, because the cookie might have changed even if its response was unreadable.

The mode-keyed form owns validation and submit state. A synchronous lock prevents multiple in-flight submissions from one form. A late validation completion after unmount or while the session boundary hides the form does not dispatch. Offline submission is rejected locally and is never queued for reconnect. Mode exit discards that form's values and uncertainty; returning to invitation mode may reuse the existing invitation URL parameter, as before. Ordinary login requests explicitly contain username/password/optional OTP, never invitation or administrator tokens. Administrator-token mode starts empty, not with the invitation URL token. No new persistence or URL credential writes are introduced. Existing invitation URL handling is unchanged.

Successful obsolete auth completions still reach `SessionBoundary`'s existing `signedIn` callback. It ignores the returned identity and rechecks `/auth/me`; workspace selection remains authoritative and waits for confirmation. Old form errors/busy flags cannot update a newer mode. The reconstruction does not make invitation outcomes durable or add server idempotency, retry workers, or account-existence inference from authentication failure.

## Authored regression cases (all UNRUN)

- Lost response, 500, malformed JSON 200, null/incomplete 200 and body-read failure: visible uncertainty, no automatic login, explicit login with freshly entered values, no browser-storage writes.
- Later 400 leaves earlier uncertainty visible; initial definite 400 preserves editable input and corrected explicit retry.
- Repeated submission during a held response emits one creation; old failed response cannot overwrite newer mode/input.
- Form validation settling after mode exit cannot create an account.
- Offline submit/reconnect does not queue or replay account creation.
- Obsolete successful creation waits for `/auth/me`, and the confirmed identity wins over response identity.
- Malformed success with a valid server cookie reconciles through `/auth/me` without creation replay or login POST.

## Review limits and next verification

Manual standards review considered AGENTS.md, GLOSSARY.md, content-design rules, and the supplied tdd/tests/mocking/code-review skill texts. Manual spec review compared the bounded historical report against the changed public flow. Independent runtime review remains unrun; no executable review pass is claimed here.

Potential limitations requiring runtime investigation: form-library asynchronous validation lifecycle, React StrictMode and unmount timing, focus on mode exit, actual response-stream failures, authentication race behavior across tabs, and rendered desktop/narrow layouts. Initial malformed `/auth/me` handling is unchanged and not claimed fixed. The existing baseline may have unrelated failures. This source is not runtime acceptance, deployment readiness, or proof that all historical missing work is restored.

When execution is authorized, run the focused new DOM suite and related session-recovery/login suites with one worker, type/lint checks, then the repository's aggregate verification gate. Verify actual rendered recovery copy and explicit login through sample-only test accounts before any readiness claim.
