# Backup import transaction-bound INSERT reuse

Five INSERT statements are prepared once per import transaction and reused with fresh frame bindings. Per-frame validation, cancellation, sealing, rollback and final database validation remain in place. Statement close errors are surfaced before validation/commit.

## Evidence

Matched isolated baseline/candidate compact checks passed: repeated bindings across all five tables, injected SQLite ABORT with whole-target rollback, inaccessible partial authentication, same-store retry after trigger removal, complete logical-content equality, both identities usable, cancellation/generation consistency, target protections and malformed/unauthenticated frame cleanup.

One 2000-row diagnostic measured baseline import 9.219s versus candidate 2.766s, concentrated in emit callbacks. Setup also varied substantially; this is not a stable causal speedup estimate or the large-fixture acceptance.

The first whole-package attempt was interrupted by environment/session loss, not a native timeout and not a pass. Its raw artifacts were preserved.

The unchanged candidate subsequently passed the entire internal/backup package once with `-race -p=1 -count=1 -timeout=20m -v`, default 40000 rows, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. Native package duration 985.518s; ledger complete recovery 725.97s; ciphertext 17,314,943 bytes (>16MiB); sampled peak Go heap 734,464,696 bytes (not total RSS or a bound). Source manifest unchanged.

This whole-package result belongs to its frozen isolated source. It is not a full aggregate gate, HTTP EOF fix, or matched whole-package baseline comparison. Current-source compatibility passed all 16 selected top-level tests under the same race/resource settings: 13 restore publication/HTTP outcome cases plus binding rollback/retry, cancellation/generation, and occupied/invalid target protection. The current canonical Go-source snapshot plus exact SQL/test overlay was reverified under the QA lock before execution; both canonical and isolated source manifests remained unchanged. The initial copy was made outside the lock; current canonical plus the exact overlay was reverified under lock before execution. This focused run took 201.234s, completing 2026-10-24T01:34:32Z. No automatic whole-40000 rerun or canonical integration was performed.

Whole-pass frozen versus current-source differences were limited to HTTP backup.go and its added result-window tests; store backup_stream_restore.go and its added publication-outcome tests; the proposed SQL/test overlay; and omission of the diagnostic-only import measurement test. Unrelated web/UI changes are outside this Go-source comparison.
