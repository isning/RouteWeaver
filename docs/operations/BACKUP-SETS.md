# Offline lossless backup sets (Linux)

Use this maintenance path when a complete logical backup no longer fits the
single-file HTTP backup limits. It retains all canonical history, exact retry
receipts, relationships, accounting and unresolved obligations. It does not
prune history, reduce the source, remove cold-rebuild limits or establish a
supported production fleet size. No new service or executable is required.

## Before starting

1. Plan and authorize a maintenance window. Coordinate traffic/admission pause,
   durable meter drain and known settlements through supported controls before
   stopping the control plane; preserve uncertain obligations. Stopping the CP
   first is not a disk-full recovery strategy. This document is not authorization
   to deploy or stop a production service.
2. Stop the single control plane for export. `control-plane backup-set create`
   holds the same database inode lock as the daemon and opens the existing SQLite
   database read-only, including its WAL state, without migrations. It refuses a
   running CP rather than bypassing its lock. Do not copy only the DB while its
   WAL is live, remove locks, or manually edit SQLite files. Plan enough downtime
   for the complete export; startup must not race it.
3. Select finite budgets below. Measure the relevant filesystems and expected
   workload separately. These are hard safety ceilings, **not tested capacity,
   preallocated disk reservations, OS quotas or a service-time guarantee**.
4. Have the existing `ROUTEWEAVER_MASTER_KEY` available through the operator's
   protected environment/secret mechanism: exactly 64 hex characters (32 bytes).
   For create this is the source key; for restore it is the fresh target key.
   Keep the archive password separately. Never put either secret in argv,
   shell history, logs, issue reports or this repository. Avoid shell tracing.

## Commands and explicit budgets

All eight budget options are required; missing/zero/out-of-range values fail
before opening the source. Integers are bytes/rows, not unit-suffixed strings.

| Option | Bounds / meaning |
| --- | --- |
| `--total-bytes` | 1–34,359,738,368; total encrypted set and logical-work byte budget |
| `--total-rows` | 1–64,000,000 logical rows |
| `--part-bytes` | 8,192–1,073,741,824 bytes per encrypted part |
| `--part-rows` | 1–2,000,000 rows per part |
| `--record-bytes` | 1–134,217,728 bytes per logical record |
| `--parts` | 1–256 parts |
| `--timeout` | positive Go duration, at most `6h` |
| `--disk-bytes` | explicit envelope, at least `9 * total-bytes + 134217728` |

A record must fit the configured part too; framing/encryption consumes space.
A set can exhaust its part count before its total row budget. Select compatible
budgets from observed data; do not increase them blindly to suppress errors.
Linux available-space checks require at least `total-bytes` free for create,
and `8 * total-bytes + 134217728` free for restore. These are instantaneous
observations, not reservations; concurrent disk consumers can still cause a
safe failure. Bounded file/SQLite checks also apply during work.

The following is an **illustrative finite budget**, not a recommended capacity.
Use a protected existing password file or private pipe as stdin; interactive
terminal input is rejected to avoid echoing secrets. The password is one line,
at least 12 characters and at most 1024 bytes. Do not use `echo PASSWORD`.
The private input must be ready and reach EOF; `--timeout` covers database and
cryptographic work after password input, not time waiting for its producer.
The output directory and restore DB must not exist, even as empty placeholders.
Their parents must already be operator-controlled paths; existing permissions
are not changed for you.

```sh
control-plane backup-set create \
  --db /private/state/routeweaver.db --set-dir /private/backups/set-unique-id \
  --total-bytes 1073741824 --total-rows 2000000 \
  --part-bytes 67108864 --part-rows 100000 --record-bytes 33554432 \
  --parts 32 --timeout 1h --disk-bytes 9797894144 \
  < /private/secrets/backup-password

control-plane backup-set restore \
  --set-dir /private/backups/set-unique-id --db /private/verification/fresh.db \
  --total-bytes 1073741824 --total-rows 2000000 \
  --part-bytes 67108864 --part-rows 100000 --record-bytes 33554432 \
  --parts 32 --timeout 1h --disk-bytes 9797894144 \
  < /private/secrets/backup-password
```

`create` publishes only a complete directory. Retain **manifest.age and every
part-*.age together, unchanged**. A part is not independently recoverable and
is not an archive to upload to the web restore form. Encryption/authentication
binds the snapshot identity, ordered part inventory, digests and total stream;
missing, mixed, extra, altered or truncated files are rejected. After a crash,
create a new complete snapshot from the beginning; there is no cross-run resume
or supported way to splice parts from different runs. Protect full-set
custody and keep an independently secured copy plus a recoverable password.

`restore` validates the complete set and canonical relationships/accounting into
private encrypted staging, then publishes a fresh no-replace database. It never
activates the database or changes the configured daemon path. Independently
verify expected accounts, routes, usage, unresolved obligations and representative
historical retries on an isolated test instance without real node connectivity.
Record the source version, budgets, set custody, restore outcome and verification
results. A successful create alone is not recovery evidence. Any actual cutover,
old-data retirement or production service restart needs its own authorized plan.

## Failures, cancellation and compatibility

- Do not treat nonzero exit, incomplete directory or a truncated stream as a
  backup. Preserve source/keys; diagnose the named budget, integrity, deadline,
  lock or filesystem failure. Existing targets are never overwritten. Choose a
  fresh unique target for a deliberate retry, not a force flag.
- If publication is reported **uncertain**, preserve and inspect the target and
  relevant directory durability before any retry or activation. A target may
  exist even though the command did not report success. Never delete it blindly.
- Normal failures clean only temporary paths owned by that invocation. Crashes
  can leave encrypted `.backup-set-*`, `.backup-set-restore-*` or `.restore-*`
  staging directories. Inspect ownership, active processes and recovery needs
  first; remove only positively identified abandoned staging under an authorized
  cleanup plan. Never recursively delete a parent, existing target or source.
- This directory format is version 3; it is separate from portable single-file
  v1/v2 backups. Existing v1/v2 HTTP preview/restore remains supported with its
  unchanged limits. Do not concatenate parts, rename a set to `.age`, feed it to
  older readers, downgrade schema markers or convert by dropping records.
  Preserve a compatible current binary and master keys. Provider enforcement's
  migration fence remains effective; disabling policy does not make downgrade
  safe. No support is claimed for Windows/macOS set publication.

Tests use small synthetic budgets to cross part boundaries and exercise failure
paths. They are not a 32GiB/64-million-row soak, real-host disk exhaustion,
production deployment or real-node recovery acceptance.
