# E11: finite notification routing and delivery acceptance matrix

Base production source: `23650ca`. This change adds tests only; it does not
introduce new notification kinds, channel permissions, or destinations.

## Declared matrix

The encrypted SQLite-backed service is evaluated against four recipient identities:
an enabled owner, another enabled user, an enabled administrator and a disabled
administrator. For each row below, automatic external delivery is tested both off
and on while both external channels are configured/enabled. Evaluation runs twice
before dispatch to assert deduplication. The tests assert the exact outbox channel
set and exact visible inbox audience, including forbidden recipients/channels.

| Event | Audience with an inbox item | In-app | Email | Webhook |
| --- | --- | --- | --- | --- |
| Announcement, all | All three enabled recipients | One per recipient | Never | Never |
| Announcement, selected users | Selected owner only | One | Never | Never |
| Announcement, admins | Enabled administrator only | One | Never | Never |
| Account quota threshold | Owner only | One | Never | Never |
| Account expiry threshold | Owner only | One | Never | Never |
| Provider quota threshold | Enabled administrator only | One shared event | Only automatic enabled | Only automatic enabled |
| Provider expiry threshold | Enabled administrator only | One shared event | Only automatic enabled | Only automatic enabled |

Named test: `TestNotificationEventAudienceChannelAcceptanceMatrix` (14 subcases).
All expiring rows additionally become invisible at the exact expiry time.
Accepted external messages are not re-sent on a later dispatch.

Explicit channel tests form a separate three-channel matrix with automatic delivery
off: an enabled administrator may request exactly the selected channel, while an
ordinary user and disabled administrator are rejected. In-app never invokes the
external transport. For each external channel, a synthetic failure is visible as
`retrying`, is redacted, does not retry one nanosecond before its due time under the
existing deterministic clock seam, and subsequently becomes `accepted` with the
same event ID and incremented attempt count.

Named test: `TestNotificationExplicitChannelFailureRetryMatrix` (3 subcases).

Both external channels separately exhaust exactly five attempts and remain terminal
`failed` on a later dispatch, with redacted actionable failure text:
`TestNotificationExternalTerminalFailureMatrix` (2 subcases).

An undispatched provider-expiry event is checked at its exact expiry across all
three channels. All three become `cancelled`, retain zero attempts and visible
failure explanation, make zero transport calls and expose no inbox item:
`TestNotificationExpiredProviderDeliveryChannelMatrix`.

## Sink and transport evidence boundaries

The new routing matrix terminates external sends in an in-process recording sink.
It proves scheduling, persisted state and routing, not SMTP/HTTPS wire behavior.
The same complete package run executes the existing loopback TLS sink tests:

- `TestWebhookSignedHTTPSStableEventIDAndRejectedResponse`: signature, stable
  event ID, HTTPS acceptance/rejection and certificate validation.
- `TestSMTPVerifiedTLSAcceptanceStableMessageIDAndNoPlaintextFallback`: verified
  TLS, stable Message-ID, SMTP acceptance/rejection and no plaintext fallback.
- `TestSMTPSTARTTLSAuthenticatesOnlyAfterVerifiedUpgrade`: authentication only
  after verified TLS upgrade.

The package also retains existing restart/lease recovery, settings-revision
cancellation, audience edits/read ownership, slow-channel fairness and expiry
rechecked after a slow preceding send. These are independent named regressions,
not a claim that every matrix cell was exercised through every wire adapter.
The HTTP audience/read/settings-isolation case and operational notification retry
drill remain separate prior evidence; this change does not claim new browser QA.

## Reproduction and limitations

Run `scripts/go.sh test -race -count=1 -json ./internal/notifications` with the
repository-pinned Go toolchain. The committed JSON receipt records the actual run.
No real provider, inbox, webhook recipient, host trust store or live node is used.
`accepted` means transport acceptance, not human receipt or downstream processing;
delivery remains at least once. Actual deployment channel configuration and real
recipient compatibility require their own permission and verification.

Initial test-authoring failures were fixture issues: selected-user IDs were
incorrectly supplied to all/admin announcements, and a wall-clock-advancing public
dispatch cannot establish a one-nanosecond scheduling boundary. The fixtures were
corrected to valid audience inputs and the existing deterministic test clock.
No production code, timeout, assertion scope or channel policy was relaxed.
