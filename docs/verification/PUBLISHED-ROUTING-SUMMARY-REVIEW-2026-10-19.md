# Independent published routing summary review

Reviewed `85321e0799fa32f55d41c028da133204f4bd1d6e`, base `c2725effac0d0ac58f3321ee64f3e615ff8a2c3f`, in detached `/workspace/shared/routeweaver-published-summary-review`. Read AGENTS and pinned code-review guidance. This bounded review covers the new HTTP summary/status path, immutable preview/publication wiring and routing-summary UI, not deployment or full Store/backup verification. No production edits.

## Standards

No separate architecture or UI-task blocker found. The change uses the existing preparation/CAS path, allowlisted metadata, shared presentation components, selected-output querying and contextual advanced/legacy descriptions. It does not add a native-config reverse parser, mutable draft backfill or a publication bypass. Review performed independently by one reviewer, without additional parallel reviewer workers.

## Spec/security finding: normalized credential redaction

**Must fix before integration:** `internal/httpapi/output_routing_summary.go:86` redacts original credential strings from already renderer-normalized names. Mihomo replaces commas with fullwidth commas, so a name equal to password `secret,password` becomes `secret，password` and bypasses the raw-secret redactor. Name allocation also trims surrounding whitespace: a password/name ` secret-password ` is exposed as `secret-password`. Both transformations are independently reproduced. An independent public HTTP regression reproduces the credential-derived label in ordinary `GET /api/me/outputs` metadata (both summary rows). This newly exposes sensitive material outside the explicit connection/access view. Redact raw and renderer-normalized known-secret forms while preserving ordinary allocated names and collision suffixes.

Failing test: `/workspace/shared/routeweaver-published-summary-review/internal/httpapi/reviewer_routing_secret_test.go`, `TestReviewerRoutingNormalizedCredentialLabel`. `scripts/go.sh test ./internal/httpapi -run TestReviewerRoutingNormalizedCredentialLabel -count=1`: FAIL, 0.165s for both comma and trimming subcases. Root and implementation owner notified immediately; immutable correction requested.

## Confirmed boundaries and executed checks

- Summary is computed after successful materialization/rendering from allocated names and included before exact input digest. New-output request type rejects forged summary fields. Existing preview supplies frozen old summary and separately prepared candidate.
- Ordinary list/status views omit artifact contents, connection credentials and bearer links. Selected status loads tenant-scoped output only and compares exact unredacted artifact content plus resource path/bytes and summary. Invalid candidate preparation returns unavailable while retaining published snapshot. Legacy metadata is not backfilled.
- Existing creation/update CAS and stale-review digest checks remain authoritative and unchanged. The new status comparison does not publish or authorize a later stale write.
- Basic recognition checks explicit routing groups/rules; advanced/native/nodes-only categories do not infer endpoints. Frontend displays server summaries, not mutable form labels, and query key scopes status to selected output. Advanced editing falls through the existing guarded full-editor route.
- Focused existing/new HTTP regressions: `scripts/go.sh test ./internal/httpapi -run 'TestPublishedRoutingSummary|TestOutputReview|TestReviewedOutputCreation' -count=1`: PASS, 2.304s.
- Bounded frontend regressions: `npm --prefix web run test -- src/published-routing.dom.test.tsx src/basic-routing.dom.test.tsx`: PASS, 27 tests / 2 files, 7.99s. Existing jsdom canvas warnings are not browser evidence.

No browser/pixel, native runtime, external deployment, full Store/backup, or aggregate release acceptance is claimed. Verdict for the reviewed snapshot: one blocking redaction finding; otherwise bounded review is satisfactory.

## Immutable correction verified

Rechecked follow-on `77c855236ad61c3e12d21f1775bb448623a214a3` atop the original reviewed commit. The correction redacts original known credentials plus allocation-trimmed and Mihomo-normalized variants through the existing longest-first redactor; it preserves allocated collision suffixes. No frontend production files changed.

The original independent comma/whitespace reproducer was run **unchanged**, SHA-256 `d00cc6efdbb60de425700d33c4605bd014bff02d299dd1139fdfdfa1e5206743`. `scripts/go.sh test ./internal/httpapi -run 'TestReviewerRoutingNormalizedCredentialLabel|TestPublishedRoutingSummary|TestOutputReview|TestReviewedOutputCreation' -count=1`: PASS, 3.142s. This includes the owner's expanded both-adapter, trimmed/normalized/embedded credential-label tests, suffix checks, list/status assertions and existing stale-review regressions.

**Final bounded verdict:** the reported ordinary routing-summary metadata blocker is resolved; no additional blocking finding in the reviewed scope. Prior 27-test frontend result applies because the correction did not change frontend code. No full-project release acceptance is implied.

Adjacent boundary, explicitly not fixed or expanded here: `writeProfilePreview` still returns existing `result.Names` verbatim in its `names` field. User-supplied credential-like endpoint labels can therefore remain visible in that older explicit preview response even though the new `routingSummary` is sanitized. The finding and correction concern newly exposed ordinary summary/list/status metadata, not a global preview-redaction guarantee. No comprehensive preview-redaction overhaul was attempted or claimed.
