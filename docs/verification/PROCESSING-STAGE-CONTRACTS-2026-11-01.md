# E03 processing-stage and no-op publication contracts

Base: `23650ca`. This change adds regression evidence only; production behavior,
publication revision semantics, limits, and validation guards are unchanged.

## Coverage

- `TestProcessingStableSortPreservesEqualKeySourceOrder`: 12 combinations of
  name/region/protocol, ascending/descending, and original/reordered sources.
  Equal-key members retain selected source and endpoint order. Sort is represented
  by stage endpoint order, not falsely reported as content edits or removals.
- `TestProcessingStepOrderAndDisabledStepsAreExplicit`: three source pipelines
  demonstrate rename→keep versus keep→rename, ignored disabled drop/rename,
  ordered active-stage attribution, and unchanged accepted input.
- `TestProcessingStageChangesIdentifyExactContentAndRemoval`: exact stage IDs,
  content changes and removed IDs for matching rename, identity rename,
  connection deduplication and drop. A deduplicated survivor is changed because
  provenance merges; the removed duplicate is separately identified.
- `TestNoOpProcessingRecipePreservesPublishedContentAndSibling`: real HTTP
  invitation, source, collection, profile and two published outputs. A recipe
  with identity rename, equal-protocol stable sort and disabled drop is previewed,
  saved, compared, reviewed and explicitly published. Preview/save do not mutate
  either frozen output; comparison remains unchanged; explicit publication
  creates a fresh publication revision while retaining artifact bytes and feed
  access identity. Both downloaded feeds, the complete sibling publication and
  the accepted source remain unchanged.

The API's existing explanation contract is scoped stage/step identity plus exact
changed/removed member IDs and redacted intermediate endpoints. This evidence
neither adds textual per-field reasons nor treats sorting as a content edit.
Explicit publication is not revision-idempotent; that established contract is
preserved rather than silently changed to satisfy a no-op assertion.

## Local results

Using pinned Go 1.27.3 and the shared resource-bounded toolchain:

- `go test -race ./internal/conversion -count=1`: PASS, 1.067 s (entire package).
- `go test -race ./internal/httpapi -run '^TestNoOpProcessingRecipePreservesPublishedContentAndSibling$' -count=1`:
  PASS, 2.790 s (one named HTTP journey, not the entire HTTP suite).
- Three intentional, temporary contract mutations were each rejected by their
  targeted new test: reversing equal-key order; executing disabled steps;
  suppressing changed member IDs. Production source was restored byte-for-byte,
  then the complete conversion race package passed again.

No Chromium, native engine, remote CI or deployed network was executed for these
new assertions. Browser presentation and release-source CI binding remain the
coordinator's gates. The pinned engineering skill was absent locally and its
official raw fetch returned a cache miss; it was not claimed as loaded.
