# Current-cycle canonical trigger definition hardening

Separate follow-on to owner-history index production `c0581ab`; its 100k CLI
reference measurement remains bound to that source, not this later change.

## Reproduced failure

The old `usageGenerationTx` checked only three canonical trigger names. With a
same-name no-op trigger currently installed, authenticated canonical payloads
could be inserted/replayed without invalidating a warm current-cycle window.
Public `AcquireAdmission` regressions failed before the correction:

- INSERT: returned byte budget **93**, canonical remaining allowance **89**.
- UPDATE replay after an owner move: returned **100**, canonical remaining **93**.

These are genuine over-grants, not compile-only failing tests. Initial test
compilation also found a uint64/int64 assertion mismatch; it was corrected before
recording the behavioral failures. The corrected targeted test passes (0.053s).

## Correction and limits

The same existing metadata query now counts only exact `(name, sql)` pairs, using
shared canonical trigger installation constants as bound parameters. It adds no
query, table, endpoint, or framework. Missing/changed definitions produce an
ordinary error requiring reopen before any cached usage is trusted, generation
acknowledged, or normal canonical ledger mutation performed. They do not become
`ErrNotificationRebuildPending` or successful partial/zero usage.

The public test checks quota refusal, notification error classification, failed
normal mutation rollback, and exact quota recovery after reopening. Startup
still reinstalls trusted definitions and reconstructs canonical state.

The supported boundary is trusted private SQLite storage, not protection from a
hostile OS/database writer. Direct live SQL replay of cache ciphertext is outside
that boundary; an actor with that access can also roll back canonical/auth data.
No supported API, logical restore, or concurrent Store mutation path for replaying
a derived cache blob was found: public generic record writes address canonical
records, supported logical backups exclude derived tables, imports invalidate
canonical generations, and reopening reconstructs derived data. Public mutation,
rollback, counter/settlement, and cross-Store regressions remain authoritative.

Author's broader focused race suite (owner-history, current-cycle projection,
review regressions, and false-clean reopen) passed in **53.093s**. Independent
review and focused race evidence are maintained in the reviewer's appended section.

As before, temporarily disabling and restoring identical triggers before any
observation cannot be disproved without trusted external state. This small fix
also does not claim protection against replay of an older same-owner encrypted
`usage_windows` row; that distinct derived-cache concern was reported separately
rather than hidden inside the trigger-definition claim.

## Independent review

A separate reviewer applied `4008fdb` as `57b573e`; production
`usage_projection.go` was verified identical. No blocker found in the narrow
exact-definition gate. Independent focused race passed **7.718s**:

```sh
go test -race ./internal/store \
  -run 'TestUsageProjectionChangedCanonicalTriggers|TestReviewUsageHistoryModified|TestUsageProjectionPublic(ConcurrentMeterReplay|DeniedRenewalCommitsSettlement|AtomicBatchRollback)' \
  -count=1 -timeout=4m
```

This covered public quota/notification/refused-mutation/reopen behavior, all three
independent historical modified-trigger regressions, concurrent meter replay,
denied-renewal settlement, and atomic batch rollback. It is not a full-suite or
capacity measurement and does not resolve the separate cache-replay concern.
