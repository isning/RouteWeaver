# Admission history growth characterization

Public seam: `Store.AcquireAdmission`, finite allowance, same admitted presence
renewed six times after one warmup. The synthetic fixture seeds unrelated,
immutable ledger records through public `CompareAndPutRecords`. No live user data
or production systems are involved. Opt-in command:

    ROUTEWEAVER_MEASURE_ADMISSION_HISTORY=1 scripts/go.sh test ./internal/store -run '^TestAdmissionHistoryScalingCharacterization$' -count=1 -v

Observed local non-race medians (2026-10-19 UTC):

- No unrelated ledger rows: 0.499 ms.
- 1,000 unrelated ledger rows: 10.379 ms.
- 10,000 unrelated ledger rows: 124.647 ms.

The aggregate race suite was also running; these are characterization results,
not an idle-host benchmark, capacity promise or fleet SLA. The approximately
linear growth is consistent with the inspected full ledger decrypt/scan in
eligibility and finite budget reservation. The write transaction serializes
claims, so history can become a throughput bottleneck even when unrelated to the
requesting account. Budget and presence history have similar unbounded scans;
this measurement isolates the ledger case and does not quantify the others.

Keep canonical history, exact fractional weighting, cross-process atomicity,
late-meter semantics, crash holds and encrypted state. Do not fix this by deleting
history, dropping older charges, caching without transactional invalidation, or
releasing uncertain reservations. A separately reviewed projection/index design
is needed before a sustained-load scalability claim. Current loopback enforcement
proofs remain correctness evidence, not long-running load evidence.

Raw run: [characterization.log](admission-scaling-2026-10-19/characterization.log).

## Closed lifecycle history, measured separately

`TestAdmissionClosedHistoryScalingCharacterization` first produces a real
admission/finalization pair through the public API, then seeds copies of those
exact finalized records through the generic repository seam. It retains zero
new ledger charges and measures finite renewal and new-stream admission with
monotonically increasing request times. This isolates closed lease/budget scans,
not live-obligation cardinality.

Final local run: 0 / 1,000 / 10,000 retained closed pairs yielded renewal medians
0.529 / 11.613 / 131.976 ms, and new-stream medians 0.447 / 11.812 / 135.745 ms.
Six samples per condition are characterization only, not a capacity SLA.
Raw output: [closed-history.log](admission-scaling-2026-10-19/closed-history.log).

Therefore removing ledger reductions alone does not remove all lifetime-history
work from admission. The separately reviewed next design must retain canonical
closed history while excluding it from normal encrypted admission working state.
It must keep all relevant unresolved reservations; a 4,096 active-presence ceiling
does not bound unclosed budgets after release. No automatic refund or new hidden
admission cap is authorized by this measurement.
