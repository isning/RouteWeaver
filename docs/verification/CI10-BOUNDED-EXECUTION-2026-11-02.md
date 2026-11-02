# CI10 bounded execution plan

Base: `7a101032f55c1bde5ff308ffa1ddfcdd97b8d79e`. This local workflow patch changes exactly seven job timeout
integers. All 18 expanded jobs, selectors, steps, assertions, skip rejection,
dependencies, permissions and required aggregate criteria remain unchanged.
A timeout is a failed gate, not a pass and not an automatic retry instruction.

| Job | Prior minutes | New minutes | Longest observed CI5–9 minutes |
|---|---:|---:|---:|
| backend_core | 30 | 15 | 8.20 |
| backend_managed | 30 | 15 | 4.53 |
| browser_native | 20 | 10 | 3.92 |
| native | 20 | 15 | 8.32 |
| package | 15 | 8 | 3.83 |
| api | 10 | 8 | 3.28 |
| browser (each of four shards) | 15 | 12 | 6.48 |

The slower backup, HTTP API and store backend partitions retain 35 minutes each.
Static and secrets retain 5, web retains 20, and both aggregates retain 5 minutes.
The total falls from 330 to **264 runner-minutes**, including all four browser
shards. Earlier CI3's browser outlier of 8.82 minutes also fits the 12-minute cap.
Observed timing is evidence for headroom, not a guarantee: cold setup, network
delays, contention or new regressions may still fail a job.

## Single-run budget planning

- Prior nine-run computation estimate: USD 5.832 (CI9: 120 rounded minutes, USD 0.720).
- Additional cancellation/rounding reserve: 2 minutes × 18 jobs = 36 minutes.
- Next computation reserve: (264 + 36) × USD 0.006/minute = **USD 1.800**.
- Storage reserve: USD 0.20.
- Combined pre-tax estimate: 5.832 + 1.800 + 0.20 = **USD 7.832**.
- Illustrative 27% additional tax reserve: 7.832 × 1.27 = **USD 9.94664**.
- Remaining headroom against the authorized total USD 10: **USD 0.05336**.

This is a conservative planning calculation under the stated reserves, **not an
account-specific invoice, a verified applicable tax rate, or a hard platform
billing cap**. It does not assume free allowance or change billing settings.
It covers only one CI10 after the consolidated fixes pass local checks; it does
not authorize automatic retries or further runs. Reconcile actual terminal
durations and remaining authorization before any subsequent run. If storage,
pricing, tax or workflow scope invalidates these reserves, reassess before launch.

Price: https://docs.github.com/en/billing/reference/actions-runner-pricing
(Linux 2-core USD 0.006/minute, checked 2026-11-02).
Timing and prior cost evidence: CI5–9 terminal job metadata and CI9 cost receipt.

## Local patch validation

After replacing only timeout integer text with a common marker, the complete
workflow is byte-identical to its base. The changed job set is exactly the seven
rows above; the four browser matrix entries and all 18 expanded jobs remain.
Arithmetic and preserved backend/aggregate caps were independently asserted.
No tests, native processes, browser, remote publication or CI were run by this
patch task. Workflow syntax/integrated verification belongs to the coordinator.
