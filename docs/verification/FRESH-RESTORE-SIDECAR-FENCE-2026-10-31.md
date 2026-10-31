# Fresh SQLite publication: sidecar fence

An independent synthetic regression demonstrated that checking only an absent
output main file is insufficient. A valid stale output WAL was left in place;
a newly restored main file was linked beside it. Reopening that output exposed a
foreign audit row and zero migrated notification events. No real database was
used.

`RestoreBackupFresh` now checks both raw and canonical output names, including
`-wal`, `-shm`, and `-journal`, before restoration. Files, directories and dangling
symlinks all count as occupied. It also rejects output names belonging to the
source's SQLite filename family, using SQLite's actual main database path. The
publication helper repeats the freshness checks after verification/file sync and
checks cancellation immediately before the existing no-replace `os.Link`.

No caller-owned artifact is removed. Prepublication refusal remains a known
failure with no output link attempted. Existing post-link directory-sync failures
still return `ErrRestorePublicationUncertain`, even when cleanup removes the new
main file; durable publication is not recategorized as failure by later context
expiry. There is no change to the existing uncertainty contract.

Tests cover every fixed sidecar suffix, regular files/directories/dangling
symlinks, canonical parent aliases, absent source-journal output collisions, and
a sidecar appearing between admission and final publication. They assert source
and caller-sidecar preservation and that the late refusal never attempts the
link. Original restore, backup rollback/concurrency, no-replace, cancellation and
publication fault tests were rerun with race detection.

The directory must remain operator-private and stable during this cooperative
offline procedure. Multiple path checks are not an atomic namespace reservation
and do not defend against arbitrary malicious local filesystem writers. The
no-replace main-file publication itself remains atomic.
