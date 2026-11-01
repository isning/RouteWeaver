# Updated-dependency Linux reference — preregistered 2026-11-01

The earlier `0f3cc5e` binary's 30-minute result is historical, not evidence for
this new binary. This run starts at production source `a7963c6`, including the
managed dependency/security update (x/net 0.62, gRPC 1.83.2, compress 1.18.7).
Xray base version and managed ABI are unchanged; executable/module/source hashes
will accompany the new result. No target deployment or production capacity claim.

## Fixed observation profile before execution

Use the same ephemeral Debian/Linux reference, synthetic single managed flow and
owned loopback CP/core as the previous observation. **Parent test/CP process only:**
`GOMAXPROCS=1` is scheduler parallelism and `GOMEMLIMIT=256MiB` a soft Go target.
The native supervisor strips ambient Go settings; its trusted managed adapter adds
only Xray resource roots. The native child does **not** inherit either setting;
its Go defaults are unmeasured and hard CPU/RSS limits are unknown for both.
This clarification also applies to the historical managed reference, not to the
ordinary CLI script which directly supplies its own environment.
Run a 120-second smoke first, then only if green a 1,800-second observation.
Default CI timing remains unchanged. Assertions remain exact payload once per
second with a two-second I/O deadline, live unchanged native identity, active
renewed service, sampled parent heap <=128MiB and agent-root growth <=16MiB;
finally require denied new revoked flow, existing flow closed within its own
admission lease, runtime still live, bounded driver cancellation and cleanup.

Additional **metrics only**, sampled every 30 seconds: separately report this
fixture's CP database/WAL/SHM file sizes and owned native RSS/FD count. Database
history may legitimately grow under accounting/renewal; no capacity/leak threshold
is invented for these new metrics. No `ss`, netlink, process-list search or host
mutation is used. The native PID comes solely from the test-owned process receipt;
executable and start ticks are checked before and after `/proc` RSS/FD reads.
Unreadable or changed ownership returns unknown (`-1`), never zero/healthy.
CP sidecar absence is zero bytes, other stat failures are `-1`.

## Completed result (updated binary only)

The 120-second smoke passed in 141.68 seconds including original-lease expiry,
revocation and cleanup. Its maximum payload RTT was 175.60 ms. The separately
started 30-minute observation ran 16:17:00–16:47:24 UTC and passed **1,800 exact
payload exchanges over 1,800.0003 seconds**, nine sampled policy issuance timestamps,
unchanged native identity, revoked-new-flow denial, bounded existing-flow closure,
live runtime after revocation, and driver cancellation/cleanup. Total test time was
1,823.67 seconds (wrapper 1,823.73 seconds). Maximum payload RTT was **492.19 ms**.
This shared executor is not an isolated latency benchmark.

The 60 resource samples (seconds 0..1770, every 30 seconds) recorded:

| Measurement | Initial | Last sample | Maximum |
| --- | ---: | ---: | ---: |
| Native RSS (KiB) | 33,740 | 35,296 | 35,808 |
| Native open file descriptors | 12 | 12 | 12 |
| CP database bytes | 4,096 | 2,748,416 | 2,748,416 |
| CP WAL bytes | 1,924,072 | 4,152,992 | 4,152,992 |
| CP SHM bytes | 32,768 | 32,768 | 32,768 |

All native metric samples were readable and ownership-verified. These are sampled
values, not continuously observed maxima. Physical CP files grew under active
accounting/renewal/history and SQLite checkpoint work; this records that growth,
not a leak verdict or evidence of unlimited sustainable retention. Parent Go heap
maximum was 3,754,976 bytes; agent-root growth maximum was 13 bytes. The declared
parent-heap/agent-root guardrails did not fire.

Precompiled test-process wait4 accounting: 179.84 user CPU seconds, 49.45 system
CPU seconds, maximum RSS 123,348 KiB. This accounting includes the harness/native
child; maximum RSS is **not** summed concurrent RSS. Parent-only Go settings and
native defaults remain separate as documented above. No hard host limits asserted.

- [120-second test log](evidence/UPDATED-MANAGED-120S-2026-11-01.log)
- [30-minute test and process/storage log](evidence/UPDATED-MANAGED-1800S-2026-11-01.log)
- [Result, exact executable/module/test hashes and aggregates](evidence/UPDATED-MANAGED-1800S-2026-11-01.json)
- [224-file production-source hash manifest](evidence/UPDATED-MANAGED-SOURCE-MANIFEST-2026-11-01.json)

Module, production-source, test-source and executable hashes were rechecked after
completion. This result belongs to updated source `a7963c6` plus test-only
instrumentation `30355e4`, not the previous dependency binary. Independent review
of instrumentation passed; focused bounds/unknown-receipt tests passed. The tree
secret scan on this base still flags the previously identified exact Go checksum
at `runtimes/xray/go.sum:259`; final narrow classification remains coordinator-owned.
No scanner success is inferred from native test success.

The actual deployment still needs its own host/security/resource limits,
representative users/traffic, capacity/SLA/retention objectives, real-network
failure/recovery and backup-under-load. No live deployment or external CI spend
was performed by this reference task.
