# Subscription fetch history

`GET /api/me/subscription-fetches` is session-authenticated and always derives the
owner from the current account. Query strings cannot select another account.

The response contains `items` (newest first), `limit: 100`, `windowDays: 30`, and
an optional `collectionStartedAt` (the first successfully recorded delivery).
Each item contains only `outputId`, `at`, and `delivery` (`feed` or `bundle`).

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
removed. No token, full URL, source IP, User-Agent or client-provided text is
stored. Counts computed from this list are counts **within retained records**, not
24-hour or lifetime totals. An empty list means no retained records, not that the
subscription has never been fetched. Collection begins after this version is
installed, and historical requests are not reconstructed.

## Separate capabilities

Per-output traffic is not inferred from fetch history. Existing platform access
credentials can be reused by multiple outputs, and the traffic ledger has no
output identity. Accurate attribution requires distinct credentials/measurement
identity for each output, propagation through admission and counter bindings,
revocation/rotation semantics, and migration. It cannot recover historical
per-output traffic, and one copied credential still cannot identify a device.

IP geography and ASN/organization require a maintained external or local database.
No database is bundled here, no IP is sent to a third-party lookup service, and no
location or provider is guessed. Those enrichment capabilities are separate from
fetch history and should declare data provenance and freshness when implemented.
