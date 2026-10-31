# Encrypted admission working-state slice: verification

## Scope and immutable production checkpoint

Production checkpoint `d18a1ed` replaces only the lifetime lease scan in `AcquireAdmission` and the reservation scan in `grantAdmissionBudget`. Canonical history, status, policy guards, administrative queries, release semantics and public interfaces remain unchanged. Private modules are `admission_live_state.go` (encrypted complete account working sets, deltas and exceptional fallback) and `admission_live_schema.go` (independent domains, crypto and triggers).

Each domain has purpose-separated AEAD and keyed account lookup. All amounts, rates, IPs, identities and watermarks are encrypted. SQL still reveals keyed equality/existence, ciphertext sizes and write patterns. Missing/corrupt data reconstructs or fails safely. Domain exceptional markers are authenticated, durable and rebuildable; typed failures/unknown owners and arithmetic anomalies take the original canonical ordered evaluator only where the original scan occurred. Generic mutations do not acquire new typed-validation rejection semantics. Reopen atomically discards every account snapshot and rediscovers exceptions on the first reached canonical rebuild; it does not physically retain the old exceptional marker. Independent follow-up review accepted this restore-equivalent behavior because no optimized read can use an absent account snapshot. This clarifies the design wording about marker retention, not a weaker acceptance rule.

## Correctness evidence

- Infrastructure red/green: `TestAdmissionLiveStateIndependentDirtyDomains` failed before implementation with missing `admission_lease_state`, then passed after schema implementation.
- Independent public tests in `live_state_{public,restore,fault}_test.go` were run unchanged against an isolated canonical `2447c26` archive and the optimized slice. Eighteen top-level tests cover exceptional ordering/repair/reopen, own-denial precedence, arbitrary canonical vs embedded IDs, owner movement, backwards time, partial/final expired obligations, generic mutations, raw bypass, authentication/raw-JSON failure, denial commit/error rollback, and all four different-key logical restore modes.
- Supplemental tests in `admission_live_{schema,state,review}_test.go` cover domain independence, lost/corrupt row and marker recovery, version/trigger failures, raw kind moves, >4096 outstanding budgets without a hidden budget cap, fractional per-budget rounding, arithmetic/pending precedence, and settlement rollback.
- Independent review found no blocker in `d18a1ed`. Its 500-step private-helper differential is supplemental reducer/review evidence, **not** public integration coverage or a formal proof. The review's public negatives are retained as normal regression tests.
- Full Store race gate: `scripts/go.sh test -race -p 1 ./internal/store -count=1` passed, **129.724s**. Concurrent history fixture construction affected host load. Later-added review negatives and raw-kind tests passed focused `-race`, **3.520s**.
- Root subsequently isolated concurrent `Store.Open` startup failures on the usage-only baseline and supplied fix `a72bd51`, cherry-picked here as **`363343d`**. It reserves the SQLite writer before migration reads; it is not a live-state-specific semantic change. The combined live-state branch passed `scripts/go.sh test -race -p 1 ./internal/store -run '^TestAdmissionClaimsAcrossProcesses$' -count=5 -v`, **20.660s**: last-IP, last-stream and last-quota-byte claims, 30 real child processes. Raw output is `admission-live-state-2026-10-19/process-race.log`. Root already owns `a72bd51` and must not reapply `363343d`. Earlier full Store/backup package gates are scoped to their pre-startup-fix binaries.
- Architecture guard negative fixtures, production import guard, formatting and `scripts/go.sh vet ./...` passed.
- `scripts/verify.sh static` stopped at the ticket negative fixture `test_fake_completion_is_rejected`. The same failure was reproduced in an isolated `2447c26` archive. Root already has the unrelated fixture correction `8a9b2de`; this branch does not duplicate it. Therefore this is **not** a claimed full static/full CI pass.
- Whole encrypted-backup package race gate **passed**, exit 0: `scripts/go.sh test -race -p 1 ./internal/backup -count=1`, **599.014s**. Raw terminal output is `admission-live-state-2026-10-19/backup-race.log`. It ran serially with respect to other password-KDF suites; original history construction overlapped its first approximately two minutes. This compiled binary predates the separately tested root startup fix, as scoped above. Logical restore tests were not substituted for this package gate.

