# Current-account insights

`GET /api/me/insights` is a session-authenticated, no-store observation endpoint.
It accepts no query parameters or alternate user ID. Every returned ledger and
lease belongs to that authenticated account; private entry/instance IDs and
other accounts' data are not returned. It does not expose subscription secrets
or invent per-subscription attribution.

- `daily`: 14 UTC+8 calendar days including today, chronological `date`,
  `rawBytes`, `weightedBytes`. Confirmed ledger facts belong to their `observedAt`
  day; intervals are not interpolated. A zero bucket means no confirmed ledger
  facts in that day, not proof of no unreported traffic.
- `routes`: confirmed usage by stable `routeId` from the current effective cycle
  start (including latest manual reset) through `asOf`. Historical route IDs
  may no longer be authorized; the UI must not resolve them through another
  account's catalog. Unknown names should remain historical routes, not vanish.
- Each bucket sums raw bytes and exact rate numerators before rounding upward.
  Bucket sums can differ from the overview's whole-period total by rounding
  bytes; these are not separately billable records.
- `limits`: current effective online-IP, connection and entry-rate policy,
  using the same evaluator as admission. Zero retains its existing no-limit
  meaning. Policy, reset, usage and lease observations share one read snapshot.
- `admission.available`: only `true` permits showing `onlineIps` and
  `activeStreams`. These are unexpired managed reservations, not devices or a
  live socket probe. False means unavailable, not zero. `maxLeaseSeconds` and
  `asOf` identify the lease observation boundary.

The read uses a three-second request context, no Store writer lock, and explicit
record/byte bounds. The authenticated history index now includes a rebuildable
UTC-second lookup key: account + observation time + record ID. Existing
canonical/derived generation fences cover time-key updates; each selected record
is decrypted and its owner and timestamp rechecked. The index is discarded and
rebuilt at startup. Logical backups continue to exclude derived state; opening
older two-column physical history tables is accepted and rebuilt. This does not
authorize in-place downgrade to an older binary after the derived schema change.
The derived time key is metadata, not an unencrypted copy of canonical payloads.

History scanning covers current cycle union 14 days, at most 10,000 selected
records and 8 MiB (64 KiB per record). Large current cycles, including lifetime
cycles, can exceed this bound and return 503; no truncated graph is returned.
Policy/reset catalogs have a shared 10,000-row/8 MiB preflight in the same
snapshot. Lease observations prefer a complete authenticated per-user hot
projection, otherwise boundedly scan canonical leases. Cold lease history over
10,000 rows or unavailable proof sets only `admission.available=false`, leaving
complete usage charts usable. No background rebuild or mutation is triggered by
this read. These limits are intentionally explicit, not a capacity guarantee.

Focused verification covers day/time boundaries and exact rate rounding,
foreign-account exclusion, session authentication, query-ID rejection,
cancellation, time-index tampering, older-schema reopening, >10,000 old records
outside the selected window, selected-window overflow, and hot/cold lease
availability. Existing usage-history backup and mutation tests are reused.
Results must be recorded for the final commit; test presence is not a CI pass.

Local result: focused store insights + existing UsageHistory tests passed under
`-race`; focused authenticated HTTP insights test passed under `-race` after
correcting its explicit entitlement setup. Architecture import checks and
`git diff --check` passed. Independent read-only review found no remaining
blocking issue. These are not full-suite or production results.
