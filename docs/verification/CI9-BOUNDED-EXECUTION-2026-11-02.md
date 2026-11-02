# Bounded final acceptance execution

Only seven non-backend job timeout values change. All 18 expanded jobs, test
selectors, assertions, skip rejection, dependencies and required aggregates stay
unchanged. The five backend partitions and both aggregate timeouts are untouched.
A timeout is a failed gate, never a pass or an instruction to retry automatically.

| Job | Previous minutes | New minutes | Longest observed CI2–8 where relevant |
|---|---:|---:|---:|
| static | 10 | 5 | 0.63 |
| secrets | 10 | 5 | 0.95 |
| web | 30 | 20 | 10.85 |
| API | 20 | 10 | 3.42 |
| each of four browser shards | 30 | 15 | 8.82 |
| native | 30 | 20 | 8.17 |
| package | 30 | 15 | 3.83 |

The separate browser/native gate remains 20 minutes. Declared aggregate maximum
falls from 445 to 330 runner-minutes. The added native rate scenario measured
approximately 9.8 seconds locally; this is not a guarantee of CI execution time.
Cold setup, downloads and runner contention can still cause a timeout.

For this one acceptance run, a further two minutes per expanded job reserves
36 runner-minutes for cancellation/rounding uncertainty. At the official Linux
2-core rate of USD 0.006/minute checked on 2026-11-02, the planning computation is:

- Next computation reserve: (330 + 36) × 0.006 = USD 2.196.
- Earlier computation estimate: USD 5.112.
- Storage reserve: USD 0.20.
- Combined pre-tax planning amount: USD 7.508.
- Illustrative 27% additional tax reserve: total USD 9.53516.

These are planning estimates, not an account-specific invoice or a platform
spending limit. Free allowance and actual tax jurisdiction are not assumed.
This does not change billing settings or authorize an automatic retry; subsequent
work must use the actual terminal runner durations and remaining authorization.

Price source: https://docs.github.com/en/billing/reference/actions-runner-pricing
Timing evidence: CI2–8 terminal job metadata retained in the acceptance receipts.
