# RW-12.3 explicit rename reference proof

Base: `6742d04`. Existing domain name-allocation tests establish input-order
stability, collision add/remove persistence and explicit-label allocation changes.
`TestRenamingDoesNotChangeStableReferences` checks one domain endpoint member;
`TestNativeOutputScopedPreviewRetainsNamesWhenCollisionsChange` checks output-scoped
collision changes. Neither directly asserts both endpoint and group explicit
rename against final rendered rule/group references.

New selector:
`TestExplicitEndpointAndGroupRenamePreservesRenderedReferences`.

The public domain validator and renderer registry are exercised for the declared
Mihomo and sing-box targets. Starting with colliding endpoint/group labels and
retaining the previous allocations, the test explicitly renames both objects.
It checks the stable-ID policy graph remains unchanged; only the renamed
allocations change; unrelated allocations remain stable; endpoint definitions
still identify the same connection; nested group memberships, endpoint/group rule
actions and final/default action use the correct new names. Mihomo comma
normalization is asserted explicitly. Old allocated labels are absent from the
new artifact. No naming implementation changes were needed.

Local pinned Go validation:

- `go test -race ./internal/render -run '^TestExplicitEndpointAndGroupRenamePreservesRenderedReferences$' -count=1`: PASS, 1.108 s, both targets.
- `go test -race ./internal/domain -run '^(TestStableNamesDoNotDependOnInputOrder|TestReadableNamesPersistAcrossCollisionChanges|TestRenamingDoesNotChangeStableReferences)$' -count=1`: PASS.

This is deterministic domain/renderer evidence, not native parsing, traffic,
browser or publication execution. The existing HTTP collision test was inspected
but not rerun in this focused task. No production files changed and no CI ran.
