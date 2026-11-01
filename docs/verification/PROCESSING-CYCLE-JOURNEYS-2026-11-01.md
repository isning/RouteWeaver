# Processing publication and account-cycle joined journeys

Base: `eafb493e79d2f789eca5c95ceb8eeeca5e500f40`. This batch changes tests and evidence only. It closes a local API evidence gap and prepares **five browser cases which are UNRUN until authorized CI**. It does not itself close PRD-04, all C202, F05/A03, or E04 shared endpoint impact.

## Public seams and finite cases

All new tests use `isolated-control-plane-fixture`: a fresh normal CLI, built UI, synthetic key/database and actual invitation acceptance, with per-test cleanup. No database manipulation, fulfilled HTTP response, admin-token shortcut, persisted authentication state, external proxy connection or local browser launch is used.

### C202 processing editor to selected publication

- `web/tests/processing-publication-backend.ui.spec.ts`: ordinary invited owner opens a seeded collection, authors source region/port override and aggregate deduplication/port override through the real editor, compares returned stages/provenance, saves and reopens the exact recipe, cancels an update review, then explicitly publishes only the selected output.
- Two independently published outputs start from the same profile. Preview and draft save must leave both feeds unchanged. The selected published result contains exactly one proxy at the final overridden port; sibling bytes and owner-revealed original source (including content and endpoint snapshot) remain unchanged.
- `web/tests/processing-publication-backend.api.spec.ts` exercises the corresponding real HTTP contract, including a rejected port 65536 preview that must leave accepted recipe, source and both feeds intact.
- The UI exposes region and port overrides; this is not a claim that every backend allowlisted override has an editor. Semantic rendering is not native-client execution.

### F05/A03 four account cycles, renewal and reset

- `web/tests/cycle-renewal-backend.ui.spec.ts` has one joined case each for monthly day31, anniversary day15, seven-day interval, and no automatic reset, all in UTC+8.
- Administrator selects the cycle using the actual account authorization editor and explicitly reviews/applies. A public administrative usage submission then records synthetic raw100/provider120 bytes at a pinned 1.5x rate:150 weighted bytes.
- Expiry-only renewal uses the real date/time picker and must retain150 weighted bytes, cycle anchor and next reset. Reset cancellation must retain usage; explicit reset must clear current usage while preserving the anchor/next reset.
- Exact old-meter retry still succeeds, but a changed retry is rejected after reset. This specifically checks retained historical deduplication identity, not a complete historical-ledger export proof. The reset remains visible in administrator audit.
- A new ordinary-user login and full page reload verifies the recipient's real service view and UTC+8 countdown/no-reset presentation. No claim of actual metered network traffic is made; the independent native accounting gates cover traffic.
- `web/tests/cycle-renewal-backend.api.spec.ts` provides four real HTTP counterparts, checking window boundaries, exact weighted usage and renewal/reset invariants.

## Verification

- **5/5 new API cases passed** on the isolated normal CLI (7.3s final runner elapsed).
- New test/helper strict TypeScript check passed with the installed compiler's `--ignoreConfig --noEmit --strict` mode.
- Five new browser cases are discoverable, but **native browser execution remains UNRUN**. No screenshot/pixel/geometry or native client claim is made.
- Initial test-authoring failures used an incorrect preview request shape and confused the entitlement-only response with a full overview. Fixtures were corrected to existing public contracts; no product guard, assertion requirement or timeout was relaxed.
- Independent source review tightened full owner-revealed source comparison, exact month-end checking and the meter-replay/audit scope. Its initial API rerun passed 5/5; the final strengthened composition then passed the author run above. No remaining source blocker was reported.
- No production code changed. No full-suite, remote CI, publication or deployment was performed by this workstream.

Reproduction uses normal `npm --prefix web run test:api` and `test:browser` selection for the two new spec families. A local temporary config with `webServer: []` was used for the focused API run so unrelated canonical port8080 was never started; the per-test fixture still builds and launches its own normal control plane.

## Remaining boundary

Shared-endpoint edit impact E04 was a separate implementation gap at this report's base. It is now implemented and locally tested in the composed candidate; see [ENDPOINT-IMPACT-REVIEW-2026-11-01.md](ENDPOINT-IMPACT-REVIEW-2026-11-01.md). Its new browser case and full integration remain pending. This processing/cycle batch does not take credit for that separate implementation.
