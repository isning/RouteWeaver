# Subscription fetch history

`GET /api/me/subscription-fetches` is session-authenticated and always derives the
owner from the current account. Query strings cannot select another account.

The response contains `items` (newest first), `limit: 100`, `windowDays: 30`, and
an optional `collectionStartedAt` (the first successfully recorded delivery).
By default each item contains only `outputId`, `at`, and `delivery` (`feed` or `bundle`).
The response also includes the owner's `trackSourceIps` preference (default false).

A record means that the server successfully wrote the complete HTTP response.
It does not prove that a client received, imported or used the configuration.
Authenticated bundle downloads are included. Failed authorization, invalid links,
and failed response writes are not included. Persistence failure is reported in a
generic server log and never changes an already delivered configuration; history
is diagnostic evidence, not a billing/audit source with completeness guarantees.

The encrypted database stores one bounded record per account. Read and write
operations remove entries older than the 30-day display window and retain the
latest 100. This is not a strict physical deletion deadline: inactive accounts'
rows and independent backups can retain expired ciphertext until accessed or
removed. No token, full URL, User-Agent or client-provided text is stored. Source IP
is stored only after the owner opts in as described below. Counts computed from this list are counts **within retained records**, not
24-hour or lifetime totals. An empty list means no retained records, not that the
subscription has never been fetched. Collection begins after this version is
installed, and historical requests are not reconstructed.

## Separate capabilities

Per-output traffic is not inferred from fetch history. Existing platform access
credentials can be reused by multiple outputs, and their traffic is not
attributable to an individual output. New managed independent subscriptions now
support attribution through distinct credentials, admission and counter bindings;
see `INDEPENDENT-SUBSCRIPTION-METERING.md` for supported scope and migration. It cannot recover historical
per-output traffic, and one copied credential still cannot identify a device.

IP geography and ASN/organization require a maintained external or local database.
No database is bundled here, no IP is sent to a third-party lookup service, and no
location or provider is guessed. Those enrichment capabilities are separate from
fetch history and should declare data provenance and freshness when implemented.

## Opt-in new source address reminders

The account owner can enable **新 IP 拉取提醒** in the overview's subscription
section. The setting is off by default. `PUT /api/me/subscription-fetches/tracking`
accepts `{ "enabled": true | false }`, requires the current account's authenticated
session and CSRF protection, and cannot select a different owner. No email,
webhook, push service, or external geolocation request is sent.

Only while enabled, completed response-write records additionally store the
canonical `sourceIp` and a server-computed `newSource` marker. The preference and
append are checked in the same database transaction. A disable racing with a
fetch cannot repopulate cleared addresses after disable commits. Disabling clears
all addresses and reminder markers in the live account record, but preserves
IP-free fetch history. It does not erase independent backups or historical
SQLite storage pages. Re-enabling starts a new baseline; no old IPs are recovered.

The first retained address for each output establishes its baseline without a
reminder. Later addresses are compared only with that output's IP-bearing records
in the last 30 days / last 100 account-wide fetches (not an unlimited known-IP
set). Expired or evicted history is forgotten, so a previously seen IP can later
appear new, or no reminder may be raised when no baseline remains. The UI shows
at most the 10 most recent retained reminders. Turning on twice is idempotent and
does not reset an existing baseline. Inactive records and backups retain the
same non-strict physical deletion limitations documented above.

The source is the TCP peer unless its address is in the explicitly configured
trusted-proxy CIDRs. Only then is the existing bounded X-Forwarded-For chain
parsed from right to left, stopping at the first untrusted hop; untrusted headers
are ignored. Invalid chains fall back to the peer. Operators must configure
proxies to append their observed peer or overwrite incoming forwarding headers;
a trusted proxy that relays attacker-supplied addresses can falsify the result.
Forwarded headers, user agents, and URL query parameters are not stored.
Addresses are not device identities: NAT, VPNs, mobile networks, and proxies can
change or share them. A reminder is not proof of compromise, client receipt,
import, or actual proxy traffic. Logging failures can omit reminders and do not
prevent delivery. This is a bounded diagnostic feature, not security enforcement.
