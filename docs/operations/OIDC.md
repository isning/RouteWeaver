# OIDC sign-in for existing accounts

OIDC is optional and disabled by default. This release supports one operator-
configured provider and explicit identity bindings to existing local accounts.
It does not register users, accept invitations, match email addresses, import
provider roles or replace the local password/recovery path.

## Configure

Register a confidential authorization-code client with your identity provider.
Allow this exact callback URL (no wildcard):

```
https://control.example/api/auth/oidc/callback
```

The provider must support OpenID Connect discovery and PKCE S256. Discovery,
authorization, token and JWKS URLs must use HTTPS with normally trusted TLS.
Outbound discovery/token/JWKS redirects are rejected. Only `openid` is requested;
no offline access or refresh-token storage is used.

Create a private JSON file outside the repository, readable only by the service
account (normally mode `0600`). Maximum size is 1 MiB; unknown fields are rejected.
Example structure, not deployable credentials:

```json
{
  "issuer": "https://identity.example/realm",
  "clientId": "routeweaver",
  "clientSecret": "REPLACE_OUTSIDE_SOURCE_CONTROL",
  "label": "公司账号",
  "bindings": [
    { "subject": "EXACT_PROVIDER_SUBJECT", "accountId": "EXISTING_LOCAL_ACCOUNT_ID" }
  ]
}
```

Use the provider's exact opaque subject identifier, not an email, username or
screen name. The configured issuer scopes every subject. Confirm the local
account ID and its existing role separately. Invitations and account creation
still use the established local workflow. Multiple explicit subjects may point
to the same account; duplicate subject entries are rejected. Do not guess a
binding from an email match.

Start the control plane with its normal database/security options plus:

```
--public-origin https://control.example --oidc-config /private/oidc.json
```

The configured public origin must match the browser-facing HTTPS origin. A TLS
proxy must preserve that Host and forward the complete callback query. Invalid
configuration or failed discovery prevents startup; demo mode rejects OIDC.
No real provider is configured by this source change.

## Sign-in and account protection

The login page keeps password sign-in and adds the configured provider button.
A verified provider identity only selects its explicitly mapped local account.
The callback creates a short-lived pending login, not a complete session. A
same-origin completion request finishes login; local TOTP is still required
when enabled. A wrong/expired attempt must restart provider sign-in. Disabled or
retired accounts cannot log in, and account/security changes during a pending
login invalidate it. Required password changes remain enforced.

Authorization, route access and administrator roles continue to come from the
local account. OIDC does not authorize provider account management or create
new local privileges. Local password confirmation remains necessary for the
existing sensitive account-security operations.

State, nonce and PKCE verifier are separate random values. Authorization and
pending-login transactions expire after five minutes and are single-use,
browser-bound and held only in bounded server memory. Temporary cookies are
Secure/HttpOnly/SameSite=Lax; the normal session remains SameSite=Strict. IdP
access/refresh/ID tokens are not persisted or returned to the frontend.

## Operations and limits

Configuration and bindings are immutable for the process lifetime. Restart to
change them; every pending sign-in is invalidated and must be restarted. There
is no automatic account-linking UI or hot reload. Removing a binding prevents
new OIDC sign-ins but does **not** revoke already established local sessions;
use the existing session-revocation or account-disable controls when required.

The current control plane uses a single process/database lock. OIDC transaction
state is not replicated. Routing a callback/completion to a different process
fails closed; this feature does not add multi-replica login support. A process
restart does not create or restore a session from a pending transaction.

Do not log callback query strings, authorization codes, cookies, tokens or the
private configuration, including at the reverse proxy. Keep the local
administrator login and documented offline recovery available for IdP outages.
If discovery prevents startup during an outage, start the same database without
`--oidc-config` to restore local-only login; do not weaken TLS/token validation.
Provider credentials, public DNS/TLS and actual provider interoperability must
be configured and verified by the deployment operator. Controlled signed-IdP
fixtures are software evidence, not a real-provider deployment claim.

## Controlled browser verification

The `browser_native` verification gate also runs `TestOIDCBrowserCrossSite`
with the `oidc_browser_acceptance` build tag. It uses an isolated temporary
account and signed test IdP, with HTTPS `localhost` and `127.0.0.1` origins
(different sites), actual browser navigation, and sandboxed Chromium. Only the
fixture certificate's exact public-key fingerprint is trusted by that browser
process; no production TLS or system trust settings change.

This serves the production React build from the test application and uses its
SSO button, confirmation and local MFA form. It checks the protocol/cookie
boundary, the checked account identity and consumed-proof replay rejection.
Successful anonymous callbacks must clear their query marker in React; the
already-authenticated replay checks server rejection and session preservation,
not query cleanup. This does not verify a real provider, public DNS/CA trust, or
a production deployment. A browser startup
failure is a failed check, not a skipped success. Run the focused check with an
installed Chromium and the locked web dependencies:

```sh
npm --prefix web run build
ROUTEWEAVER_CHROMIUM=/path/to/chromium scripts/go.sh test \
  -tags oidc_browser_acceptance ./internal/httpapi \
  -run '^TestOIDCBrowserCrossSite$' -count=1 -timeout=3m
```
