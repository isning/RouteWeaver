# Terminal-custody final reference qualification

**PASS: the full 1,800-second observation completed, followed by revocation and
checked owned-runtime cleanup.** One planned run, no retry or skipped test.
This qualifies the changed terminal-custody production source under the bounded
single-flow reference below. It does not establish a production capacity SLA or
explain away the original sample-410 failure.

## Frozen source and profile

Source `81b5c7a11e62873a847dd0d42305f0acdcb1f793`, tree
`6dc9f1db86cd60c5db8e7906d781893a6a024ff1`. All **248 production/module/lock
paths**, **303 test paths**, and both executable hashes matched before/after.
The production manifest also exactly matches the preceding 14-case operational
PASS; the diagnostic addition is test-only.

Fresh Go 1.27.3 builds, shared local caches, `GOPROXY=off`:

- Managed executable SHA-256:
  `1f913e5cfdb21b00b4e7a31c4b5488bf5ddf453471cfa90e5edc1b590b489afa`.
- Non-race HTTP test executable SHA-256:
  `4835cd229f64fa8d05dc8552a9dd742321a3f1f57bb5de196ce7483bd5dd5c3d`.

Linux 6.18.57 x86_64. Parent `GOMAXPROCS=1`, `GOMEMLIMIT=256MiB` is a Go
scheduling/soft-memory profile, **not a CPU quota or process RSS cap**. The native
supervisor strips these variables: native Go limits/defaults and hard host caps
are not asserted. No host settings changed. No stock sing-box, local browser,
real node, public traffic, remote CI or deployment.

Only `TestNativeContinuousManagedServicePreservesPayloadAndRevocation` ran,
with `ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS=1800`; operational/provider flags
unset. Existing two-second socket deadlines, identity/renewal/revocation checks,
128 MiB parent-heap and 16 MiB agent-root-growth guards were unchanged. The outer
35-minute test timeout did not extend runtime admission/policy leases. The
coordinator completed local heavy preflight before authorizing this window.

## Exact result

- Start: **2026-11-02 04:05:10.620840 UTC**.
- Terminal exit 0: **04:35:37.011004 UTC**.
- Observation: **1,800 samples over 1,800.000224625 seconds**; unchanged identity.
- Named test duration: **1,824.96s**; wrapper duration **1,826.390s**.
- Revoked principal could not obtain a new flow; existing flow closed within its
  unchanged admission-lease bound while the native runtime itself remained live.
- After driver cancellation: owned absence true, valid **current-epoch retained
  baseline/final proof**, no running marker; pending meter batches 0, open budgets
  0, unresolved budgets 0, held bytes 0. These are observed values, not inferred
  refunds. CP custody was **not queried**, because valid local proof existed.
- Spool/reconciler Close returns were checked, with no error. Successful fixture
  cleanup invoked temporary-directory removal but ignores RemoveAll errors;
  filesystem deletion was not independently asserted.

**Latency qualification:** maximum measured sample RTT was **2.046728779s**
(first visible in the sample-1,170 summary). No socket deadline error occurred.
The elapsed sample measurement includes post-read diagnostics/scheduling; the
exact cause of the excess full-sample latency is unclassified. Do not describe
this result as proving all round trips below two seconds or the original failure
benign. Successful-run diagnostic rings were not persisted as failure forensics.

## Sampled resource/history observations

60 measurements, one every 30 samples; the last is sample 1,770, not a final
post-shutdown inventory. Owned native identity was verified for these metrics.

| Metric | Initial | Last sampled | Maximum |
|---|---:|---:|---:|
| Parent Go heap, bytes | 3,008,704 | 3,110,968 | 5,307,152 |
| Agent root, bytes | 48,637,883 | 48,637,891 | 48,638,610 |
| Owned native RSS, KiB | 33,572 | 35,484 | 35,788 |
| Owned native FDs | 12 | 12 | 12 |
| CP database, bytes | 4,096 | 2,793,472 | 2,793,472 |
| CP WAL, bytes | 1,994,112 | 4,148,872 | 4,148,872 |
| CP SHM, bytes | 32,768 | 32,768 | 32,768 |

Maximum agent-root growth was **727 bytes**. At sample 1,770: meter inbox and
receipt rows each **1,776**, ledger rows **178**, meter-pending rows **0**. Raw
canonical transport and ledger history is deliberately preserved; this explains
observed history accumulation without claiming an infinite-load cap or treating
retention as a leak. Parent and native memory are separately attributed.

Wrapper child CPU: user 179.907s, system 60.140s. wait4 maximum RSS 124,392 KiB
is the maximum among tool/test/native descendants, not native-only or aggregate
RSS; it is not a capacity estimate.

## Reproducible receipt

`evidence/TERMINAL-CUSTODY-REFERENCE-QUALIFICATION-2026-11-02.json` records the
exact command, source/binary bindings, all sampled extrema and terminal claims.
Companions preserve complete raw JSONL, both manifests and binary build metadata.
Raw JSONL SHA-256:
`1ac62096864a4896a7e8cf17f418da5db12c264e2d45da98f2ff142571a590a0`.

The original first 30-minute attempt's unclassified failure, the older diagnostic
30-minute pass, and the failed 13/14 operational refresh remain separate evidence.
This new-source PASS neither replaces those records nor automatically closes a
checklist item or waives real-deployment acceptance requirements.
