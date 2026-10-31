# Notification slice local verification, 2026-10-19

Scope: A05 notification/announcement behavior and the notification-settings part
of M04. This is local implementation evidence, not a declaration that all of
RW-19/RW-22 or their prerequisites are verified.

## Implemented

- Authenticated administrator announcement save/list, selected/all/admin audience,
  explicit validity bounds; tenant inbox and isolated read receipts.
- Account quota and expiry evaluation from the same overview accounting/cycle
  computation used by the user interface; deterministic deduplication.
- Encrypted durable outbox, atomic attempt/lease transitions, one-minute crash
  lease, stable event identity, at-least-once retry semantics and five-attempt cap.
- Settings validation, expected-revision conflict, write-only SMTP/Webhook secrets,
  explicit test action separate from save/automatic-delivery permission, no
  implicit external sends from inbox GET or settings save.
- Verified TLS/STARTTLS SMTP and signed HTTPS Webhook adapters. Public-address
  pinned network policy is reused from resources; no environment proxy or
  redirects, no plaintext SMTP fallback, no fake delivered state.
- Same-process daemon startup with caller-owned context/cancellation and safe
  failure logging. Explicit provider-observation evaluation interface exists.

## Positive and negative public-seam evidence

`internal/httpapi/notifications_test.go` uses real authenticated HTTP routes for
announcement publication, eligible/private inboxes, read ownership, RBAC,
write-only secret responses, invalid edit preservation, ordinary state/audit
redaction and explicit in-app tests. External channels are never exercised against
real network recipients.

`internal/notifications/service_test.go` exercises the service and encrypted
SQLite repository for audience/expiry changes, read preservation, threshold/cycle
deduplication, process restart, crash-after-acceptance recovery, bounded terminal
failure, settings-change cancellation and provider observation freshness/permission.

`internal/notifications/transport_test.go` uses local synthetic TLS servers to
check signed Webhook payloads and stable IDs; SMTP TLS and STARTTLS acceptance;
original-hostname verification; no plaintext fallback; and header-injection
resistance. `internal/resources/outbound_test.go` covers unsafe destinations,
proxy avoidance and redirect/body-forwarding refusal. Existing resource-fetch
network-policy tests cover the shared DNS-pinning implementation.

`internal/store/notifications_test.go` verifies secret presence survives reopen,
ordinary state/settings do not expose it, and the persisted database does not
contain the synthetic secret in plaintext.

## Red-to-green observations

- The real HTTP publish test first returned 404 before handler registration;
  after backend registration it passed without adding a test-only endpoint.
- Extending an announcement beyond its original expiry initially left the inbox
  empty. The new public test failed; eligibility now checks the current
  announcement validity and retains the same read receipt.
- Restoring a previously cancelled announcement audience initially never made
  the item visible. The new public test failed; eligible in-app announcements can
  resume using their original identity without replaying external delivery.

## Gates run

- `scripts/verify.sh static`: passed, including architecture and ticket guards.
- `scripts/go.sh test ./internal/notifications ./internal/resources ./internal/httpapi ./internal/store -count=1`: passed.
- `scripts/go.sh test -race ./internal/notifications ./internal/resources ./internal/httpapi ./internal/store -count=1`: passed.

## Explicit limits

No external credentials were used, no real email/Webhook was sent, and no provider
compatibility/deliverability was certified. `accepted` is remote SMTP/HTTP
acceptance, not end-recipient processing. Receiver-side deduplication is required.
Provider alerts are not yet wired to a real designated observation/allowance
source; tenant traffic counters must not be misrepresented as provider bills.
Domain/TLS platform settings and broader audit/identity prerequisites belong to
other slices. Independent review was requested but not completed in this record.
