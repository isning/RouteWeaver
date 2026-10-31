# Independent bounded ownership review

Reviewed immutable production checkpoint 465cfa1a30f0b580064687b1a3e47980e4354e21 against 10d0ab4, then verified the isolated store follow-up from 466f8039cfe9b5cf56038dc1dcec7071ea847d15. Standards and Spec axes were independently reviewed. AGENTS.md, pinned code-review reference and the bounded guard section of SERVER-CORE-ENDPOINT-MODEL-2026-10-20.md were read.

## Standards / transaction contract

One P2 latent API finding at 465cfa1, resolved by 466f803: generation_records.go passed the internal allocated-generations map to the callback and persisted counters from that same mutable map. A callback could modify/delete entries and make committed counters differ from generated records. Existing HTTP callers did not mutate the map. The regression TestComparedGenerationsCallbackCannotChangeAllocatedCounters failed on 465cfa1 with map[entry:100 unrequested:50] instead of map[entry:1 exit:1]. The follow-up maps.Clone change passed this and the selected generation tests. No documented architectural violation found. Optional maintainability heuristic only: parallel maps/lists for direct prepared targets could be a small target struct; not a release blocker or requested redesign.

## Spec / security

No additional concrete finding. Same-owner direct updates remain allowed; foreign direct/Fleet activation is rejected. Desired/observed/last-known-valid manifest identity is checked exactly and fenced. Missing/contradictory history fails closed. Explicit initial unconfigured provenance is distinguished from legacy install/stop. Install and stop do not transfer/release durable ownership. Direct publication commits the whole requested target set atomically; Fleet prechecks the complete target set and fences each queue transaction, without claiming distributed atomic runtime activation. Supported configure/start/upgrade/rollback reach the guard. Unknown actions, including unsupported restart, remain rejected rather than gaining accidental support. Existing auth, enrollment, lease and native runtime gates were not relaxed in this diff.

## Executed evidence

All commands used GOMEMLIMIT=512MiB and Go -p 1 in detached worktree routeweaver-review-ownership-465cfa1. No main production edits or browser actions.

- review-ownership-465cfa1.log: owner's 466f803 regression test files copied onto pinned 465cfa1 source. Selected ownership HTTP suite passed; store failed only the reproduced map-mutation regression.
- review-ownership-466f803.log: same detached tree plus only 466f803 generation_records.go. Selected store generation and HTTP Fleet/ownership suites passed. The fleet package reported no matching tests and is not counted as tested.
- review-ownership-independent-probes.log: additional independent public HTTP probes passed: unknown/transfer/release/restart rejection, missing last-known-valid manifest, foreign last-known-valid manifest, and present empty owner record. Rejected activations preserved desired generation.
- Independent probe source: routeweaver-review-ownership-465cfa1/internal/httpapi/ownership_independent_review_test.go.

Scope limits: no full test suite, broad native process suite, browser UI, real VPS, production deployment, or claim of formal race proof. Owner tests exercise concurrent first claims and rollback of generated records/counters; the independent reviewer reran those selected tests. Store failure and passing follow-up logs are retained separately.

## Final delta review: 2f2c1fe38ee6463ed661b61f3e9fa316211b9be3

Independently read the complete delta from 466f803 to final 2f2c1fe. No unresolved finding. An unproven fresh claim now checks the allocated generation inside the same transaction: only generation 1 may establish fresh ownership/unconfigured provenance. Proven owners and previously explicit unconfigured provenance remain usable. A later nonactivating install/stop with unknown history does not write an owner record, so it cannot manufacture provenance that authorizes a subsequent activation. Fleet callback changes to attempts are only local until commit and are rolled back on the ownership error.

Independently reran affected public regressions on the final production files in the detached review worktree. All passed: missing accepted records with retained generation counter; first nonactivating install and preservation of configured ownership; legacy unknown install with usable stop; install then stop cannot launder missing history; prior independent missing/foreign LastKnownValid, empty owner and unknown-action probes. Log: review-ownership-2f2c1fe.log (HTTP 0.294s).

Added and ran an independent Fleet activation probe for the retained-counter/missing-owner-and-desired case. Preview/create remain possible, but execute returns 409; no owner or extra manifest is created and no queued attempt is persisted. Log: review-ownership-2f2c1fe-fleet.log (0.036s). Probe source is appended to ownership_independent_review_test.go in the detached worktree. No full suite or extra native/UI work. This final review supersedes the earlier review's checkpoint limitation; final delta is cleared within this bounded scope.
