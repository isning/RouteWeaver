# Shared endpoint edit-impact acceptance — 2026-11-01

Scope: F02/K02 endpoint inventory editing; no deployment, exit switching or live-node operation.

## Contract and dependency boundary

Existing endpoint edits first obtain an administrator-only impact preview from `POST /api/managed-endpoints/{id}/impact`. The request carries the opened endpoint `revisionToken` in `If-Match` and the exact proposed endpoint body without view metadata. The response names changed categories, the proposed non-secret target, dependent server deployments, published routes and links. It never echoes credentials, TLS private material or transport headers.

References are identity-based: server-program listener IDs; link endpoints; published route endpoint IDs, path entry/exit and selected links; and published routes attached to an affected deployment. Frozen historical publication/retarget receipts are not live inventory references. Copied connector/egress `Connection` values have no endpoint-reference field; coincidental host/credential equality is not inferred as identity. Dependent route discovery includes the deployment relation, not just a direct endpoint-array match. Unknown persisted dependency shapes refuse review instead of pretending the list is complete.

`PUT` requires both the opened revision and `X-Endpoint-Impact`. A keyed store review token binds the entire proposed record, the exact endpoint/core input and dependency-set membership/values. The final `CompareSetsAndPutRecords` transaction checks them again. An intervening dependent addition/edit, endpoint change or changed submitted draft requires fresh review. Tokens are not authorization. `POST` only creates an absent ID, so it cannot overwrite an existing record to bypass review.

Saving modifies only endpoint inventory. Existing deployment snapshots, published routes, runtime desired state and client exports are not rewritten. The confirmation states that dependent configurations must separately be updated, validated and explicitly published.

## UI and metadata

The editor preserves inputs on preview failure, cancellation and failed save. Repeated cancellation restores the exact Save control. A failed save is not blindly replayed: the next Save fetches a fresh impact review. Preview and actual write pending states prevent concurrent submission; nested confirmation does not remove its captured header Close control.

Endpoint revision metadata is stripped at `compilePath`, deployment normalization and explicit listener-refresh conversion. It must not be copied into strict server renderer IR. This has separate failure-before-fix tests; server JSON validation was not loosened.

## Evidence and limits

- HTTP failure-before-implementation: `TestEndpointImpactReviewBindsDraftAndDependencies` returned 404 for the preview route.
- The real HTTP case covers named dependency impact, secret suppression, missing review, altered draft including secret-only changes, new and modified dependents, stale opened revisions, duplicate-POST bypass refusal, tenant/anonymous denial and unchanged deployment listener after inventory save. Unknown future dependency fields fail closed.
- `endpoint-impact.dom.test.tsx`: actual component with synthetic HTTP; failed read, retained draft, twice-canceled review (button and Escape), safe-default focus and exact return focus, no unintended write, dependency-conflict recovery and exact reviewed payload/header ownership.
- Four existing successful endpoint-editor cases now perform the explicit confirmation. Other creation behavior is unchanged.
- `infrastructure-model.test.ts` and `server-listener-refresh.test.ts`: review metadata does not enter renderer intent, while original inventory records and connection values remain intact.
- `endpoint-impact.ui.spec.ts`: one 320px actual-App layout/focus candidate with controlled synthetic HTTP, source typechecked/discovered but **UNRUN locally**. It does not claim real backend or native runtime evidence. Root-authorized CI must execute it.

Pinned TDD/codebase-design reference skills were read from their official pinned source after local copies were absent. Existing project seams (HTTP authorization/record comparisons and UI user tasks) were retained. No CI, push or production operation was performed by this workstream.

Final local verification: 77/77 tests across seven related DOM/model files passed with one worker; web typecheck passed; the static gate (51 helper tests, architecture and actionlint) passed. The named endpoint/redaction/inventory HTTP cases passed under race. One new browser case passed strict source typechecking and discovery only. Full backend/browser/integrated release gates remain the coordinator's separate validation.

Independent source review caught legacy fleet/service/TLS fixture edits that still used POST overwrite. Seven explicit edit sites now use the real opened-revision → impact preview → reviewed PUT flow; initial creates and duplicate-POST refusal remain unchanged. The named fleet rollback, service, server-publication and endpoint-impact regressions passed under race after migration. No native test process was launched.

## CI3 fixture correction

Run 41348313792 (remote aaabe51, local composition b397f89) reached the real
endpoint editor but not the review. The shard-3 error context showed required
SOCKS username/password errors; the browser fixture omitted both. No endpoint
screenshot had been reached. This was invalid synthetic inventory, not a missing
dependency in the review response.

The DOM/browser journeys now share one authenticated, loopback-only synthetic
connection. Reusing the former unauthenticated connection made both DOM journeys
fail before review; adding the required synthetic credentials restored both.
Both request stubs check the exact connection. The browser preview fixture now
returns only the real API's non-secret target/identity fields, and the test also
asserts that the review does not expose its synthetic password. Existing narrow
geometry, dependency visibility, repeated cancellation and exact-focus assertions
and timeouts are unchanged. Web and standalone browser-source typechecks pass.
The corrected browser case still requires coordinator CI execution; no local
browser, native runtime, CI or push was performed for this correction.

## CI4 asynchronous opener focus correction

Run 41351035317 (remote 81dd620, local e58b54a) reached the complete 320px impact
review. Its screenshot shows the named dependencies and both decision actions;
the failure is the unchanged exact Save-focus assertion after Escape. No trace
was recorded by this controlled case. The source disabled native Save while the
impact request was pending, before the asynchronous confirmation captured its
opener. Unlike a browser, jsdom does not automatically blur a disabled button;
the immediate DOM fixture therefore did not exercise that eligibility gap.

The inventory Save action now uses the existing `keepFocusableWhilePending`
option **only while reading impact**. It remains aria-disabled/busy; the existing
ActionButton click suppression and form pending/owner guards remain intact.
Actual save mutation still disables the native button. No global focus manager,
confirmation lifecycle, timeout or browser assertion was changed.

A deferred HTTP DOM regression fails before the change (`Save.disabled` was
true), then proves focus eligibility, suppression of repeated click/Enter
submissions, one preview/no write, retained draft and exact Save focus after
Escape. The two existing impact tests remain. Corrected real-browser focus must
still be verified by coordinator CI; no local browser/CI/push was run.
