# Tenant relationship transaction remediation (D02)

Baseline: local exact-source commit `0cd3e4b6ce19a73e3e869dc3eaa1e185b7e2bb9f`, tree `774d13f87b43ef68e9ed0fafd296bc352f11c559` (remote source `25ee5888b20e7bc2775edae0a791480b2fc2861c`). Synthetic databases and loopback HTTP only; no deployment or real data.

## Contract and implementation

Relationship validation and the final write must agree at one SQLite writer boundary across independent Store handles. Collection/profile saves now retain exact referenced inputs and their previous target version, then commit by the existing encrypted record CAS primitive. Deletion captures the target, dependent-set memberships, and every inspected dependent value; a new compare-and-remove primitive rechecks all of them under the SQLite writer reservation before removal. Membership checks reject newly introduced dependent rows; value checks reject references introduced into existing rows. Decode failure refuses deletion.

This does not hold a SQLite writer across rendering/network work, add a process-only mutex, cascade-delete historical data, or rebuild/republish frozen outputs. Existing source updates, accepted resource imports and output publication already use input CAS. A rejected conflicting mutation retains the winning state and returns the existing conflict contract.

The tenant source/profile explicit reveal endpoints also require successful audit persistence before returning private data, returning a minimal 503 on audit failure and setting `Cache-Control: no-store`. Other reveal paths and their failure-injection acceptance tests are integrated by the D03 owner.

## Verification

- Baseline HTTP tests failed for source→collection and source/collection/resource→profile (both create and update of an existing profile): both conflicting requests returned 200. The profile→output fixture passed in its sampled baseline ordering; it remains a regression, not a claim that every ordering was previously safe.
- The same eight HTTP scenarios passed after the change. Public Store tests cover stale dependent membership, changed dependent payload and replaced target across independent handles, plus successful removal.
- Existing focused source/template/frozen rule bundle/feed and record-CAS regressions passed.
- Focused concurrency tests also passed with `-race -count=3`; these are repeated bounded scenarios, not exhaustive scheduling exploration. `go vet` passed for the affected HTTP/store packages.

Commands (using the workspace's checksum-verified official Go 1.27.3 environment):

```sh
scripts/go.sh test -mod=readonly -p=1 -count=1 -run '^Test(Delete(SourceCreateCollection|DependencyCreateProfile)Race|RelatedRecordDeleteCAS)' -v ./internal/httpapi ./internal/store
scripts/go.sh test -race -mod=readonly -p=1 -count=3 -run '^Test(Delete(SourceCreateCollection|DependencyCreateProfile)Race|RelatedRecordDeleteCAS)' ./internal/httpapi ./internal/store
scripts/go.sh vet ./internal/httpapi ./internal/store
scripts/go.sh test -mod=readonly -p=1 -count=1 -run '^Test(Source|OwnedRule|Rule(File|Refresh|Bundle)|FrozenBundle|FeedRotation|TenantIsolation|ProfileTemplate|ProcessingPreset|RelatedRecord)' ./internal/httpapi ./internal/store
```

This is bounded concurrency regression evidence, not exhaustive interleaving proof or production-load evidence. Tenant deletion still scans that owner's relevant dependent records; it introduces no new scale claim. Aggregate/full-suite verification belongs to integration.
