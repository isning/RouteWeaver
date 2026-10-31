# Nodes-only selected-output review — isolated candidate

Evidence paths below are relative to the separately retained `nodes-only-review-candidate-20261023/` evidence directory, not this document’s installation directory. Baseline evidence is its sibling `nodes-only-review-baseline-20261023/`. These portable evidence directory names do not identify a user or machine.

Status: targeted GREEN; awaiting parent integration decision. Canonical untouched. Runtime stopped and QA lock released 2026-10-23 22:06:53 UTC.

## Decision evidence
The earlier frozen baseline (`../nodes-only-review-baseline-20261023/REVIEW.md`) proved that addition, removal and same-ID connection change all produced generic review text. Technical detail was candidate-only, not a before/after comparison. Existing artifact comparison correctly said changed.

This candidate makes the same direct-device-list journey recognizable before opening technical detail: added Gamma, removed Beta, or modified Alpha / connection settings changed. Five independent actual Chromium Mihomo fixtures passed (sing-box coverage is public renderer/HTTP tests, not this browser run): addition, removal, credential+transport, credential-only, transport-only. Captures at 1440px and 390px retain target identity, consequences and confirm/cancel together, without horizontal clipping. Agent and independent reviewer visually inspected representative captures. Evidence: `browser-green/evidence/facts.json`, review PNGs and text, browser.log, requests-safe.json.

Setup disclosure: normal UI login; source/profile/two initial publications per scenario created through owner API. Subsequent source editing/acceptance, leaving source context/reloading, direct device-row review, cancel and explicit selected update used actual UI. No external fetch, native apply or real credentials. Masked technical/textarea/link captures; synthetic test values only. IDs retained privately in facts to establish provenance, not displayed in new DTO.

All five cases: artifact comparison changed before publish; cancel preserved both frozen outputs; selected publish changed its artifact/revision while preserving its link; sibling remained unchanged; selected comparison then unchanged. This proves local publication behavior, not client application.

## Minimal model and contract
No persistent evidence or schema. Adapter-owned inspector reads exact frozen JSON artifacts and stable-ID/name allocations on each side. This verified inverse allocation join is not heuristic source-name matching. Both sides use the same strict exact target/version/nodes-only inspection; current draft never reconstructs old data. Complete parsed settings exclude only emitted name/tag; rename and settings change are separate flags on one affected node. Relative survivor ordering is separate. Existing artifact equality/digest/CAS remain authoritative and unchanged.

Selected owner preview only adds `nodeChanges` v1. Available totals cover complete input; rows show first 50 with exact omitted count. Rows contain safe labels and category flags, no IDs, hashes or raw settings. Unavailable has no zero counts. Missing/partial/unknown frontend DTO is fail-closed. Existing full routing review and platformEntryRefresh.count v1 semantics remain unchanged; managed-input refresh is an independent fact, not a count added to exported-node totals.

Known-secret strings from BOTH emitted sides feed the existing label sanitizer; names resembling URLs are treated under its existing policy. This is not a promise of universal secret detection. Label output is bounded. Inspector projection fields are unexported, JSON-safe; no ClientResult field added. Ordinary output/status/access/comparison/feed views have no added node evidence.

## Bounds and compatibility
Optional inspection limits per side: 10,000 nodes, existing 24MiB artifact ceiling, depth16, 32 keys/object and 1,000,000 parsed values checked before recursive allocation. Strict duplicate-key/type/number/unknown-field checks and complete allocation/object coverage fail unavailable. Legacy missing metadata, unsupported exact versions/modes, native/opaque or incomplete artifacts are unavailable, not unchanged. These are comparison bounds, not publication limits. Public HTTP test created and republished a valid 10,001-node output while comparison was unavailable. No publication capacity reduction or stale persistent metadata introduced.

## Changed files
Exact manifest: `evidence/changed-files.txt` and `.sha256`; seven production files, four test files. No changes beyond whitelist.

Production: `internal/render/client_nodes_inspection.go`; `internal/httpapi/output_node_changes.go`, `output_review.go`, `tenant.go`; `web/src/NodeChanges.tsx`, `Subscriptions.tsx`, `types.ts`.

Tests: corresponding inspector/HTTP tests plus `web/src/node-changes.dom.test.tsx` and `output-review-consequence.dom.test.tsx`.

## Validation and red-before-green
- Public HTTP missing field RED -> GREEN (`http-red.log`, `http-green-first.log`).
- Public DOM missing region RED -> GREEN (`dom-red.log`, `dom-green-first.log`).
- Aggregate parse-budget RED -> GREEN (`budget-red.log`, `budget-http-green.log`).
- Malformed DTO RED -> guard GREEN; exact row-kind array/object coercion RED -> fix GREEN (`dto-red.log`, `dto-coercion-red.log`, `dom-green-final.log`). Final focused DOM: 50/50.
- Final TypeScript typecheck clean (`typecheck-final.log`). Earlier test-mock callback typing failure preserved in `typecheck.log`.
- Final affected Go public regression filter `Test(Nodes|Client|Output|PublishedRouting)` passed both render and HTTP (`affected-go-final.log`). Includes actual two-renderer protocol shapes, empty valid optional strings, canonicalization, rename+settings once, ordering, privacy, 50-row cap, owner isolation, legacy unavailable and 10,001-node publishability. This is not a whole-repository suite claim.
- Five actual built-browser scenarios GREEN (`evidence/browser-run.log`, `browser-green/evidence/browser.log`).
- Source and built assets unchanged after runtime: `evidence/source-post-browser-check.log`, `build-post-browser-check.log`; freeze manifests in `browser-green/`.

## Measured cost, not a universal latency claim
Matched baseline and candidate used identical prepared 10,000-node SOCKS artifacts (1,850,022 bytes; hashes logged). Owner preview measurement includes normal existing preview work:

| Scenario | Baseline time / TotalAlloc | Candidate time / TotalAlloc |
|---|---|---|
| 10K unchanged | 740.46ms / 336,501,312B | 1,438.62ms / 647,195,304B |
| 10K credentials changed | 602.75ms / 349,446,432B | 1,199.45ms / 651,435,280B |
| 2 nodes changed | 1.212ms / 109,152B | 1.306ms / 122,632B |

Whole test-process max RSS was 377,844KiB baseline vs 418,140KiB candidate. This includes import, setup, source acceptance, unchanged/changed and small-case previews; it is NOT isolated preview peak. TotalAlloc is allocation volume, not peak. Changed10K node DTO was 3,405 bytes: 50 rows and 9,950 omitted, exact counts. Parent approved retaining the narrow temporary secret-carrier bridge; no speculative sanitizer refactor. `/usr/bin/time` was absent; preserved failed attempt and recovered using Python child-process resource accounting. Evidence: performance-{baseline,candidate}.log, corresponding -time.log, performance-run-changed.log. Normal10K fixture does not establish all-protocol aggregate limits or a latency SLA.

## Remaining scope
No integration/deploy/archive performed. Full-mode/native comparison unchanged. Optional oversized/unusual input can legitimately report unavailable. No claim that candidate-only technical details became a structural diff, or that published changes were applied by a client. Parent owns final aggregate verification and integration decision.
