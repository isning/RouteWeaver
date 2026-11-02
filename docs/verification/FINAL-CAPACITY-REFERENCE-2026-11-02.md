# Final capacity-guard reference acceptance

**PASS: 14/14 operational/recovery selectors, then one full 1,800-second reference
window and revocation/cleanup, on the same frozen final production source.**
No failures, skips or retries. This is bounded, synthetic single-flow Linux
reference evidence, not a production capacity/uptime SLA or real-host certification.

## Source, binaries and profile

- Frozen source: `6742d04b7e1c036de8fcc3551d0c49390f562b75`.
- Tree: `2d70ec80c996c9a34587fa124cdb28326e180b82`.
- Fresh managed native SHA-256:
  `1474c8cd30f3277ec3cd396e390cc7ae3441d13ad4852d38df3616fb19bc2fb1`.
- Fresh normal/non-race HTTP test SHA-256:
  `80d685d110b3082ca3fe75c19735a459f4fbe1e9718ab82f9d6ee7cf4e8c8399`.
- **250 production/module/lock files and 309 test files** bound before/after;
  native and normal-test binary hashes unchanged. Full manifests/build metadata
  accompany the raw receipts. Native was rebuilt after the final documentation/
  security-only source advance; the normal test digest remained identical.
- Go 1.27.3, `GOPROXY=off`, shared existing local caches; Linux 6.18.57 x86_64.
  Parent `GOMAXPROCS=1`, `GOMEMLIMIT=256MiB` only: these are not a CPU quota or
  RSS cap. Supervisor sanitization removes these Go variables from the native
  child; native defaults/hard host caps are not asserted.

The final capacity preflight is included here, unlike the earlier 81b5 qualification.
No stock sing-box, browser, real node, public destination, host-setting change,
remote CI or deployment was used. The coordinator completed heavy local preflight
before authorizing each run; no local heavy work was scheduled during the window.

## Operational drill refresh

Native group **05:15:58.237005–05:18:01.591054 UTC**, 123.354s, existing 180s
outer test timeout. Fake recovery group **05:18:01.594387–05:18:44.225197 UTC**,
42.631s, existing 120s timeout. Both used `-race -p=1 -count=1`.
All 14 required top-level cases passed, **20 pass events including subtests**.
The actual managed operational case took 90.93s.

- Brief disconnect 253.065ms; reconnect refresh 34.699ms; prior observation retained.
- Controlled native/CP raw+weighted checkpoint **7,678 bytes**, settled in 5.784s.
- Encrypted backup **73,738 bytes**, export 10.763s; **142 payload exchanges inside
  export window**; fresh verification/restore/reopen 10.258s. Copy not activated.
- Genuine CP outage restricted the existing flow in **29.906s**, within the
  unchanged 33s guard; native remained alive until legal driver cancellation.
- Cancel/drain, owned absence and genuine final preceded explicit synthetic-budget
  resolution (89.372ms); replay rejected. Same durable state was closed/reopened;
  fresh generation/epoch, actual CP custody matching the complete prior final,
  and readmission completed in **6.415s**, within the unchanged 20s bound.
- Terminal: owned absence true, valid retained current final pair, no running
  marker, pending batches 0; two budgets closed, unresolved 0, retained reservation
  0, settled/CP raw+weighted **7,886 bytes**. Checked closes succeeded.
- Broker EOF preserved exact **44 bytes**, replay/reopen 10.620ms; its typed custody
  receipt is explicitly **synthetic**, not evidence of CP delivery. Owned absence
  and checked reconciler close succeeded.

The eleven fake cases separately cover encrypted-restore obligations, concurrent
backup writes, counter replay/regression, notification retry/restart, lease
restriction, generation fencing, retirement crash replay and real-baseline
requirements. Exact selectors, per-case durations and commands are in the JSON.

## Full final-source observation

Only `TestNativeContinuousManagedServicePreservesPayloadAndRevocation` ran, normal
(non-race), with observation seconds exactly 1800 and operational/provider flags
unset. Existing two-second socket deadlines, identity/renewal/revocation checks,
128 MiB parent-heap/16 MiB root-growth guards remained unchanged. The outer 35m
test timeout did not extend policy/admission leases.

- Start **2026-11-02 05:24:10.216529 UTC**; terminal exit 0 **05:54:34.198538 UTC**.
- **1,800 samples over 1,800.000227342s**, identity unchanged; maximum measured
  sample RTT **750.323488ms**. Named test 1,823.30s; wrapper 1,823.983s.
- Revoked principal could not obtain a new flow; existing flow closed within its
  unchanged lease bound while native stayed live, followed by driver cleanup.
- Terminal owned absence and valid **current-epoch local baseline/final proof**;
  no running marker. CP custody was **not queried** because local proof existed.
  Pending batches 0, open budgets 0, unresolved budgets 0, held bytes 0 are actual
  observations, not inferred refunds. Spool/reconciler Close returns checked.

Sixty resource samples, every 30 payload samples; last at sample 1,770:

| Metric | Initial | Last sampled | Maximum |
|---|---:|---:|---:|
| Parent Go heap, bytes | 4,114,280 | 3,895,592 | 5,386,184 |
| Agent root, bytes | 48,660,692 | 48,660,705 | 48,660,705 |
| Owned native RSS, KiB | 33,456 | 35,820 | 35,980 |
| Owned native FDs | 12 | 12 | 12 |
| CP database, bytes | 4,096 | 2,785,280 | 2,785,280 |
| CP WAL, bytes | 1,940,552 | 4,161,232 | 4,161,232 |
| CP SHM, bytes | 32,768 | 32,768 | 32,768 |

Agent-root growth **13 bytes**. Last sampled inbox/receipt rows **1,773 each**,
ledger rows **178**, meter-pending rows **0**. Canonical raw history is intentionally
retained; these measurements are not an infinite-load cap or a claim that history
should stop growing. Parent heap and owned native RSS are separately attributed.
Wrapper CPU user/system 160.026s/54.881s; wait4 maxRSS 124,020 KiB is the maximum
among tool/test/native descendants, not native-only or aggregate memory.

Both successful fixtures invoked temporary-directory removal but ignore RemoveAll
errors: filesystem deletion was not independently asserted. Owned process absence
is positively verified. No failure forensic directory was required.

## Complete receipts and retained historical limits

`evidence/FINAL-CAPACITY-REFERENCE-2026-11-02.json` binds both runs. Companion
JSONL files are complete, not filtered summaries; manifests and both build-info
files are included.

- Operational native raw SHA-256:
  `e8d5dff31adc4c9f50b6402583a1dcf0cd741f4c977a25b76bfecd3afc2c2052`.
- Recovery raw SHA-256:
  `114c1cf2401690b2c54f4f770932a024caeed7f5e36deed83ea6273c4c5307d8`.
- Qualification raw SHA-256:
  `f8f25cc6e9fe09fb037f993e0a9999b28ea9e58f4f5ed526b96e503742fc3d14`.

Original sample-410 failure remains unclassified; the failed 13/14 refresh remains
preserved separately. Earlier 81b5 PASS with max RTT 2.046728779s retains its own
unclassified latency note. This final-source PASS does not retroactively explain,
reclassify or erase those observations, waive deployment-specific acceptance, or
automatically close a checklist item.
