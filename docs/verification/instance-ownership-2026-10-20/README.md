# Atomic instance ownership verification

Date: 2026-10-20. Integration baseline: `bb0e160`.

## Scope and contract

This is a bounded deployment-ownership safety guard, not multi-listener composition or core-family uniqueness. Direct publication atomically commits ownership proof, every requested target generation, desired package and immutable manifest. Fleet retains its existing authorization/current-state comparisons and commits ownership with each target queue; staged Fleet execution is not claimed to be whole-batch or distributed-runtime atomic.

The encrypted `instance-owners` record is keyed by stable instance ID. `deploymentId` identifies the owner; `unconfigured: true` records explicit first-install provenance. Legacy ownership derives only from exact desired/observed/last-known-valid immutable manifest identities. Missing or contradictory evidence blocks activation. If accepted records are absent but a generation counter survives, an unproven claim cannot claim generation 2 or later. Nonactivating install/stop cannot manufacture fresh provenance over this unknown history.

Same-owner updates remain allowed. Foreign-owner activation is rejected. Stop, install, expiry and runtime failure do not release ownership. Explicit stop remains usable against accepted packages when the draft is invalid. No transfer/release API was added. Unsupported Fleet actions, including a separate `restart`, remain unsupported.

## Red → green evidence

- At source baseline `10d0ab4`, `TestPublishRejectsForeignInstanceOwnerWithoutWrites` failed: deployment B returned HTTP 200 and queued generation 2 on both instances after deployment A, rather than HTTP 409. Fixed by `465cfa1`.
- The callback generation-map mutation regression failed at `465cfa1`; cloning callback input in `466f803` protects the committed allocation. The independent reviewer reproduced and confirmed this correction.
- `TestMissingAcceptedRecordsCannotResetOwner` failed before `2f2c1fe`: missing desired/owner records allowed a different deployment to claim generation 2. The final transactional first-generation check passes this regression and the install→stop laundering regression.

## Integration rerun

All commands below ran serially on `bb0e160`, with `GOMEMLIMIT=512MiB`, the official relocated Go compiler selected through `ROUTEWEAVER_GO`, and a writable warmed `GOCACHE`. No web tests, preview restart or binary replacement occurred.

```sh
scripts/go.sh test -race -p=1 ./internal/httpapi \
  -run 'Test(PublishRejectsForeign|PublishConflictIsAtomic|LegacyOwnership|Fleet|Nonactivating|ConcurrentPublications|LegacyUnowned|ExpiredLease|MissingAccepted|InstallCannot)' \
  -count=1
scripts/go.sh test -race -p=1 ./internal/store \
  -run 'TestComparedGeneration|TestUsageProjectionNormalMutationSeamsStayIncremental' \
  -count=5
```

Results: HTTP/Fleet/ownership PASS (15.291s); store PASS (five repetitions, 7.211s). Exact outputs are retained in `http-race.log` and `store-race.log`.

Coverage includes direct/Fleet cross-path ownership rejection, same-owner updates, multi-target no-partial-write conflicts, concurrent first claims, independently opened Stores racing a claim, legacy missing/mismatched/contradictory proof, late Fleet execution rechecks, stop/install retention, expiry/error retention, upgrade/historical rollback guards, callback/serialization rollback, set-membership fences, and actual snapshot export/restore preserving ownership and counters.

## Prior checks and independent review

The implementation worktree passed the full default `internal/httpapi` suite, static verification gates and HTTP/store vet. Final focused HTTP/Fleet race tests passed in 14.603s; focused store race tests passed five repetitions in 6.582s before integration. An initial race compilation import error occurred while sources were changing; the stable-source rerun passed. It is not counted as a successful run.

`independent-review.md` preserves the exact independent review, including its final `2f2c1fe` delta review and independent public HTTP probes. No unresolved finding remained within the bounded review scope.

## Limits

These checks are not a formal race proof, broad native-process/traffic verification, a full backup suite, a full web suite, or a production deployment. No browser, live VPS, credentials, production settings or running application binary were touched. Wider integrated verification is tracked separately.
