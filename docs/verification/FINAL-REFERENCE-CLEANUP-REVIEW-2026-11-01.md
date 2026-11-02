# Failed-reference cleanup review — 2026-11-01

Read-only production review against `23650ca`, with two fake-filesystem regressions. No native activation, deadline change, host action, or production change was performed. The prior failed/successful reference receipts remain separate and unchanged.

## Findings

- `MeterSpool.Close` and `Reconciler.Close` mark their objects closed and release lock-file handles. They do not flush a delayed meter buffer or publish the native final journal. Ignoring these return values is an evidence limitation for handle cleanup, not an established explanation of the preceding read timeout or zero-byte final.
- Native shutdown calls runtime close before taking the final snapshot. Journal JSON marshaling precedes exclusive final-file creation. The zero-byte final therefore locates incomplete publication after creation; it does **not** distinguish forced termination, a write error, or a stalled/scheduled-out process. It does not prove that the snapshot/settlement wait was still blocked.
- The owned supervisor allows graceful stop only for its configured interval, then may kill the identity-verified child. A kill during final publication is a permitted uncertain-stop outcome, not proof of clean accounting. The journal deliberately retains its running marker on incomplete publication; collection rejects malformed/empty finals and does not invent counters or refund reservation obligations.
- Driver stop, final collection and pending delivery share a four-second context. Collection errors take precedence over stop errors. Thus a reported deadline alone does not identify the first slow phase. The failed run also retained an unknown/recovery-required state, rather than certifying success. Error aggregation or stage telemetry could improve diagnosis, but the available evidence does not justify presenting either as a correctness fix or changing the production freeze.
- Per-flow renewal, independent expiry and conservative settlement paths were inspected. The fixture allowance is 1 MiB, not the roughly 24 KiB observed before failure; no deterministic budget, renewal or shutdown defect was established. The second pass is not evidence of the first failure's cause.

## Executable fake-only evidence

Added `TestManagedEmptyFinalPreservesEvidenceAndPendingAcrossReopen`: a real baseline and unacknowledged synthetic spool batch plus an empty final/running marker are rejected; retained evidence and exact pending digest/sequence survive reopening. Added `TestJournalEmptyFinalCannotBeOverwrittenOrClearRunningMarker`: an empty final is not overwritten and cannot clear the uncertainty marker or admit a new epoch. Both tests pass without any production fix.

Commands:

```
scripts/go.sh test ./internal/agent -run 'TestManagedEmptyFinalPreservesEvidenceAndPendingAcrossReopen|TestManagedRetirementRejectsIncompleteOrChangedFinal|TestManagedRetirementCancellationPreservesRecoveryIntent' -count=1
scripts/go.sh -C runtimes/xray test . -run '^TestJournal' -count=1
```

Results: agent `0.024s`; journal-only `0.021s`. No runtime constructor, executable launch or network listener is used by the added tests.

## Residual acceptance requirement

Do not classify the first timeout as benign, fixed or a reliable-capacity result. Closing its cause requires a causally captured recurrence or deterministic reproducer showing the failing I/O stage/read count, contemporaneous CP admission/budget/expiry decisions and driver error classes, pre-cancellation blocked stacks, and stop/final-write timing or exit evidence. Existing opt-in diagnostics cover much of this but not native syscall completion. Retain the failed root and do not activate a new epoch from its incomplete final. Recovery acceptance must separately prove identity-verified owned absence and explicit reconciliation of retained accounting obligations before reopening access; a later traffic pass or process absence alone is insufficient. No additional native run was performed for this review.
