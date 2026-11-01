# Lossless historical usage reads

Based on integration `eafb493`. No raw history, receipt, accounting hold or ledger
row is deleted, summarized, rewritten or excluded from backup. Historical exact
meter retries keep their existing successful no-op behavior.

Historical `Usage` previously retained all canonical ledger plaintext in a slice
before reducing it. `UsageContext` now decrypts/reduces one row at a time on a
single independent read-only SQLite snapshot. Application working memory is
bounded by the largest record and aggregate integers, not ledger row count.
Exact weighted numerator, round-once behavior, tenant filtering and half-open
windows are preserved. Errors/cancellation never return usable partial totals.
The existing backup snapshot connection setup is shared, retaining its writer-
independence and snapshot consistency. Long snapshots can still retain WAL pages;
streaming is not constant disk use or a historical-query latency guarantee.

Request contexts now reach this scan from tenant overview, administrator state,
entitlement read and subscription preview handlers. Internal legacy helpers retain
`overview`/`Usage` background wrappers; their context plumbing is not claimed.
Current-cycle admission/notification projection and its recovery rules are unchanged.

A tested candidate that preserved warm windows across reopen by checking exact
trigger definitions and clean generation was REJECTED: an offline writer could
replace a trigger, write canonical facts and restore the exact trigger without
changing generation. A false-clean projection could then undercount usage.
Startup therefore STILL discards derived windows. A regression covers restored
original trigger text after an offline bypass. Missing/corrupt/unknown projections
remain unknown until full canonical reconstruction; no optimistic zero is used.

Backup already streams. Its 2,000,000-row / 1GiB whole-archive limits remain
unchanged and can still become operational cliffs. Pagination alone does not
change that contract. Notification's 1M-row / 512MiB canonical cold-rebuild budget
also remains, including after restart, restore, new cycle or derived-state loss.
A proper resumable rebuild needs authenticated partial frontier state, mutation
handling on both sides of that frontier, restart/rollback/downgrade rules and no
exposure of incomplete totals; that is not silently introduced here.
