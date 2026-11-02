# Operational fixture lifecycle correction

**Native validation pending.** This fixture-only change builds on custody production
commit `99f2277c9e9c59462a59c842586c869e00f67853` and the existing checked-cleanup
change `db67b40`. No production code or deadline changes; no native process ran.

- Replace direct supervisor stop competing with RunDriver by cancellation and the
  existing 10-second driver-drain bound. Require exact stopped state, verified
  owned absence, and typed HTTP 503/request_rejected delivery failure. RunDriver
  returning nil is intentional: delivery failure is reported through its callback.
- Validate the tracked epoch's genuine private baseline/final files before manual
  synthetic-budget resolution. Preserve exact usage and reject resolution replay.
- Close/reopen the same durable reconciler/spool, then restart the driver. Within
  the existing 20-second recovery bound require fresh generation, actual CP custody
  matching the complete old final, a new native epoch and readmission.
- Terminal cleanup cannot infer custody from empty files. Require retained exact
  epoch proof or validated CP custody. An undrained driver keeps ownership locks
  and forensic state; no blind process termination.
- EOF replay fixture now requires separate terminal-only evidence and an explicitly
  **synthetic** typed receipt before GC. This remains distinct from CP delivery.

Fake-only race verification passed: five top-level tests, seven including subtests,
zero failures/skips. New classifier regression first failed to compile with absent
helpers, then passed; final guard rejects a current baseline plus another epoch's
final. HTTP package 1.339s; agent package 1.061s. Exact raw JSONL and file hashes:
`evidence/OPERATIONAL-LEGAL-LIFECYCLE-2026-11-02.{json,jsonl}`.

Command (parent environment only, no child resource-cap claim):

```sh
GOMAXPROCS=1 GOMEMLIMIT=256MiB GOPROXY=off scripts/go.sh test -json -race -p=1 \
  ./internal/httpapi ./internal/agent \
  -run '^(TestOperationalLifecycleRejectsUnrelatedFailureAndUnknownStop|TestOperationalFinalGuardRejectsCurrentBaselineWithOldFinal|TestManagedObservationWindowBounds|TestOperationalNotificationFailureVisibleAndRetry|TestManagedTerminalCustodyRequiresExplicitACKAndReopensBeforeGC)$' -count=1
```

Independent read-only review found and verified correction of reopen-pointer and
tracked-final evidence guards. The original unclassified 30-minute-reference
failure and failed operational refresh receipts remain unchanged. This is not
NET03 closure or a native acceptance pass; the coordinator owns the one planned
final-composition operational refresh.
