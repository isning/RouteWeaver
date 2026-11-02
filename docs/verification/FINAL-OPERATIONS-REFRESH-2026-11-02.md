# Final-source bounded operational refresh — 2026-11-02

**Failed: 13/14 required top-level tests passed, one failed; no skips or retries.** This was one planned operational-drill refresh, not another 30-minute observation. It does not close NET-03 or explain the previous sample-410 read/cleanup failure.

Production base `c95e477c1cf33908962017d103ea1326bd8f98e7`; test-only cleanup delta `db67b40`. All 244 production Go/module/core-lock paths and hashes exactly match the final managed reference source. The reused native binary digest is in the [complete receipt](evidence/FINAL-OPERATIONS-REFRESH-2026-11-02.json). Production/test sources and native binary were unchanged throughout.

## Executed scope

Both commands used `-json -race -p=1 -count=1`, parent `GOMAXPROCS=1 GOMEMLIMIT=256MiB`, existing deadlines and synthetic loopback destinations only. `ROUTEWEAVER_OPERATIONAL_DRILL=1`; observation-duration and provider-drill options unset. Parent Go settings are not hard CPU/RSS caps and do not reach the sanitized native child. No stock core, browser, remote CI, host settings or real node was involved.

- Three named operational tests: original `180s` package test timeout, 02:50:19.727339Z–02:51:56.339338Z, command exit 1. Notification case passed 0.36s; joined native operational case failed 85.26s; native broker-EOF/replay case passed 1.14s.
- Eleven existing recovery cases: original `120s` package test timeout, 02:51:56.345233Z–02:52:34.354483Z, command exit 0. All eleven top-level cases and seventeen total test/subtest pass events passed. Together the logs contain nineteen test/subtest passes and one test failure.

Exact selectors, command arrays, every test/subtest result and elapsed time, raw JSONL hashes, and before/after bindings are in the receipt. Raw JSONL is retained without stripping failure events:
[operational cases](evidence/FINAL-OPERATIONS-REFRESH-2026-11-02-native-drills.jsonl) · [recovery cases](evidence/FINAL-OPERATIONS-REFRESH-2026-11-02-recovery.jsonl).

## Useful completed assertions

Notification failure was visible in 70.58ms and retry accepted in 61.29ms after advancing the fixture clock to its recorded retry time. Brief transport outage was 254.66ms and fresh observation returned in 28.55ms. The real native and CP raw/weighted checkpoint matched **11,630 bytes**, settling within 3.91s. Encrypted backup was 96,248 bytes, export 18.31s with **219 echoes inside the export window**, and independent verify/restore/reopen 15.25s; restored copy was not activated.

The separate native broker-EOF case retained an exact 44-byte final, preserved exact batch digests across reopen, and suppressed replay using explicitly synthetic matching receipts. Its owned absence and reconciler/spool close checks passed. The eleven separate recovery tests passed, including encrypted outstanding-obligation restore, nonblocking backup, counter replay, notification crash/retry, lease enforcement and retirement crash recovery.

## Failed phase and cleanup

The joined operational case failed at its existing assertion **“stopped runtime lacks exact native final measurement”**, before explicit operator finalization and fresh-generation recovery. Cleanup additionally reported **“live managed snapshot has no matching running epoch.”** New terminal checks found:

- Identity-verified supervisor absence: true; no global process-enumeration claim.
- Native journal empty; running marker absent; no pending transport batch or retirement intent. This is **consistent with acknowledged retirement**, not a preserved positive final receipt.
- CP budget remained open/unresolved: settled 11,630 bytes, **1,036,946 bytes retained**, not refunded.
- Driver returned; checked spool/reconciler close calls reported no errors. Whole-test cleanup is still failed because the driver and terminal obligations failed.

Private forensic root `/tmp/rw-service-native-555640217` is retained. Its native files and 0600 CP DB/WAL/SHM copies, synthetic key context and stacks are not committed. Physical copies are non-atomic diagnostic images, not a validated backup or authorization to restore/activate anything. Meter state reads show acked=65, next=66, no pending batches and no managed-source cursors.

## Classification and next boundary

Independent read-only review confirms a **fixture synchronization defect**: the operational helper directly calls `supervisor.Stop` while `RunDriver` is active, contrary to the documented caller-Reconciler-lock requirement, then assumes the physical final remains for its own journal read. The driver collector can legitimately retire a final already represented by acknowledged counters. Empty journal/cursors and the concurrent live-snapshot error strongly support this race; the exact interleaving is not recorded. No production regression is proven or conclusively excluded.

The remaining reservation is expected fallout from aborting before the fixture's explicit finalization—not an independently established settlement defect. Merely replacing direct Stop with StopOwned would not prove collector quiescence, because collection happens outside the reconciler lock. Any correction must deterministically coordinate collection/owned shutdown and retain real final evidence without fabricated counters, deadline relaxation or treating an unavailable final as zero. No second native run was performed.

Wrapper wait4 maximum RSS was 1,065,976 KiB across compiler/test descendants; it is neither native RSS nor a simultaneous aggregate. It must not be reported as a native process resource measurement or evidence that a hard memory quota existed.
