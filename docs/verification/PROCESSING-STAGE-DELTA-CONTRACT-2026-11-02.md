# RW-05.3 processing-stage delta contract

The catalog requires added/removed/changed options and reasons for processing
stages. A processing step is not a comparison with a previously saved collection
or a previously accepted source snapshot.

- Every stage serializes `addedIds` as an array and `comparison` as either
  `step-input` or `snapshot`.
- Enabled `source` and `aggregate` steps compare their immediate input/output by
  stable endpoint ID. `addedIds` follows output order. Current keep, drop, rename,
  sort, deduplicate and override operations create no endpoint identities, so
  additions are explicitly zero, not absent. Existing removed/changed semantics
  are preserved: content changes include merged provenance; sorting alone is not
  a content change. Disabled steps have no stage.
- `raw`, `source-result` and `merged` are snapshot views, not deltas from an empty
  collection. Their existing empty removed/changed arrays and new empty additions
  array do not claim a comparison. UI shows count only; actual step counts name
  the step-input baseline. Older responses infer actual steps from both `stepId`
  and source/aggregate scope. Existing operation labels identify the reason;
  stable IDs and provenance retain affected-option/source attribution.
- Source refresh's `candidate.diff.added` is a separate accepted-snapshot
  comparison. Its same-name replacement DOM test proves safe added/removed
  address summaries, not processing-stage additions.

This adds preview metadata only: no new operators, saved-version comparison,
changes to pipeline output/identity, credential exposure, persistence or implicit
publication. The catalog status is not advanced by this bounded check.

## Verification

API RED: `TestNoOpProcessingRecipePreservesPublishedContentAndSibling` failed on
missing `addedIds`; GREEN after the additive fields. It also checks explicit
comparison baseline, redaction, unchanged saved recipe/accepted source, complete
selected/sibling publication state and feed bytes.

DOM RED: snapshot-summary count-only assertions failed against the old delta
line. GREEN: `collection-preview-layout.dom.test.tsx` (3 tests), including actual
step metrics, old-response fallback, snapshot tabs and existing keyboard/rail
behavior. A test initially used the wrong existing rename label (`重命名` rather
than `重新命名`); corrected to the established product label.

`go test ./internal/conversion -count=1` passed, including 12 source/aggregate
operator cases in `TestProcessingAdditionsUseStepInputNotSnapshotSummary`, exact
removed/changed IDs, existing no-op/order/provenance and secret-isolation tests.
The targeted API test and web typecheck passed. The four scoped DOM files
`collection-preview-layout`, `pipeline-controls`, `collection-source-task` and
`source-refresh` passed together (36 tests, `--maxWorkers=1`). No native process, Chrome, full
suite, CI or publication was run. Independent review is requested separately.