## Unmodified original closed-history characterization

Command: `ROUTEWEAVER_MEASURE_ADMISSION_HISTORY=1 scripts/go.sh test ./internal/store -run '^TestAdmissionClosedHistoryScalingCharacterization$' -count=1 -v`.

The parent-owned characterization file was not modified or recommitted here. It retains exact publicly generated finalized records, then adds copies through public tracked mutations. Results (six samples per mode, shared host):

| Retained closed lease/budget pairs | Renewal median | New stream median |
| --- | --- | --- |
| 0 | 1.487808 ms | 1.168387 ms |
| 1,000 | 2.323437 ms | 1.325154 ms |
| 10,000 | 2.177185 ms | 1.338304 ms |

Total test duration **365.838s**. The 10k subtest took **362.08s**, overwhelmingly fixture construction. Seed finalization is newer than the last projection watermark; cloned leases consequently remain relevant at that stored watermark until an admission advances it. Per-write re-encryption of the growing working set makes this particular setup expensive. No wall-clock pruning, timestamp modification, or dropped records were used to improve the original result.

The previously recorded canonical baseline at 10k was about **132ms renewal / 136ms new stream**. This supports removal of settled-history cost from **warm sequential admission**, not a capacity SLA or uniform speedup across all workloads. Constant-factor overhead on tiny histories is not claimed as an improvement.

## Separately labeled snapshot-seeded history

Command: `ROUTEWEAVER_MEASURE_ADMISSION_SNAPSHOT_HISTORY=1 scripts/go.sh test ./internal/store -run '^TestAdmissionSnapshotSeededHistoryCharacterization$' -count=1 -v`.

`admission_live_history_test.go` constructs equivalent canonical closed records and imports them into a fresh Store, so derived state starts absent. This is deliberately **not the identical end-to-end setup workload**. An initial test-fixture attempt to import over nonfresh source data was correctly rejected; it was corrected to use a fresh destination, without changing production acceptance rules. Final raw output: `admission-live-state-2026-10-19/snapshot-history.log`.

| Pairs | Snapshot setup | First cold admission | Warm renewal median | Settlement-bearing renewal median | New stream median |
| --- | --- | --- | --- | --- | --- |
| 0 | 3.114365 ms | 1.265654 ms | 1.670112 ms | 2.277486 ms | 1.323351 ms |
| 1,000 | 139.745738 ms | 13.971997 ms | 2.082618 ms | 2.654673 ms | 1.809662 ms |
| 10,000 | 1.334403788 s | 125.712917 ms | 2.681252 ms | 2.675224 ms | 1.814940 ms |

Cold reconstruction remains linear, as intended. Settlement-bearing requests increase admitted bytes by 1,000 on each renewal and update canonical ledger, usage and reservation state transactionally.

## Live obligations and concurrent arrival limitation

Command: `ROUTEWEAVER_MEASURE_ADMISSION_LIVE=1 scripts/go.sh test ./internal/store -run '^(TestAdmissionLiveObligationChurnCharacterization|TestAdmissionConcurrentArrivalCharacterization)$' -count=1 -v` passed, **2.023s**.

Actual release/new-presence churn retained live budgets. Observed admission at 0/64/256 prior obligations was **2.279581 / 2.473632 / 6.418273ms**. Release is not finalization/refund. Current obligations remain unbounded by the 4096 presence cap, and work still grows with them. These are individual samples, not medians or an SLA.

Two independent Store handles renewed separate presences with potentially reordered arrival timestamps over 1,000 closed pairs: **40 samples, median 1.664545ms, maximum 96.628527ms**. This includes SQLite writer waiting and may include backwards-time canonical reconstruction; it does not isolate either cost. Safe backwards-time fallback is retained, not optimized away, and sequential warm improvements are not a concurrency scalability claim.

## Limits

No canonical retention/deletion policy, live-obligation cap, membership index, plaintext index, scheduler, or dependency was added. Administrative/history scans remain canonical. Measurements are shared-host characterization; randomized differential tests are bounded evidence, not a complete formal proof. No external service, credentials, deployment or publication was used.
