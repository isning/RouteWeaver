# Notification durability and required secret-reveal audit

Baseline: remote `25ee5888b20e7bc2775edae0a791480b2fc2861c`, restored tree
`774d13f87b43ef68e9ed0fafd296bc352f11c559`. Local synthetic SQLite/HTTP only.

## Storage and compatibility

Notifications now use separate encrypted records for settings/secrets,
announcements, events, deliveries and read receipts. Encrypted pending copies,
recipient/time indexes and delivery-history indexes share the existing `records`
table. There is no new physical table, backup schema version, increased backup
limit, retention deletion, or change to event identities. Only changed facts and
corresponding indexes are written under SQLite's writer reservation.

`Open` migrates the legacy `notification-private/state` representation in one
transaction. The last step removes that superseded representation; all events,
original payloads, receipts, attempts, lease tokens, settings revisions and
secrets have already been stored individually in the same transaction. An error
rolls back the entire notification migration. Unknown legacy JSON fields fail
rather than being silently discarded. Notification reads also perform this check
so importing a legacy logical backup into an already-open Store is supported.
Mixed legacy/new representations are refused, including during backup validation.

This is a one-way logical-format migration. Do not run an old notification writer
against a migrated database or downgrade a binary in place; restore a verified
pre-upgrade backup to a separate target for rollback. The original buggy binary
cannot be made to enforce a newer format fence retroactively.

Logical export/import includes canonical facts and indexes and validates their
relationships in both directions. Missing pending, inbox or history indexes and
mixed representations reject restore without replacing healthy target data.
Default per-record backup limits remain 32 MiB. Total history is still retained;
existing total-byte/row backup limits can still require operator capacity
planning. This change does not claim unbounded storage or backup capacity.

## Hot-path bounds

- Settings load no event history. Receipts and delivery completion load exact
  event IDs; candidate evaluation loads exact dedupe IDs in the same writer
  transaction as enqueue.
- Claims stream active pending rows and materialize at most 128 due candidates.
  Only their referenced announcements are loaded. Future/leased entries are
  skipped; a page of cancelled work does not hide the next eligible page.
- Inbox uses recipient indexes and 128-row keyset pages until 200 currently
  visible items are found. Administrator and personal pages are merged before
  the existing global 200-item limit. Expired/removed-audience items and their
  definitions do not accumulate in the returned snapshot.
- Outbox reads the newest 500 indexed deliveries. Terminal history and read
  receipts are retained, not rewritten or erased by dispatch.
- Global input evaluation reads policy in one snapshot and streams resets and
  the usage ledger once, rather than invoking a full overview/ledger reduction
  once per user. Fractional usage is summed exactly before one ceiling division;
  cycle/reset boundaries and disabled-account behavior are preserved.

These are bounded snapshot allocations, not constant-time guarantees. A claim
can scan active delayed work; an inbox can scan many ineligible entries; global
evaluation still scans ledger/resets and evaluates policy per user. Announcement
management/evaluation and the explicit compatibility `ReadNotifications` API can
read complete relevant sets. The production service uses the scoped repository.
Dispatch remains bounded to 100 rounds per call and at-least-once external
transport; receivers still need event-ID idempotency.

## Required audit contract

Explicit inventory, platform-entry, tenant source/profile and source-candidate
reveals write a minimal actor/action/object audit event before returning secrets.
Audit failure returns `503 required audit unavailable`, with no secret or raw
storage error and `Cache-Control: no-store`. Unrelated best-effort logging was
not converted into a business-operation failure.

## Verification

Public seams: notification service/repository, authenticated HTTP reveals,
logical backup/restore and independent SQLite Store handles. Fault injection uses
only temporary synthetic SQLite databases.

- Baseline red: 10 accepted 8,000-byte announcements × 500 recipients produced
  a 43,701,172-byte legacy record and failed the existing 32 MiB backup limit.
- Green: the same legitimate workload exports, migrates from a legacy row,
  restores under a different key and retains 5,000 events/deliveries and dedupe.
  The fixed-time fixture exports 25,012 canonical/index records; its largest
  plaintext record is 8,269 bytes (legacy snapshot: 43,701,172 bytes).
- Baseline red: injected audit failure still returned secrets with HTTP 200 on
  four reveal routes. Green: all return 503 without secret/error leakage;
  removing the fault restores reveal and records a secret-free audit event.
- Migration fault rolls back all new notification rows and preserves the legacy
  facts. Backup round trip preserves settings/secrets, leases and read receipts.
- Scope tests cover 1,200 retained terminal events/definitions, 1,200 expired
  announcement events followed by an older valid item, bounded inbox/outbox,
  receipt preservation and the 128-cancelled/129th-eligible dispatch boundary.
- Policy parity covers grouped service quota, individual quota override, manual
  and future reset boundaries, future meter observations, exact rounding and
  disabled accounts.
- Existing notification service/HTTP tests, focused race tests, backup regression
  tests and `go vet` were run with the official Go 1.27.3 toolchain.

An independent worker reviewed the implementation and identified three bounded-
page/announcement/mixed-format issues; each was corrected and covered by tests.
No production database, external recipient, deployment, long-running production
load, full application gate or UI/browser verification is claimed here.
