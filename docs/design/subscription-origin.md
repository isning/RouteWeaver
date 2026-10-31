# Subscription link origin maintenance (M04 / RW-22)

Status: locally implemented backend and focused regression evidence; full story and
prerequisite acceptance remains in progress. This is not a DNS, certificate,
reverse-proxy deployment, public-availability report, or external-operation grant.

## Separate responsibilities

The subscription origin determines the address offered by the authenticated
`GET /api/me/outputs/{id}/access` response. That response returns authoritative
`feedURL` alongside the compatible `feedPath`. It uses the active custom origin,
otherwise the operator's explicit server `PublicOrigin`, otherwise a relative
same-origin path. Request `Host`, `Forwarded` and `X-Forwarded-*` headers never
select an absolute credential-bearing URL.

This setting does **not** change browser mutation-origin/CSRF trust, session-cookie
policy, TLS listeners, DNS, proxy configuration, feed tokens, or published content.
The server's explicit public browser origin remains a separate operator setting.

## Admin task and state

- `GET /api/admin/subscription-origin` returns the saved draft, effective link
  origin, independent configured/effective revisions, last verification time and
  activation-proof expiry. Example URLs use `{existing-token}`, never real tokens.
- `PUT` with `{origin, expectedRevision}` stages a canonical public HTTPS origin.
  Userinfo, non-origin paths, query/fragment data, invalid ports, localhost and
  literal non-public addresses are rejected. Empty origin explicitly stages a
  return to the server default. Staging does not perform an outbound request.
- `POST /verify` with `{expectedRevision}` explicitly authorizes one bounded
  outbound check of the saved custom origin. The proof is valid for five minutes.
- `POST /activate` with `{expectedRevision}` chooses the saved draft for link
  generation only after fresh proof, or selects the explicit default without a
  custom-domain check. It does not claim the domain is continuously reachable.

`revision` fences every mutation. `configuredRevision` changes only when staging;
`effectiveRevision` changes only on activation. Proof is bound to the configured
revision. A save clears prior draft proof. Both the initial revision and the whole
record are compared at commit, so another operator's save or an intervening
verification cannot be overwritten by a stale operation.

A malformed edit leaves the saved draft/effective state intact and the UI retains
the submitted input. A failed network or same-instance verification retains the
saved draft and previous effective origin, removes draft proof, and records a
bounded actionable failure without transport URLs or secrets. A conflict leaves
the newer record intact. An expired proof prevents a new activation; it does not
silently change an already selected origin or declare that origin offline.

## Verification protocol and limits

The verifier uses `resources.OutboundClient`: normal TLS certificate/hostname
verification, no environment proxy, no redirects, public DNS checks for every
answer, and dialing only the checked literal IP. Request context and client
bound the operation to ten seconds; responses are bounded to 128 bytes and
headers to the shared transport's limit. At most four challenges are live.

During the check only, `/feed/verify/{random-challenge}` can return a separate
random answer. The answer is never sent in the outbound URL; it is not a feed
token or persistent instance secret. The challenge is bound to the candidate
Host, expires after 15 seconds, and is removed on completion. Verification
requires HTTP 200 and the exact answer. There is no feed-token redirect.

This proves that the candidate origin reached this running instance's challenge
handler over verified TLS at the recorded time. It does not prove future uptime,
all client networks, every proxy route, certificate renewal, or a multi-instance
load-balancer's affinity. An operator must already have configured public DNS,
a valid certificate and routing for `/feed/*` to this instance. Those real
external actions remain separate and require appropriate permission.

## Existing links and credentials

Changing the origin does not rotate or revoke any token. Newly requested links
use the selected origin; old addresses continue to work only while their old
DNS/TLS/proxy route still reaches the control plane. No automatic redirect can
forward a feed token to a newly configured destination. The explicit output
rotation/revocation operations retain their existing semantics and invalidate
old tokens regardless of which domain is used. Ordinary settings and audit
records contain no feed tokens or verification answers.

## Local evidence and remaining scope

Public seams follow RW-22: settings API validation/activation, encrypted settings
repository with CAS, authenticated feed access/rotation, and the visible settings
maintenance task. No new production package or relaxed architecture rule is
needed.

Recorded red before green:

1. Admin-only staging test initially received 404; staging/validation then passed.
2. Own-instance TLS activation test initially lacked verification implementation;
   positive normal-TLS activation and failed-replacement preservation then passed.
3. Access test initially lacked `feedURL`; authoritative effective-origin links
   and unchanged-token/explicit-rotation assertions then passed.
4. Selected-subscription DOM test initially showed the browser's local origin
   instead of the API's custom HTTPS origin; current `feedURL` precedence fixed
   it while the cached-link/current-403 regression stayed green.

`internal/httpapi/subscription_origin_test.go` exercises the actual authenticated
HTTP handlers, normal TLS certificate and hostname checking over in-process
`net.Pipe`, short-lived proof, actual concurrent edit versus in-flight verification,
expired/stale rejection, default reset, member denial, no Host/header derivation,
redirect/incorrect-instance/incorrect-host/oversized-response rejection, failed
replacement retention, and domain-independent token rotation. Fixtures never
resolve or contact an external hostname. Shared resources tests separately cover
public DNS pinning, mixed/private DNS rejection, proxies and unsafe URLs.

Focused commands:

- `scripts/go.sh test -race ./internal/httpapi -run TestSubscriptionOrigin -count=1`
- `npm --prefix web run test -- --run src/task-experience.dom.test.tsx -t 'puts published subscriptions|does not offer a cached'`

The settings-component task tests and combined gates are coordinated separately.
A focused pass is not independent review, a full native-process gate, an external
TLS/DNS deployment, or closure of every RW-22 prerequisite.
