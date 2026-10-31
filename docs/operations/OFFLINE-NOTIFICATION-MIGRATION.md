# Offline notification migration to a fresh database

Use this tool when normal startup refuses a legacy whole-state notification row
above its **64 MiB** automatic migration limit. It creates a separately verified
new database; it does **not** activate that database, rename the source, change a
service configuration, or start a server. The Linux release includes the
`routeweaver-notification-migrate` executable; no Go compiler is needed on the
production host. Linux runtime tests do not establish macOS runtime support;
Darwin cross-compilation alone is not a runtime test.

## Before running

1. Stop **every** control-plane instance using this database, including aliases
   and hard links. Keep them stopped until migration and your separately reviewed
   recovery/activation procedure are complete. Do not replace/unlink the source
   database or its SQLite sidecars. `Store.Open` deliberately does not acquire the
   process lock; the control-plane CLI and this offline tool do.
2. Preserve your existing offline backup. The source must be a trusted
   operator-owned SQLite database with the supported physical schema, not an
   arbitrary uploaded SQLite file. Keep source/output directories private and do
   not concurrently create or replace their names or sidecars.
3. Choose a new output basename in an existing private directory. The main file,
   `-wal`, `-shm`, and `-journal` must all be absent. Source aliases and source
   sidecar names are not valid outputs. Never remove unfamiliar sidecars to make
   a refused command succeed; choose another basename.
4. Supply the existing 32-byte key through `ROUTEWEAVER_MASTER_KEY` (64 hex
   characters) using your established secret-injection mechanism. Do not put a
   key in command arguments, source files, logs or shell history.
5. Review memory and temporary-disk capacity. The legacy plaintext-row budget is
   explicit and at most **256 MiB**. The explicit Go soft memory limit must be at
   least `8 × max-record-bytes + 256 MiB`; this is not an OS memory reservation or
   a hard RSS ceiling. Allow disk space for the physical snapshot and the fresh
   logical restoration concurrently, in addition to the unchanged source.

## Executable commands

Run from the extracted Linux release directory. Replace the example
paths with your reviewed offline source and a **new** output path. This example
allows an 80 MiB legacy record and selects a 1 GiB Go soft memory limit:

```sh
./routeweaver-notification-migrate \
  --source /absolute/private/state.db \
  --output /absolute/private/state.notifications-migrated.db \
  --max-record-bytes 83886080 \
  --memory-budget-bytes 1073741824 \
  --timeout 15m
```

For a source build instead, use the verified Go toolchain:
` scripts/go.sh build -trimpath -buildvcs=false -o ./bin/routeweaver-notification-migrate ./cmd/notification-migrate`
and run `./bin/routeweaver-notification-migrate` with the same options.

`--max-record-bytes` and `--memory-budget-bytes` have no implicit defaults.
`--timeout` defaults to 15 minutes and must be positive and at most one hour.
Cancellation is checked between 128-page SQLite backup batches and by logical
backup/restore. A synchronous, bounded decoding/initialization stage finishes
before its next cancellation check; the timeout is not a process kill switch.

The command holds the same source-inode flock as the control-plane process for
its entire operation. It opens SQLite in **read-only mode**, pins a read
transaction, validates schema and encrypted record lengths, and uses SQLite's
online backup API to include committed WAL pages in a consistent snapshot. It
never runs `Store.Open` on the source. SQLite may maintain WAL shared-memory
readmarks; the source database and WAL application data are not rewritten.

Only the owned temporary copy is opened with the reviewed larger legacy-row
budget. Migration preserves accepted event IDs, payloads, delivery state/leases,
settings/secrets, announcements and receipts. The result then passes the existing
fresh logical restore: 32 MiB per record, 1 GiB logical backup, two million rows,
canonical streamed verification, and no-replace publication. Temporary artifacts
owned by this attempt are removed; caller-owned files are never cleaned up.

## Outcomes and recovery

**No in-place downgrade:** the split notification format is not readable by older
whole-state binaries. Never start an older binary on the migrated output or edit
migration markers. A rollback requires the preserved original database (including
its consistent WAL state), matching original key, and compatible prior binary
under a separately reviewed, stopped-service recovery procedure. Keep the source
and fresh output separate; this command authorizes no activation.

- **Success:** a verified new file exists at `--output`. No service is activated.
  Keep the original source and perform your separately authorized activation and
  recovery checks. Do not replace a database inode while any process holds it.
- **Refusal or failure before publication:** the source remains unchanged and no
  output is published. Fix the reported issue; choose a new path if occupied.
- **Publication uncertainty:** an output may exist even though final directory
  durability could not be established. Inspect it before any retry; never assume
  an error means no file was created. The tool will not overwrite an existing
  result. It does not delete or repair caller-owned sidecars.
- **Record over 256 MiB or other exhausted limits:** stop and plan a separately
  reviewed recovery. Do not raise startup caps, remove migration markers, truncate
  notification history, or bypass the lock to force this tool through.

## Verification scope

Synthetic tests cover checkpointed and WAL-backed source copies, accepted-state
preservation, source/alias held-lock refusal, source-sidecar output collisions,
occupied/dangling output paths, stale valid output WAL refusal, wrong keys,
unsupported schemas, migration-trigger failure, explicit byte-budget refusal,
cancellation before work and between copy batches, owned-temp cleanup, normal
output reopen and default backup acceptance. The existing control-plane lock
regression still passes after extracting the opt-in helper.

The explicit large test is not part of ordinary CI's memory envelope:

```sh
ROUTEWEAVER_RUN_LARGE_NOTIFICATION_MIGRATION=1 GOMEMLIMIT=1GiB \
  scripts/go.sh test -count=1 -run '^TestOfflineNotificationMigrationLargeLegacyOptIn$' \
  -v ./internal/store
```

Run this case alone and without `-race`. The synthetic fixture contains 8,500
8,000-byte event bodies (73,974,613-byte legacy JSON). A bounded local run with an
80 MiB migration budget passed default-startup refusal, source DB/WAL digest
preservation, fresh normal reopen, default 32 MiB-record backup validation of
34,004 records, and overwrite refusal. This is not production-load, target-host
memory, live-deployment or exhaustive crash/durability evidence.
