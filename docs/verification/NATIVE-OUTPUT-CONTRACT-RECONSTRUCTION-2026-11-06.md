# Native-output review contract source reconstruction

## Provenance and scope

This documentation-only candidate starts from integration source `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`. Recovery inventory v128 reports missing historical commit `6d3db6a1c994f792a44952bdb75c17ae4403f923`; its object is absent here. This is a new reconstruction, not recovered original bytes or a claim of equivalent historical validation.

The stale sentence in `docs/design/native-client-overrides.md` said new-output creation always published the current draft without frozen review. The replacement distinguishes optional reviewed creation from legacy digest omission and explicitly excludes ID reservation and idempotent creation. No production, backend or test source changes are included.

## Source findings

- `internal/httpapi/output_review.go`: `outputCreationRequest` uses an optional digest; `previewNewOutput` requires a stable ID, prepares through `prepareOutput`, and returns the new-output scope, output ID and digest without storing an output or issuing a token.
- `internal/httpapi/outputs.go`: creation rejects existing IDs, recomputes and compares a supplied digest, records `CreationReviewDigest` only for reviewed creation, then commits through `CompareInputsAndPutWithToken`. Republish clears the creation receipt. No idempotent-success replay is implemented.
- `web/src/BasicRouting.tsx` and `web/src/Subscriptions.tsx`: both new-output paths obtain a scoped preview and submit the reviewed descriptor plus digest; receipt reconciliation is separate from creation.
- `internal/httpapi/output_creation_review_test.go`: source assertions cover a changed native override, legacy no-digest creation, captured-input changes, duplicate-ID rejection, receipt clearing and frozen private bundles. These tests were read, not executed.
- `docs/verification/reviewed-output-creation-2026-10-19.md` already describes the reviewed-creation contract; its historical test results are not current validation.

## Verification limits

Source inspection and `git diff --check` only. All executable behavior tests, typecheck, build, native parsing, browser checks, full verification and deployment are **UNRUN** for this reconstruction. The repository-referenced `/workspace/shared/routeweaver-skills/code-review.md` was absent; no external retrieval was attempted under the no-network constraint. The available software-engineering skill and repository `AGENTS.md` were read.
