# Managed meter retention remediation — 2026-10-31

Scope: R04 on the exact remote `25ee5888b20e7bc2775edae0a791480b2fc2861c`
source tree. This is local code/test evidence, not deployment or soak acceptance.

## Lifecycle and safety contract

An exact meter receipt alone does **not** retire a native counter epoch. A live
counter can still increase after its current batch is acknowledged. Collection
retains those cursors and deliberately backpressures rather than inventing a
baseline, deleting unacknowledged evidence, or silently resetting accounting.

`CollectManagedCounters` now serializes journal collection and retires an epoch
only when its genuine zero baseline and later quiescent final have matching
epoch, binding set, and attribution, the final values are already represented in
durable cursors, and no batch for those sources remains pending. A matching
`running.json` blocks retirement; a malformed marker fails closed. A final file
is the runtime's existing completion evidence, not a new wire protocol field.

Retirement is ordered across the two durable stores:

1. Persist and fsync one `managed-retirement.json` intent beside `meter.json`.
   It binds the journal directory, exact epoch, acknowledged sequence fence,
   both file SHA-256 fingerprints, and at most 1,000 source keys.
2. Recheck the marker/fingerprints and unlink only the fixed baseline/final pair
   through a rooted directory handle. Reject symlinks/non-private/non-regular
   journal inputs, changed evidence, or a mismatched journal directory.
3. Fsync the journal directory, then atomically persist removal of those cursors
   from `meter.json`.
4. Remove the retirement intent and fsync the spool directory.

Recovery resumes that intent **before** reading retained snapshots. Interruptions
before unlink, between unlinks, after both unlinks, or after cursor pruning are
idempotent and cannot replay a removed zero baseline. An error retains recovery
evidence and backpressures collection. There is no ever-growing tombstone list.

The existing 8 MiB serialized outbox bound is unchanged. The single transient
retirement sidecar has its own 1 MiB bound, so a near-cap legacy outbox needs no
spare space inside `meter.json` to start compaction. Filesystem free space is
still required for atomic writes. Unclosed or unacknowledged epochs can still
fill the outbox: this is intentional conservative backpressure, not permission
to discard obligations. Collection checks cancellation between epochs/files;
filesystem calls and directory enumeration are not claimed interruptible.

Compaction runs on the next collection after exact ACK, including restart.
Shutdown may retain a just-acknowledged final until that next collection. No
service installation, remote action, manual journal deletion, or new cleanup
command is required or performed.

## Identity, accounting, and restore boundaries

Production `Runtime.NewWithOptions` generates a fresh 128-bit random epoch from
`crypto/rand`; configuration, descriptor, admission, and control-plane inputs
cannot choose it. Binding epochs derive from that fresh runtime epoch. The
existing `TestRuntimeReconstructionCreatesFreshExplicitCounterEpoch` verifies
separate runtime reconstructions have different runtime and binding epochs with
real zero baselines. This is the existing trusted cryptographic non-reuse
contract, **not** arbitrary malicious-ID replay protection. `BeginJournal`'s
low-level fixture interface is not an operator-supported epoch-reuse mechanism.

Do not copy a retired historical journal pair back into an active spool. Back up
and restore the reconciler state, meter spool (including any retirement intent),
and managed journal directory as one consistent stopped-instance checkpoint.
Restoring independent stale pieces is not a supported recovery procedure.

Managed `admission-budget` samples are raw cumulative evidence already accepted
durably by the control plane before retirement. They are not a second quota
charge. Per-flow final admission settlement is a distinct protocol: failed final
settlement leaves conservative reservations at the control plane. Retirement
neither refunds nor finalizes those reservations; aggregate journal evidence
never substitutes for an exact per-flow final measurement. Existing reviewed
budget recovery remains necessary when that separate evidence is unavailable.

## Verification

Toolchain: official Go 1.27.3, isolated workspace and temporary fixture directories.

- **Red:** 1,000 bindings per legitimate zero/final epoch, exact ACK after each
  collection, failed against the baseline at epoch 42 with the 8 MiB bound.
- **Green:** the same public collection lifecycle completes 100 epochs, preserves
  both zero and final values, emits no replay batches, and leaves less than
  64 KiB of settled spool state and no retired journal files.
- Pending final, wrong receipt, ACK-only/no-final, active/malformed running
  markers, incomplete or changed final attribution/totals, cancellation,
  wrong-root and symlink inputs, changed fingerprints, and four persisted crash
  cutpoints have focused regression coverage.
- A synthetic legacy `meter.json` image within 256 bytes of its 8 MiB cap can
  retire an eligible epoch without needing in-outbox WAL headroom.
- Adjacent agent meter/managed/driver tests and native module journal/fresh-epoch
  tests are run separately. Native construction/journal tests do not start a
  proxy listener or establish live traffic enforcement.

Commands completed in this worktree:

- `go test ./internal/agent -run 'TestManaged(FinalReceipt|Retirement)' -count=1`: passed.
- `go test -race -v ./internal/agent -count=1`: passed (63.672s), with 13
  pre-existing explicit opt-in native-binary/Unix-socket/procfs tests skipped,
  not counted as native execution passes.
- Final consolidated `go test -race ./internal/agent -run 'TestManaged(FinalReceipt|Retirement)' -count=1`: passed (66.522s), including the subsequently added real inherited-pipe stale-final-zero regression.
- `go test ./... -run 'Test(RuntimeReconstructionCreatesFreshExplicitCounterEpoch|Journal)' -count=1`
  from `runtimes/xray`: passed (no proxy listener started).
- `go vet ./internal/agent` and `git diff --check`: passed.

The live IPC collection path now also requires its snapshot epoch to match the
validated running marker. A finalized process briefly answering IPC cannot
recreate a retired zero cursor. The inherited-pipe regression demonstrates this
without a proxy process or network listener.
Unrun: power-loss/storage-device faults, malicious same-UID writers of trusted
private state, sustained production fleet load, real VPS/host installation, and
public-network acceptance. The existing host-specific sing-box restriction is
not bypassed. Bounded crash-image tests are not a formal filesystem proof.

Ticket evidence: RW-13 (raw meter retention, exact receipts and conservative
obligations) and RW-15 (restart recovery) gain the above local regression
coverage; no ticket is promoted to production certification by this document.
