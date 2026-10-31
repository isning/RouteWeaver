# Same-process notifications

The control-plane daemon evaluates account quota/expiry and the persistent outbox
once a minute. It does not run a message broker or a separate service. Settings
are immediately effective after local validation; saving them does not test a
connection, deliver a message, or certify destination reachability.

## Public interfaces

- `Service.Evaluate` accepts server-derived account/cycle/usage snapshots and
  current recipients. Announcements use a stable ID per announcement/recipient;
  quota reminders use account, cycle and threshold; expiry reminders use account,
  exact expiry, threshold and an expiry-anchored repeat bucket. Account reminders
  stay in that account's inbox, not a global operator email destination.
- `Service.EvaluateProvider` requires an explicit fresh allowance observation.
  Provider events are administrator-only. The provider integration is not active
  until a real labeled allowance/observation source supplies this interface. A
  tenant's metered provider-overhead counter is not provider inventory or a bill.
- `Inbox`/`MarkRead` enforce ownership, current audience, account availability and
  current announcement validity. Edits preserve read receipts. A selected user
  removed from an audience cannot read the old item or mark its ID as read.
- `SaveSettings` validates the complete draft and its write-only secret updates
  atomically, with a revision precondition. Validation/revision failures leave
  the previous settings and secrets unchanged. Presence flags are not secrets.
- `Test` records an explicit single-channel test. `DispatchEvent` attempts it;
  ordinary configuration saving never does. `DeliverInApp` cannot send externally.
- `Dispatch` leases durable work and stores attempts before transport I/O. After
  a crash an expired one-minute lease may be retried with the same event ID.

## Channel permission and status

Email and Webhook default to disabled. Their `enabled` option allows an explicit
operator test. The separate `automatic` option authorizes future operator events
to the exact configured recipients/destination. A changed settings revision
cancels previously queued external deliveries instead of retargeting them. A send
already in progress may complete at its previously authorized destination.

`available` means the in-app item is visible. `accepted` means the SMTP server
accepted DATA or the HTTP server returned 2xx, not that an email reached an inbox
or a webhook was processed. `retrying` retains the event ID, with waits of 1, 2,
4, then 8 minutes, up to five attempts total. `failed` is terminal and visible;
an operator may request a new explicit test. `cancelled` denotes revoked
eligibility/settings, not successful delivery. Outbox APIs return summary fields,
never destinations, bodies, passwords, signing secrets or raw transport errors.

This is at-least-once delivery: a receiver may accept a message just before the
connection/process fails. Receiver-side deduplication by event ID is required.
SMTP uses a stable Message-ID. Webhooks include the stable
`X-RouteWeaver-Event-ID`, a Unix-seconds `X-RouteWeaver-Timestamp`, and
`X-RouteWeaver-Signature: sha256=<hex HMAC-SHA256>` over timestamp + `.` + the exact
UTF-8 JSON body. Receivers should verify the signature and acceptable timestamp
window, then durably deduplicate event IDs before applying an effect.

## Network and secret protection

Secrets are stored in encrypted private repository records and accepted
only as write-only settings input. They are absent from ordinary state, audit,
settings responses and outbox summaries. No external credentials are configured
by default, and tests use synthetic secrets only.

SMTP requires verified TLS or STARTTLS, TLS 1.2+, and original-hostname
verification after a public-address-pinned connection. STARTTLS has no plaintext
fallback. Cancellation closes the underlying socket. The standard-library SMTP
implementation performs command/response and DATA dot-stuffing.

Webhook requests require HTTPS, forbid userinfo/query/fragment credentials, do
not follow redirects or environment proxies, and reuse the resource fetcher's
address policy. DNS results are all checked and the checked literal address is
dialed, preventing a second DNS lookup from rebinding the connection. Private,
loopback, link-local, special-use and mixed public/private answers are rejected.
Responses, timeouts and public error messages are bounded.

## Verification scope

Public service/repository and authenticated HTTP tests cover eligibility,
privacy/read receipts, secret redaction, invalid-settings preservation, explicit
send separation, restart/deduplication, lease recovery, destination-change
cancellation and bounded retries. Local TLS fixture servers exercise signed
Webhook and SMTP acceptance/failure/hostname validation; no test contacts a real
recipient, provider or external destination. These fixtures establish adapter
contracts, not real-provider compatibility or real email deliverability.

The HTTP inbox returns the newest 200 visible items; the administrative outbox
returns the newest 500 summaries. Durable deduplication history is retained; no
retention/deletion policy silently discards delivery evidence.

## Durable storage

The SQLite adapter uses per-fact encrypted records with transactional outbox,
recipient and history indexes. Hot service operations use scoped reads rather
than the compatibility whole-state snapshot. Migration/backup and operational
bounds are documented in `docs/verification/2026-10-31-notification-durability.md`.
