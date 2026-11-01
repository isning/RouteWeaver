# Operational recovery drills — frozen production source eafb493

**14 focused tests passed under `-race`, no failed/skipped requested tests.**
Production code and frozen integration were unchanged. New test-only coverage
joins real managed Xray, synthetic scoped HTTP admission, durable counters,
notification outbox HTTP reads and fresh encrypted restore. No stock core,
Chromium, external provider/destination, host security/network change, CI dispatch
or 30-minute soak repetition was involved.

[Operator runbook](../operations/PRIVATE-LINUX-RECOVERY-DRILLS.md) ·
[Source/binary binding and all 14 results](evidence/OPERATIONS-DRILLS-2026-11-01.json) ·
[New drill log](evidence/OPERATIONS-DRILLS-2026-11-01.jsonl) ·
[Existing recovery race log](evidence/OPERATIONS-RECOVERY-RACE-2026-11-01.jsonl)

## New joined evidence and measured times

| Drill | Assertion | Measured reference result |
| --- | --- | --- |
| Notification failure → retry | Persisted retrying/error state visible through real authenticated outbox HTTP; sanitized error; new worker uses same event ID; accepted event is not resent | Failure visible 82.73 ms; retry dispatch/read 57.61 ms. Logical clock advances to the recorded approximately one-minute backoff; no wall-clock provider recovery claim |
| Brief CP outage | Request barrier drains admitted calls; retained observation timestamp cannot advance while fixture returns 503; fresh observation after reconnection | Outage 254.39 ms; observation refresh 74.14 ms |
| Backup during native traffic | Complete encrypted archive while payload continues; authenticated fresh restore/reopen preserves desired identity; original core/flow remains live | Archive 94,142 bytes; export 22.96 s with 251 echo exchanges completed inside the export window; fresh verify/restore/reopen 15.30 s; restored copy **not activated** |
| Exact traffic/accounting checkpoint | Actual native cumulative payload equals independently counted successful echo traffic, and CP raw/weighted totals equal that same amount | 13,346 bytes at the checkpoint; active-flow CP settlement observed within 9.23 s |
| Long authority loss | Actual existing native flow closes within its bounded admission lease; whole runtime remains live; deliberately blocked final settlement leaves an unresolved reservation, not a refund | Flow restricted after 29.89 s; bound was 30-second lease + 3-second observation margin |
| Explicit operator-assisted recovery | Stop only the owned core; prove absence and exact native final; finalize current budget digest with stopped-runtime attestation; replay returns 409 and usage is unchanged; restore authority and require generation +1 runtime and new admitted flow | Stop/final reconciliation 108.88 ms; fresh-generation restart/readmission 11.38 s; subsequent real revocation and cleanup pass |
| Broker loss and native journal replay | EOF closes actual payload/listener/process and produces exact native final; real baseline/final become identical durable meter batches after spool reopen/recollection; matching synthetic receipts suppress acknowledged replay after another reopen | Exact 44-byte final; EOF/stop/final observation 17.52 ms; durable spool reopen/replay check 7.88 ms |

These are bounded race-instrumented measurements on a shared ephemeral Linux
executor—not target RTO/RPO, availability or capacity promises. The metering
checkpoint precedes the later fresh connection/revocation traffic; 13,346 bytes
is not a claim about all bytes over the complete test. Native EOF spool receipts
are deliberately synthetic; the other joined test separately verifies actual CP
settlement and real authenticated administrator reconciliation/replay rejection.
The native restart is **operator-assisted**, not automatic seamless failover.

`GOMAXPROCS=1` and `GOMEMLIMIT=256MiB` configure only the parent test/CP process in
the new native drills. The supervisor strips these ambient variables before
native launch; native defaults and host hard CPU/RSS limits are unknown. The
11 existing recovery tests used the shared test toolchain environment (Go
parallelism 2, soft memory target 768MiB); neither setting is a CPU/RSS quota.

## Existing evidence reused and rerun rather than duplicated

- Encrypted restore preserves a real outstanding 100-byte admission reservation;
  a final report of 30 is charged once despite replay and exactly 70 becomes
  available. The original live DB remains unchanged.
- Streaming snapshot export paused at its emitter does not block live admission
  or configuration writes, and its generation/counter snapshot stays atomic.
- Counter ingestion is atomic/replay-safe and keeps provider accounting separate;
  a new counter epoch preserves known usage and records unknown baseline bytes
  rather than charging them or accepting a same-epoch regression.
- Durable notification outbox survives storage reopen, stable event identity,
  bounded retries and crash-after-acceptance handling. Retry delay starts after
  transport failure rather than before a slow attempt.
- Blocked CP polling cannot delay local expiry restriction; agent generation
  fences and managed baseline/final collection cursors survive reopen. Journal
  retirement crash cases cannot replay already acknowledged epochs.

These controlled seams complement, rather than substitute for, the real native
traffic drills. Their exact test names and elapsed times are in the receipt.

## Reproduction and stopping rule

The runbook command executes the three new/extended named drills with explicit
`ROUTEWEAVER_OPERATIONAL_DRILL=1`. The standard continuous native test remains
separate and unchanged in intent; it does not silently acquire the drill mode.
For the 11 recovery tests, use the named tests in the receipt with:

```sh
scripts/go.sh test -json -race -p=1 -count=1 -timeout=120s \
  -run '^(TestEncryptedBackupRestorePreservesOutstandingAdmissionObligation|TestBackupStreamingDoesNotBlockAdmissionOrConfigurationWrites|TestCounterExplicitRestartPreservesKnownUsageAndRejectsRegression|TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider|TestRetryDelayStartsAfterTransportFailure|TestDurableOutboxRestartStableIdentityAndBoundedRetries|TestCrashAfterAcceptanceReusesEventIDAndRechecksSettings|TestSlowControlPlaneCannotDelayLeaseRestriction|TestDriverRestartRetainsGenerationFenceUntilNewDesired|TestManagedRetirementCrashReopenNeverReplaysAcknowledgedEpoch|TestManagedMeterRequiresRealBaselineAndRecoversCollectionCursor)$' \
  ./internal/store ./internal/notifications ./internal/agent
```

All required names must have a pass event; requested skips/missing results are not
passes. A failed final/cleanup must retain its evidence and remain a failure, not
be replaced by a healthy-looking observation. The drill stops after recovery,
replay refusal, final revocation and owned cleanup are established.

## Remaining deployment gates

Actual provider acceptance/delivery, real network failure shapes, OS/power-loss
crash recovery, target filesystem durability, keys/TLS/access setup, realistic
load/retention and operator-defined RTO/RPO remain target-specific. No artifact
here authorizes deployment, a live database swap or real-account reconciliation.
