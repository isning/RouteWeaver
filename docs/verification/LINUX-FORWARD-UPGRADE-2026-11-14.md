# Bounded Linux forward-upgrade rehearsal

Date: 2026-11-14. Result: passed for the exact source pair below, using disposable
loopback state. No real VPS, node or external notification provider was involved.

## Versions and scope

- Source: `a9f1af5d36d3506c997af03be1c4c37e322a9dcd`.
- Target: `e663486644c46e4ade7c68fb6fa2e59f12d6dd76`.
- Both control-plane programs were built from source with official Go 1.27.3.
  The source revision declares Go 1.27.2; this is not a test of a retained
  historical release archive or of its original compiler output.
- Old binary SHA-256: `1291fabe9713802d66c04bde150c88868ac35278d96fff8e1e28004bd4fa09d8`.
- Target binary SHA-256: `2ddaa09c00bdb34edad3710c313364fcfd8b217892d85b2992877b55fcb484bf`.

The old source was a detached Git worktree at the stated source commit. Its
binary metadata records that revision and `vcs.modified=false`. The target was
built from a checked clean worktree at the stated target commit; the command
used `-trimpath -buildvcs=false`. Its source binding therefore comes from the
recorded clean checkout/build execution, **not** an embedded VCS attestation.
The build commands, with local output paths represented symbolically, were:

```sh
# In the detached historical source, using the same official compiler:
ROUTEWEAVER_GO="$OFFICIAL_GO_1_27_3" scripts/go.sh build -o "$OLD_BINARY" ./cmd/control-plane
# In the clean target source:
scripts/go.sh build -trimpath -buildvcs=false -o "$TARGET_BINARY" ./cmd/control-plane
```

This crosses the real notification storage-layout boundary: the old program
writes one encrypted `notification-private/state` record; the target migrates
that state to separate configuration, announcement, event, delivery, history,
inbox and read-receipt records. Both observed migration histories remain `[1,2]`.
This does **not** exercise the provider-policy migration-3 fence.

## Executed path

1. Start the old program with a new temporary database and synthetic bootstrap
   account. Through real HTTP, publish a subscription, rotate its token, publish
   an in-app announcement and mark its notification read. No external notification
   channel is configured.
2. Stop the old program. Preserve the original and create a consistent SQLite
   backup copy. Start the target program on the copy with the existing master
   key and **without bootstrap credentials**.
3. Authenticate the existing account. Compare its exact account ID, the complete
   notification inbox including `readAt`, and the published subscription bytes.
   Confirm the retired token still returns 404. Inspect persisted record kinds:
   the old notification representation is gone and the separated records exist.
4. Stop the target. Use its real `backup-set create` and `backup-set restore`
   commands with bounded small-fixture budgets and a different target master key.
   Start the fresh restored database without bootstrap and repeat the same
   account, notification/read-receipt, feed and retired-token checks.
5. Confirm the preserved original main database hash is unchanged, then reopen
   it with the old program and repeat those user-visible checks. No old program
   opens the upgraded database. The hash assertion is for the main database,
   not a claim about every SQLite sidecar file.

Independent review checked the executed driver and result against these claims.
No production defect was reproduced, so no speculative migration change or new
permanent test matrix was added. The existing package smoke separately covers
same-version extracted-package recovery.

## Remaining limits

This is evidence for this pair and these facts, not an all-version compatibility
promise, a large-history capacity measurement, a multi-node upgrade, or a live
rollback rehearsal. It does not verify external TLS/OIDC files, real IdP access,
agent journals, public networking, or post-backup accounting reconciliation.
Retain the pre-upgrade backup and compatible package. Never infer that an older
program can safely open state already written by a newer program. Follow the
[package upgrade and recovery procedure](../PACKAGE-QUICKSTART.md#upgrade-and-recovery)
for a separately authorized deployment.
