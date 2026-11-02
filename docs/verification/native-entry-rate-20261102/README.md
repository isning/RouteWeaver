# RW14.3 / RW14.4 finite managed-entry rate evidence

One authorized local run, 2026-11-02 06:05:19–06:05:29 UTC, on base
`6742d04b7e1c036de8fcc3551d0c49390f562b75`. **PASS**, no retry or changed bound.
No production code changed.

## Result

One externally supervised managed Xray executable (`26.3.27-rw1`, pinned Xray
`26.3.27` dependency), one account, two logical entries in the **same process**,
two authenticated TCP connections per entry. Each connection echoed 131072
payload bytes. At a 65536 B/s entry budget and known 4096-byte burst:

| Entry | Timed upload | Timed download | Completion |
| --- | ---: | ---: | ---: |
| entry-a | 262144 B | 262144 B | 7.939155466 s |
| entry-b | 262144 B | 262144 B | 7.940087320 s |

Both satisfy the unchanged 7.5–11.5 s window. Timed total: **1048576 B**.
Four preopened connections each warmed up with a one-byte echo outside timing;
final journal total is 1048584 B (8 extra duplex warmup bytes). Snapshots and
stopped journal assert unique entry/account/route/inbound/subject attribution,
measurement layer, stable epochs, and exact per-direction totals. Owned process
absence and checked broker/reconciler closes passed; `running.json` was absent.
Owned evidence root `/tmp/rw-entry-rate-1498374136` is deliberately retained.

The lower bound distinguishes unrestricted, per-direction and per-connection
buckets (roughly 0/4 s instead of 8 s); the upper bound distinguishes an erroneous
account-only bucket shared across entries (roughly 16 s). These are finite,
owned-loopback observations, not an SLA, WAN benchmark, or formal proof against
all possible faulty implementations. Mutated-runtime negative controls were not
run; only the gate's missing/skipped/failed-result controls were executed.

## Authority and coverage boundaries

Admission is an explicitly synthetic broker returning 65536 B/s leases. This run
proves actual executable enforcement, not CP entitlement/rate conversion. The
existing separate `TestAdmissionHTTPRequiresEnrolledEntryAndRevokesCredentialRenewal`
asserts service 2048 B/s becomes HTTP lease 2048 B/s; that test was inspected, not
rerun here. Existing embedded
`TestNativeVLESSTCPAndTLSSharedDuplexRateUnionAndAccountRevoke` covers TCP and TLS
shared duplex timing, but its second entry had only a small traffic probe. This
new external case supplies actual simultaneous independent-entry throughput;
it uses plain VLESS TCP, not a new external TLS measurement.

No stock sing-box, Chrome, host-setting changes, remote CI, push, live enrollment,
production credentials or public network target was used.

## Reproduction and integrity

Prepared with `checklist-tools-20261101/env.sh` (Go toolchain/caches, serialized
build settings). Built without execution:

```sh
scripts/go.sh -C runtimes/xray build -trimpath -o "$E/routeweaver-xray" ./cmd/routeweaver-xray
```

One authorized native command, with pipefail and complete JSONL capture:

```sh
ROUTEWEAVER_MANAGED_XRAY_BIN="$E/routeweaver-xray" scripts/go.sh test \
  -json -race -p=1 -count=1 -timeout=60s \
  -run '^TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries$' \
  ./internal/agent 2>&1 | tee "$E/native-rate.jsonl"
```

`E=/workspace/scratch/d385eb428cee/native-entry-rate-evidence-20261102`.
Test elapsed 8.76 s, package elapsed 9.804 s; zero skipped tests. Before/after
hash files agree:

- Test: `25f4b7e15801b0aa0e695127c8a6d7c3944aaaaf6559e9bdde8df2ad71171680`
- Managed executable: `b75d8b22bdd35f38fa2eceed2ccd6ea7d5611f7f601115c36a17c5ae967b87be`

Separately verified unchanged dependency pin (not included in the before/after hash files):

- Runtime go.sum: `ed2f0a380fcd1b855f4c3c562298bc23d0fbacdb3045ea5c2ac3807dd2c2b5e3`

The race-enabled **test harness** supervised a non-race managed executable.
Compile-only `scripts/go.sh test -race -run '^$' ./internal/agent` passed, with
no tests executed; it is not additional native evidence.

## Mandatory existing CI gate

`scripts/managed-runtime.sh` now selects and requires the named test's pass event.
Missing, skipped or failed results fail the existing gate; the existing native
job already runs `scripts/verify.sh managed`. No new job was added and remote CI
was not run. `python3 -m unittest scripts/test_managed_gate.py`: RED against the
old selector, then all 5 tests GREEN after gate registration. Its events are
synthetic, not native evidence. Full managed gate/full repository suites were not
rerun in this focused task.

An independent read-only reviewer checked timing synchronization, gate selection,
cleanup and accounting; attribution and uncertainty-marker assertions were
strengthened before the authorized execution. No remaining code-review findings.

Final independent evidence cross-check verified all nine raw artifact hashes, exact
JSONL timing/pass/cleanup claims, final journal attribution/totals, source/binary
hashes and unchanged runtime production tree. No remaining evidence findings.
