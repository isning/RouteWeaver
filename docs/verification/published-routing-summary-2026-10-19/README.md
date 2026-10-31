# Published routing intent summary

Base: `c2725ef` (review-bound initial publication). This slice changes no live deployment, credentials, authentication, or external services.

## Interface and scope

- `Output.routingSummary` is server-owned, versioned, and captured by `prepareOutput` after successful rendering and before the existing exact-input digest. Display names come from the renderer's allocated names and are sanitized without truncating collision suffixes.
- Only the exact bounded basic ChatGPT/default routing shape gets endpoint labels. Advanced, native-override, and nodes-only outputs get explicit categories, not inferred routes. Older publications without this metadata remain unavailable; the current profile never backfills their history.
- Existing output previews carry frozen `publishedRoutingSummary` and candidate `routingSummary`. New-output previews carry only the candidate. The existing creation receipt and publication CAS remain authoritative.
- `GET /api/me/outputs/{id}/status` prepares only the selected output's saved candidate, returning ordinary output metadata and `draftComparison.state`: `unchanged`, `changed`, or `unavailable`. Normal output listing remains a cheap frozen-metadata read.
- Comparison checks actual artifact content, frozen file paths/bytes, and sanitized summary, not timestamps, review digests, or redacted previews. It is a read-time comparison, not a persistent client status. Invalid candidates preserve frozen publication metadata and do not block separately eligible frozen delivery.
- Home shows published intent separately from saved edits. Basic and advanced update review display old-to-new snapshot summaries; missing summaries are not inferred from form state. Summary viewing never requests bearer access or profile reveal.

These labels describe the published configuration, not live traffic or a client's runtime manual selection. No general native-config reverse parser or new compiler was added.

## Verification

- Red-before-green HTTP evidence: the first lifecycle regression failed because publication returned no routing summary. Allocated-name regressions separately failed for normalized and duplicate long labels before the naming correction.
- Seven new top-level HTTP tests cover frozen publication, secret-only differences, invalid saved candidates with unchanged eligible feed access, opaque modes, label sanitization, legacy records, tenant isolation, forged summary rejection, resource bytes, source renames, allocated collision names, and normalization-equivalent edits.
- `scripts/go.sh test ./internal/httpapi -run 'TestPublishedRoutingSummary|TestOutputReview|TestReviewedOutputCreation' -count=1` passes, retaining existing reviewed creation/update regressions.
- The same focused HTTP command with `-race` passes (29.564 seconds). `scripts/go.sh build ./...` passes.
- `scripts/verify.sh static`, `scripts/format.sh --check`, and `scripts/go.sh vet ./internal/httpapi` pass.
- `npm --prefix web run typecheck` passes.
- `npm --prefix web run test` passes: 121 tests in 16 files. Includes selected-output status, no summary-triggered access/reveal, frozen versus candidate labels, advanced/legacy/missing summary, unavailable comparison, and saved-edit navigation.
- `npm --prefix web run build` passes. Existing jsdom canvas limitations and production chunk-size warnings remain.

No browser/pixel, native-runtime traffic, deployed-state, or full backup-suite verification is claimed. This is HTTP/DOM/build evidence for the bounded summary slice.

## Independent-review correction

Independent review reproduced a known-credential label leak through renderer normalization (`secret,password` becoming `secret，password`) and allocator whitespace trimming. The follow-on correction includes raw, adapter-normalized, trimmed, and normalized-plus-trimmed credential variants in the existing longest-first label redactor. It uses the existing adapter transform, not a second compiler or new registry interface. Safe allocated collision suffixes are retained.

The new HTTP regression failed before this fix and passes for Mihomo and sing-box, including embedded credential strings and duplicate allocated labels. Ordinary publication metadata, list, and selected-output status are checked. The complete focused HTTP publication/summary subset passes again; no frontend code changed in this correction. The independent reviewer reported no additional concrete blocker in the bounded wiring/CAS/auth/UI review.

Boundary: this correction sanitizes the new frozen routing-summary labels in publication metadata, normal output listing, and selected-output status (and those summary fields in review responses). Existing explicit preview `names` maps remain unchanged: they return renderer labels and can include a known credential deliberately copied into a node name, including a normalized form. This slice does not claim that every pre-existing preview label is sanitized and does not change artifact parsing/redaction. Wider explicit-preview label handling requires separate assessment. The final focused race rerun passed in 35.702 seconds.
