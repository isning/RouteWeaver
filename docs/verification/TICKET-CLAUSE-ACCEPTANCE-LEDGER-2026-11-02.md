# Finite ticket-clause acceptance ledger — 2026-11-02

**Not production-ready and no ticket is promoted by this ledger.** This reconciles
24 tickets, 98 original literal clauses, all 35 stories and the 82 existing evidence
groups. [Machine-readable selectors, hashes and prerequisites](TICKET-CLAUSE-ACCEPTANCE-LEDGER-2026-11-02.json)
are preserved. Source presence, focused checks, CI jobs, browser cases and actual
rollout are different evidence units.

## What is established, and what is still pending

- **Historical exact-source CI8 passed:** [run 41394102366](https://github.com/isning/RouteWeaver/actions/runs/41394102366),
  remote `ff299f489483fae6a628731609bf0ed5d6e5d96c`, tree
  `2d70ec80c996c9a34587fa124cdb28326e180b82`, equal to local
  `6742d04b7e1c036de8fcc3551d0c49390f562b75`. All 18 jobs succeeded.
  Retained detailed ordinary-browser reports independently reconcile to 201 unique
  cases / 55 files, all passed, zero skips/flakes/retries. The separate one-case
  same-instance browser/native bridge passed; it is not traffic or soak proof.
- **Qualified reference passed on 674:** [14/14 operational selectors and the full
  1,800-second window](FINAL-CAPACITY-REFERENCE-2026-11-02.md), with exact source,
  binary and raw-result bindings. These are synthetic single-flow Linux results,
  not a production capacity/uptime SLA or actual deployment. Managed-runtime
  production is unchanged by the new preview/UI additions; whole-tree equality
  with 674 is not claimed.
- **Current inspected candidate:** `7e3d37e`; the GB billing, explicit rendered
  rename, diagnostic cancellation, clipboard/QR, external native entry-rate and
  processing-stage delta additions are integrated. The old missing-selector
  questions are now mapped below; integrated is not equivalent to final passed.
- **Snapshot at 06:48:05 UTC:** the coordinator reports three failed cases in the
  still-running full web rerun. No terminal result or pass is inferred. CI9 has
  **not run**. New diagnostic 320px and clipboard/QR 1440/390 browser assertions
  remain **UNRUN**, even though older versions of their surrounding tasks passed.
- **NET-03 remains an honest risk:** the original sample-410 read/cleanup failure
  is unclassified. Two later successful windows do not prove its cause or erase
  it. The separately diagnosed operational fixture/custody failures retain their
  own chronology. No arbitrary new soak duration or retry count is introduced.

This pass read source and retained receipts, recomputed hashes and validated the
ledger structure only. It ran no application tests, browser, native process or CI,
and made no API/Page, catalog, merge, deployment or main-branch changes.
This individual ledger reconciliation is not the separate final standards/spec
signoff; no independent review of this ledger itself is claimed.

## Finite software completion queue

1. Resolve the known full-web failures; record terminal final-source types,
   behavior and build results rather than substituting focused passes.
2. Obtain and inspect the authorized exact-final-source CI9 and every required
   terminal gate. The new native-rate selector stays mandatory. No retry/budget
   expansion is authorized by this document.
3. Within those existing gates, inspect actual diagnostic cancellation 320px and
   real clipboard/decoded-QR 1440/390 outcomes. Do not add unexposed import
   integrations or infer new assertions from the old E09 case.
4. Record separate standards/spec final dispositions and bind affected reruns.
   Apply literal clause decisions in the forward prerequisite layers below; only
   then can their feature tickets, stories and finally RW-24 be verified.
5. Keep the original sample-410 evidence visible and obtain an evidence-based
   disposition before calling NET-03 closed. A green aggregate alone is not that
   disposition. This does not prescribe unrelated implementation or a new SLA.

### Existing finite UI remainders

- **Template downstream consequence:** source plus exact CI8 real-backend cases
  `3b092796abcb8e3d0de4-5db2ec97989dcf6439b3` (1440) and
  `3b092796abcb8e3d0de4-8e073660be1ba12bcdd1` (390), each passed/retry0,
  establish stale 409 → fresh review/apply → explicit selected publication with
  sibling feed preservation. This is the bounded downstream cell, not all template
  permutations. The CI8 receipt records settled capture steps; this reconciliation
  did not inspect screenshot pixels and makes no new pixel-quality claim.
- **Server nested decision:** the finite case is now diagnostic cancellation,
  not an unbounded request to test every nested operation. The [four DOM cases](DIAGNOSTIC-CANCEL-CONTEXT-2026-11-02.md)
  distinguish acknowledgement from actual cancellation, failed retry and exact
  target/focus. The new 320px actual-browser case is still UNRUN.

## Forward prerequisite order

Each row can be considered only after earlier prerequisites are accepted. Within
a row, independent tickets may be reviewed together. Every catalog status stays
`in_progress` in this snapshot; an aggregate success never reverse-closes a row.

| Layer | Tickets |
|---|---|
| 1 | RW-01, RW-02 |
| 2 | RW-03, RW-04, RW-15 |
| 3 | RW-05, RW-13, RW-16 |
| 4 | RW-06, RW-14, RW-17, RW-19 |
| 5 | RW-07, RW-18 |
| 6 | RW-08, RW-09 |
| 7 | RW-10 |
| 8 | RW-11 |
| 9 | RW-12, RW-20 |
| 10 | RW-21, RW-22, RW-23 |
| 11 | RW-24 |

## Software release versus actual deployment inputs

The chosen profile remains **one control plane, Linux nodes, private invitations**.
No actual rollout host is known, and the owner is being asked whether the next
finish line is a software-only release candidate or acceptance on real trial
targets. This choice does not block independent software checks.

R01–R03 are separate actual-target inputs: host/node selection and authorized
service enrollment; intended population/history/disk envelope and acceptable
operating/recovery limits; private durable storage/key custody, TLS/public origin,
proxy boundaries, backup/restore location and channel destinations. The six
[existing target acceptance items](RELEASE-GATES.md#single-instance-private-service-acceptance-record)
remain the finite deployment checklist. Local default-origin/sink/recovery tests
neither supply these values nor authorize real changes. Merge and deployment
permission are both absent. Do not mark an unchosen/unauthorized environment as a
software implementation failure, or a software release candidate as a proven
production deployment.

## Literal clause mappings

The clauses below are unchanged from `docs/tickets/catalog.json`. Candidate group
names resolve to exact selectors and current/historical hashes in JSON. A resolved
source mapping is not a ticket pass; all final evidence/prerequisite rules above
still apply. Historical story work IDs are retained only as history, not a queue
of already-completed work to repeat.

### RW-01 — Create and validate direct or multi-hop routes

Stories: F01, F02, K02. Direct prerequisites: none. Catalog: `in_progress`.

1. **A one-endpoint direct route and a path with more than two distinct endpoints round-trip through storage and UI without a hard-coded engine or hop enum.**
   - Candidate groups: `topology`, `ordered-route-browser`, `route-exit-browser`.
2. **Endpoint identity, not display name or VPS identity, governs cycle detection; rename preserves references; invalid draft preserves form values.**
   - Candidate groups: `topology`, `endpoint-impact-ui`.
3. **Protocol/TLS capability errors name the offending endpoint and exact target; shared connection edits preview dependent routes.**
   - Candidate groups: `endpoint-tls`, `endpoint-impact`, `endpoint-impact-browser`.
4. **The architecture negative fixture, API authorization, persistence and graph/form tests pass using the same local and CI harness.**
   - Candidate groups: `render-extension`, `tenant`, `topology`.
   - **Specific mapping reconciled:** Architecture negative-fixture mapping is explicit: scripts/verify.sh static invokes TestGuardRejectsForbiddenImportAtPublicCommandSeam package and production guard; CI8 source-contract job passed. Require current final-source static result alongside existing authorization/persistence/UI evidence.
   - Additional named selectors: `scripts/check-architecture/main_test.go` (JSON).

### RW-02 — Invite and manage local accounts securely

Stories: A01, M03. Direct prerequisites: none. Catalog: `in_progress`.

1. **Invitation claim, sign-in, sign-out and expired/revoked sessions have positive and negative tests; passwords are salted and secrets never returned in normal listings.**
   - Candidate groups: `invite-browser`, `account`, `account-browser`.
2. **Pause/expiry/renewal are separate commands with visible effect and audit records; a normal user cannot perform administrator commands.**
   - Candidate groups: `account`, `cycle-api`, `cycle-browser`.
3. **Administrator second-factor enrollment/verification and recovery behavior have explicit bounded tests and do not bypass authorization.**
   - Candidate groups: `mfa-browser`, `account`.
4. **Tenant ownership is enforced on every read/write/export, with another-user and unauthenticated denial tests.**
   - Candidate groups: `tenant`, `account`.

### RW-03 — Grant services and inspect effective access

Stories: A02, S01. Direct prerequisites: RW-01, RW-02. Catalog: `in_progress`.

1. **Group membership plus an explicit individual override produces a deterministic documented effective grant; multiple groups cannot silently add quota or routes.**
   - Candidate groups: `policy`, `group-precedence`.
2. **The affected-user preview and stored result agree; a revoked or expired grant is rechecked when a subscription is obtained.**
   - Candidate groups: `group-precedence`, `policy-ui`.
3. **Not-started, active, paused and expired services display correctly without inferring runtime deployment.**
   - Candidate groups: `service-ui`, `cycle-browser`.
4. **An invited user sees only their authorized service and public entry connectivity, not transit credentials.**
   - Candidate groups: `tenant`, `published-native`, `service-ui`.

### RW-04 — Import private sources without unsafe fetching

Stories: C101, F04. Direct prerequisites: RW-02. Catalog: `in_progress`.

1. **At least one explicit supported input fixture for each exposed input mode imports successfully and retains source provenance; configuration extraction reports ignored sections.**
   - Candidate groups: `import`, `source-refresh`.
   - Additional named selectors: `internal/httpapi/source_mixed_atomic_test.go` (JSON).
2. **Malformed, partially supported and oversized input has bounded diagnostics; failed refresh leaves the prior accepted snapshot and edited input intact.**
   - Candidate groups: `import`, `source-refresh`.
   - Additional named selectors: `internal/httpapi/source_mixed_atomic_test.go` (JSON).
3. **Private/loopback/link-local destinations, redirects and DNS rebinding protections are tested at the fetcher seam; only an explicit loopback test transport bypass exists in tests.**
   - Candidate groups: `fetch`.
   - Additional named selectors: `internal/httpapi/source_mixed_atomic_test.go` (JSON).
4. **Operator visibility is disclosed at import; logs, ordinary errors and source listings do not expose bearer URLs or credentials; cross-user access is denied.**
   - Candidate groups: `tenant`, `external-feed`.
   - Additional named selectors: `internal/httpapi/source_mixed_atomic_test.go` (JSON).

### RW-05 — Preview ordered source processing stages

Stories: C201, C202, C203. Direct prerequisites: RW-04. Catalog: `in_progress`.

1. **Filter, rename, stable sort, explicit connection-identity deduplication and allowlisted field override each have positive fixtures and precise invalid-step diagnostics.**
   - Candidate groups: `pipeline`, `override`.
   - Additional named selectors: `internal/conversion/pipeline_contract_test.go`, `internal/httpapi/processing_noop_publication_test.go` (JSON).
2. **Disabling or reordering a step changes the preview deterministically; renaming never changes connection identity.**
   - Candidate groups: `pipeline`.
   - Additional named selectors: `internal/conversion/pipeline_contract_test.go`, `internal/httpapi/processing_noop_publication_test.go` (JSON).
3. **Every stage reports added/removed/changed options and reasons while redacting secrets; preview does not persist or publish.**
   - Candidate groups: `pipeline`, `pipeline-api`.
   - **Specific mapping reconciled:** Integrated a3542c5 makes addedIds and comparison explicit: source/aggregate stages compare immediate step input; current operators add zero new IDs; raw/source-result/merged are snapshot summaries, not empty-baseline deltas. Existing operation labels + affected stable IDs/provenance supply bounded reasons. Focused API/conversion/36 DOM passed; full current aggregate and CI9 remain pending.
   - Additional named selectors: `internal/conversion/pipeline_contract_test.go`, `internal/httpapi/processing_noop_publication_test.go` (JSON).
4. **No-op changes do not create a false pending publication; an invalid override cannot change owner or administrator topology.**
   - Candidate groups: `processing-api`, `pipeline-api`.
   - Additional named selectors: `internal/conversion/pipeline_contract_test.go`, `internal/httpapi/processing_noop_publication_test.go` (JSON).

### RW-06 — Compose reusable ordered collections

Stories: C102, C201, C202, C203. Direct prerequisites: RW-05. Catalog: `in_progress`.

1. **Source processing runs before ordered merge and aggregate processing; a golden scenario exercises all three layers.**
   - Candidate groups: `pipeline`, `pipeline-api`.
2. **Collection rename preserves references; delete previews dependents; missing or ambiguous identities produce diagnostics rather than silent substitution.**
   - Candidate groups: `dependencies`, `collection-delete`, `collection-delete-ui`.
3. **Multiple configurations can reuse a collection without sharing ownership or changing one another.**
   - Candidate groups: `pipeline-api`, `tenant`.
4. **Concurrent source update has a frozen snapshot identity; failed candidate preserves the last accepted collection.**
   - Candidate groups: `source-refresh`, `frozen-routing`.

### RW-07 — Save independent full client profiles

Stories: C501, F03. Direct prerequisites: RW-06. Catalog: `in_progress`.

1. **Two profiles with different targets and settings persist independently; copying a template records provenance but future edits remain independent.**
   - Candidate groups: `templates`, `native-overrides`.
2. **Server deployment intent and client profile intent are distinct contracts; client operations cannot create deployments or retrieve transit secrets.**
   - Candidate groups: `ir-isolation`, `tenant`.
3. **Draft and published revision are separate and stale writes fail without losing the submitted draft.**
   - Candidate groups: `frozen-routing`, `native-overrides`.
4. **Default-template values and explicit overrides are visible and deterministic; the profile is not reduced to a node-only list.**
   - Candidate groups: `templates`, `native-overrides`.

### RW-08 — Configure nested client strategy groups

Stories: C301, C302. Direct prerequisites: RW-07. Catalog: `in_progress`.

1. **Valid nesting deeper than two levels works; self-reference, indirect cycles and empty effective membership are rejected with exact group diagnostics.**
   - Candidate groups: `topology`, `dynamic-browser`.
   - Additional named selectors: `internal/httpapi/nested_source_publication_test.go` (JSON).
2. **Manual, URL-test, fallback and load-balance each have positive native-validated output on at least one pinned target, not just an unsupported response.**
   - Candidate groups: `native-client`, `render-extension`.
   - Additional named selectors: `internal/httpapi/nested_source_publication_test.go` (JSON).
3. **Dynamic predicates resolve against the frozen source snapshot and preview member changes after refresh.**
   - Candidate groups: `frozen-routing`, `dynamic-browser`.
   - Additional named selectors: `internal/httpapi/nested_source_publication_test.go` (JSON).
4. **Unsupported target strategy or depth is diagnosed without coercing the group to manual or changing the intended server exit.**
   - Candidate groups: `render-extension`, `native-client`.
   - Additional named selectors: `internal/httpapi/nested_source_publication_test.go` (JSON).

### RW-09 — Edit ordered rules and resource references

Stories: C401, C402. Direct prerequisites: RW-07. Catalog: `in_progress`.

1. **A positive fixture covers ordered matching, a combined predicate and explicit final action; native validation confirms each claimed supported target.**
   - Candidate groups: `native-client`, `overlay-safety`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go` (JSON).
2. **Rule resources support fixed/following versions with digest, provenance and explicit cache/fetch errors; resource failures preserve previous valid publication.**
   - Candidate groups: `rule-bundle`, `rule-native`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go` (JSON).
3. **Target-specific resource formats are respected; SRS is not treated as universally compatible and mandatory semantics are not silently omitted or expanded.**
   - Candidate groups: `rule-native`, `render-extension`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go` (JSON).
4. **Private resource access is owner-scoped at retrieval and does not leak its bearer URL into ordinary previews or logs.**
   - Candidate groups: `rule-bundle`, `fetch`, `tenant`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go` (JSON).

### RW-10 — Manage runtime settings and native overrides

Stories: C502, C503. Direct prerequisites: RW-07, RW-08, RW-09. Catalog: `in_progress`.

1. **DNS, sniffing and TUN each have at least one positive supported-target fixture and a visible structured UI, without changing host OS permissions.**
   - Candidate groups: `native-client`, `native-overlay-parser`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go`, `web/tests/structured-runtime-backend.ui.spec.ts` (JSON).
2. **Overlay precedence and conflicts are deterministic, namespace-scoped and target-bound; unsupported mandatory fields are rejected, not dropped.**
   - Candidate groups: `overlay-safety`, `native-overrides`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go`, `web/tests/structured-runtime-backend.ui.spec.ts` (JSON).
3. **Native edits survive save/reopen/regeneration; malformed advanced input preserves the text and points to the conflicting field.**
   - Candidate groups: `native-overrides`, `native-overlay-parser`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go`, `web/tests/structured-runtime-backend.ui.spec.ts` (JSON).
4. **Portable and target-only fields are distinguished in preview; unknown credentials or cross-tenant references cannot be introduced through overlays.**
   - Candidate groups: `native-overrides`, `tenant`.
   - Additional named selectors: `internal/httpapi/structured_rule_journey_test.go`, `web/tests/structured-runtime-backend.ui.spec.ts` (JSON).

### RW-11 — Render and verify actual client outputs

Stories: C601, F03. Direct prerequisites: RW-08, RW-09, RW-10. Catalog: `in_progress`.

1. **Node-only and complete modes produce structurally different correct outputs, each parsed and validated rather than renamed file extensions.**
   - Candidate groups: `native-nodes`, `native-client`.
2. **Mihomo and sing-box are separately described with exact pinned version, supported/unsupported/unverified capabilities and positive native validator evidence.**
   - Candidate groups: `native-client`, `render-extension`.
3. **Output is deterministic from a frozen manifest, preserves stable output references and includes only necessary user-owned or granted entry credentials.**
   - Candidate groups: `frozen-routing`, `tenant`, `client-delivery`.
4. **No output exports administrator topology, transit credentials, owner/source identifiers or hidden unresolved references; redacted preview is not labeled importable.**
   - Candidate groups: `ir-isolation`, `tenant`, `native-overrides`.

### RW-12 — Publish and rotate multiple subscriptions

Stories: C602. Direct prerequisites: RW-03, RW-11. Catalog: `in_progress`.

1. **Draft edits do not remove access to an existing published revision; failed compilation or compatibility checks retain the previous valid output.**
   - Candidate groups: `frozen-routing`, `native-overrides`.
2. **Rotation invalidates only the selected old link; revoke and grant expiry are checked at every fetch; cross-user listing and retrieval fail.**
   - Candidate groups: `tenant`, `rotation-browser`, `client-delivery`.
3. **Names and collision disambiguation are stable under input reordering and all group/rule references follow a deliberate rename.**
   - Candidate groups: `pipeline-api`, `frozen-routing`.
   - **Specific mapping reconciled:** Integrated 3807de4 supplies exact deliberate endpoint/group rendered-reference test for Mihomo/sing-box; existing named domain tests cover input-order and collision stability. Focused race passes recorded; no missing rename implementation inferred, final CI9 still pending.
   - Additional named selectors: `internal/render/rename_references_test.go`, `internal/domain/profile_test.go` (JSON).
4. **At least copied links and file download work end-to-end; any additional QR/import button only appears when its supported target integration actually works.**
   - Candidate groups: `rotation-browser`, `first-feed-browser`.
   - **Specific mapping reconciled:** Integrated d86f623 adds real clipboard readback and decoding of the actually rendered QR, followed by real fetch and selected rotation denial. Existing download is covered; the new 1440/390 assertions are UNRUN. Do not infer pass from old E09 or invent an unexposed import integration.
   - Additional named selectors: `web/tests/service-center-backend.ui.spec.ts` (JSON).

### RW-13 — Account route usage and reset periods

Stories: F05, S02, A03. Direct prerequisites: RW-03. Catalog: `in_progress`.

1. **A 1 GB whole-route measurement at 2× debits 2 GB once, never once per hop; duplicate/reordered measurements do not double-charge.**
   - Candidate groups: `billing`, `counter`, `published-native`.
   - **Specific mapping reconciled:** Integrated 3024bdb supplies exact decimal 1_000_000_000→2_000_000_000 and binary GiB case, duplicate/conflicting replay and unchanged historical debit. Join the existing whole-route/no-hop-double-charge evidence; synthetic counters are not one GB of transferred traffic. Final CI9 pending.
   - Additional named selectors: `internal/store/billing_test.go` (JSON).
2. **Every debit retains its applicable multiplier/policy and period; provider IN+OUT is separate; late-data attribution and rounding rules are documented and tested.**
   - Candidate groups: `billing`, `counter`, `budget`.
3. **Fixed monthly day, activation calendar-month anniversary, fixed-day interval and no-auto-reset work in UTC+8; missing dates clamp to month-end then recover the original anchor.**
   - Candidate groups: `calendar`, `cycle-api`, `cycle-browser`.
4. **Manual reset keeps the next automatic reset anchor; renewal does not reset usage and unused quota does not roll over; history remains queryable.**
   - Candidate groups: `calendar`, `cycle-api`, `lossless-history`.
5. **Displayed next reset/timezone/countdown matches the persisted policy; no-reset and unconfigured states never fabricate a countdown.**
   - Candidate groups: `cycle-ui`, `cycle-browser`, `service-ui`.

### RW-14 — Enforce online-IP and entry limits

Stories: A04. Direct prerequisites: RW-03, RW-13, RW-15. Catalog: `in_progress`.

1. **The same client IP at multiple public entries counts once; transit VPS IPs and private-airport direct traffic are excluded; freshness/window is explicit.**
   - Candidate groups: `ip-limit`.
2. **An over-limit new IP is rejected; expired/paused/exhausted access stops under a documented bounded lease policy; unknown quota cannot grant unbounded access.**
   - Candidate groups: `ip-limit`, `continuous-native`, `provider-native`.
3. **Rate limit is shared by upload/download and all connections for one user × logical entry, independent across entries; no strict global-rate claim.**
   - Candidate groups: `published-native`, `continuous-native`.
   - **Specific mapping reconciled:** Integrated 2f5fd81 supplies external native simultaneous duplex/multiconnection/independent-entry timing proof; one local PASS and raw receipt are retained. Broker leases are synthetic; existing HTTP conversion tests remain separate. Final managed gate/CI9 pending.
   - Additional named selectors: `internal/agent/managed_entry_rate_native_test.go` (JSON).
4. **At least one pinned executable runtime has positive limit enforcement evidence with latency and existing-connection behavior measured; simulation alone cannot close this ticket.**
   - Candidate groups: `published-native`, `continuous-native`, `operational-recovery`.

### RW-15 — Apply and recover staged local revisions

Stories: F01, K03. Direct prerequisites: RW-01. Catalog: `in_progress`.

1. **Pinned Xray and sing-box configurations are natively validated and applied in an isolated local harness; generated is never reported as applied.**
   - Candidate groups: `fleet-native`, `native-client`.
   - Additional named selectors: `web/tests/publication-native.native.spec.ts` (JSON).
2. **Stale generations, duplicate requests, partial failures, disconnect and restart are exercised; observed active artifact identifies the validated revision.**
   - Candidate groups: `agent-fences`, `fleet-native`, `continuous-native`.
   - Additional named selectors: `web/tests/publication-native.native.spec.ts` (JSON).
3. **Rollback is a new fenced operation with verified result; failure preserves last known valid state and the attempted draft; no implicit exit substitution.**
   - Candidate groups: `fleet-native`, `agent-fences`.
   - Additional named selectors: `web/tests/publication-native.native.spec.ts` (JSON).
4. **The scoped agent cannot run arbitrary shell or access unrelated tenant sources; live VPS enrollment/credentials are not performed by the development harness.**
   - Candidate groups: `tenant`, `agent-fences`.
   - Additional named selectors: `web/tests/publication-native.native.spec.ts` (JSON).

### RW-16 — Operate scoped fleet batches

Stories: K01. Direct prerequisites: RW-15. Catalog: `in_progress`.

1. **A batch names exact targets, core versions and expected disruption before execution; each target outcome and retry attempt is visible.**
   - Candidate groups: `fleet`.
2. **Only declared official release artifacts with integrity checks can be installed in an isolated sandbox; no arbitrary remote-shell endpoint is introduced.**
   - Candidate groups: `upgrade-native`, `fleet-native`.
3. **A failed target does not turn the whole batch green or overwrite successful observations; retries are idempotent and generation-fenced.**
   - Candidate groups: `fleet`, `agent-fences`.
4. **Local tests establish planning and execution contracts; real VPS rollout remains separately authorized and is not required to run ordinary CI.**
   - Candidate groups: `fleet`, `fleet-native`.

### RW-17 — Track provider resources separately

Stories: K04. Direct prerequisites: RW-13, RW-15. Catalog: `in_progress`.

1. **Provider cumulative IN+OUT, bandwidth rate, capacity and user weighted debit have distinct units and ledgers.**
   - Candidate groups: `provider`, `billing`.
2. **Provider cycles and alert/exhaustion thresholds persist with explicit timezone and source; missing samples appear unknown rather than zero.**
   - Candidate groups: `provider`, `provider-policy`, `provider-ui`.
3. **Exhaustion behavior follows explicit policy and does not silently switch the route exit.**
   - Candidate groups: `provider-policy`, `provider-native`, `provider-fence`.
4. **Counter epoch, duplicate sample, cycle boundary and stale-observation fixtures verify resource calculations and their presentation.**
   - Candidate groups: `provider`, `provider-fence`.

### RW-18 — Diagnose connectivity and notify operators

Stories: K05. Direct prerequisites: RW-15, RW-17, RW-19. Catalog: `in_progress`.

1. **Target, direction, timestamp and estimated/actual traffic cost are shown; timeouts and error details point to an actionable failure.**
   - Candidate groups: `diagnostic`.
2. **Diagnostics cannot target arbitrary internal metadata services or silently send traffic beyond the authorized target.**
   - Candidate groups: `diagnostic-safety`.
3. **Monitoring thresholds, audience and deduplication are configurable and tested using local sinks.**
   - Candidate groups: `channels`, `notifications`, `notification-drill`.
4. **No automatic server failover is added; manual alternate route selection names its changed exit and follows the ordinary revision workflow.**
   - Candidate groups: `route-exit-browser`, `fleet`.
   - **Specific mapping reconciled:** Existing real-backend browser explicitly selects Alternative UK, names separate apply and saves only preview/retarget writes; CI8 exact case 493166722ef6d5ae79c0-fccfeefb3559270e1591 passed retry0. Existing retarget HTTP test proves explicit review/revisions/replay and stale 409 while preserving accounting/credentials/default fallback. This is manual draft/revision evidence, not automatic failover or a claim the new exit was applied.
   - Additional named selectors: `internal/httpapi/published_route_retarget_test.go` (JSON).

### RW-19 — Publish announcements and audit reminders

Stories: A05. Direct prerequisites: RW-02, RW-03, RW-13. Catalog: `in_progress`.

1. **Announcements have audience and validity bounds; users see only messages intended for them.**
   - Candidate groups: `notifications`.
   - Additional named selectors: `internal/notifications/acceptance_matrix_test.go` (JSON).
2. **In-app, email and Webhook adapters have bounded local contract tests; explicit configured destinations and permission are required before real external sends.**
   - Candidate groups: `channels`.
   - Additional named selectors: `internal/notifications/acceptance_matrix_test.go` (JSON).
3. **Reminder retries do not duplicate the same threshold/cycle notification; changed audience and expiry are rechecked at delivery.**
   - Candidate groups: `notifications`, `notification-drill`.
   - Additional named selectors: `internal/notifications/acceptance_matrix_test.go` (JSON).
4. **Audit covers actor, object, action and effect but excludes passwords, tokens and full private-source URLs.**
   - Candidate groups: `account`, `tenant`.
   - Additional named selectors: `internal/notifications/acceptance_matrix_test.go` (JSON).

### RW-20 — Reuse versioned templates and presets

Stories: M01. Direct prerequisites: RW-05, RW-09, RW-11. Catalog: `in_progress`.

1. **Independent copies never change when upstream updates; fixed references stay pinned and following references produce a reviewable candidate.**
   - Candidate groups: `templates`, `template-native`.
2. **Personal edits are preserved under documented conflict precedence; failed compatibility checks retain the previous valid output.**
   - Candidate groups: `templates`, `template-browser`.
3. **Shared resources carry provenance and versions but cannot contain owner-private subscription credentials.**
   - Candidate groups: `templates`, `tenant`.
4. **A positive update scenario crosses template/preset selection, candidate preview, native validation and publication without silently changing unrelated profiles.**
   - Candidate groups: `template-browser`, `template-native`.

### RW-21 — Restore encrypted backups safely

Stories: M02. Direct prerequisites: RW-02, RW-12, RW-13, RW-20. Catalog: `in_progress`.

1. **Complete backups contain recovery-required secrets only in authenticated encryption; template sharing remains redacted and ordinary subscriptions retain only needed connection credentials.**
   - Candidate groups: `backup`, `tenant`.
2. **Wrong key, truncated data, tampered ciphertext and unsupported schema are rejected before mutation.**
   - Candidate groups: `backup`, `backup-obligation`.
3. **Restore preserves users, grants, profile revisions, publication links and ledger history; conflict and target overwrite behavior are explicit.**
   - Candidate groups: `backup`, `backup-browser`, `lossless-history`.
4. **Migration/restore fault injection proves a recoverable prior state and reports verified completion; no automatic third-party upload or secret sharing occurs.**
   - Candidate groups: `backup`, `backup-obligation`, `operational-recovery`.

### RW-22 — Configure and maintain the platform

Stories: M04. Direct prerequisites: RW-02, RW-12, RW-19. Catalog: `in_progress`.

1. **Domain changes preview existing-link consequences and require valid explicit values; rejected edits preserve the submitted form and previous effective settings.**
   - Candidate groups: `origin`, `origin-ui`.
   - Additional named selectors: `web/tests/settings-origin-backend.api.spec.ts`, `web/tests/settings-origin-backend.ui.spec.ts` (JSON).
2. **Notification configuration is separate from send permission; secrets are write-only/explicitly revealable under authorization, not ordinary state fields.**
   - Candidate groups: `channels`, `origin-ui`.
   - Additional named selectors: `web/tests/settings-origin-backend.api.spec.ts`, `web/tests/settings-origin-backend.ui.spec.ts` (JSON).
3. **Saved and effective revision are distinct when activation fails; the visible result reflects observed activation rather than a generic success banner.**
   - Candidate groups: `origin`, `origin-ui`.
   - Additional named selectors: `web/tests/settings-origin-backend.api.spec.ts`, `web/tests/settings-origin-backend.ui.spec.ts` (JSON).
4. **Settings maintenance works through authorized API/UI without raw database editing or implicit external domain/TLS changes.**
   - Candidate groups: `origin`, `origin-ui`.
   - Additional named selectors: `web/tests/settings-origin-backend.api.spec.ts`, `web/tests/settings-origin-backend.ui.spec.ts` (JSON).

### RW-23 — Use the complete service subscription center

Stories: S01, S02. Direct prerequisites: RW-12, RW-13. Catalog: `in_progress`.

1. **The main action gets a subscription; service, authorized routes, expiry, actual/weighted usage and next reset are clear without technical IDs dominating the page.**
   - Candidate groups: `service-ui`, `first-feed-browser`, `cycle-browser`.
   - Additional named selectors: `web/tests/service-center-backend.api.spec.ts`, `web/tests/service-center-backend.ui.spec.ts` (JSON).
2. **Loading, empty, expired, paused, offline and failed states are distinguished and preserve retry/navigation behavior.**
   - Candidate groups: `service-ui`, `cycle-ui`.
   - Additional named selectors: `web/tests/service-center-backend.api.spec.ts`, `web/tests/service-center-backend.ui.spec.ts` (JSON).
3. **A full browser journey uses the real local backend, not only intercepted fixtures: login, view own service, get a subscription, rotate and deny old link.**
   - Candidate groups: `first-feed-browser`, `rotation-browser`.
   - Additional named selectors: `web/tests/service-center-backend.api.spec.ts`, `web/tests/service-center-backend.ui.spec.ts` (JSON).
4. **Keyboard-only and narrow mobile layouts complete the main task; no external-provider billing or physical-device identity is inferred.**
   - Candidate groups: `first-feed-browser`, `rotation-browser`.
   - Additional named selectors: `web/tests/service-center-backend.api.spec.ts`, `web/tests/service-center-backend.ui.spec.ts` (JSON).

### RW-24 — Verify complete integration and recovery

Stories: F01, F02, F03, F04, F05, C101, C102, C201, C202, C203, C301, C302, C401, C402, C501, C502, C503, C601, C602, S01, S02, A01, A02, A03, A04, A05, K01, K02, K03, K04, K05, M01, M02, M03, M04. Direct prerequisites: RW-01, RW-02, RW-03, RW-04, RW-05, RW-06, RW-07, RW-08, RW-09, RW-10, RW-11, RW-12, RW-13, RW-14, RW-15, RW-16, RW-17, RW-18, RW-19, RW-20, RW-21, RW-22, RW-23. Catalog: `in_progress`.

1. **Every confirmed story has positive end-to-end evidence, not just a type, document, disabled button or unsupported diagnostic; evidence is attached to its local ticket.**
   - Candidate groups: `ALL_STORIES`.
   - **Specific mapping reconciled:** All 35 stories and 98 clauses retain feature-ticket mappings. Use prerequisite_layers forward only after exact final gates and named residual reviews; RW-24 cannot reverse-close features.
2. **Quick, full and native checks report their exact scope and fail on missing requested prerequisites; architecture checker rejects its intentional forbidden fixture.**
   - Candidate groups: `render-extension`.
3. **Fault cases cover generation fencing/restart, tenant revocation, stale source/template updates, ledger dedup/cycles and backup recovery.**
   - Candidate groups: `agent-fences`, `tenant`, `source-refresh`, `templates`, `counter`, `calendar`, `backup`.
4. **Standards and specification reviews are recorded separately; all blocking findings are resolved and affected final checks rerun.**
   - Candidate groups: `REVIEW_RECEIPTS`.
   - **Specific mapping reconciled:** Finish separate final standards/spec review disposition and affected final reruns. Template downstream scope is bounded by actual CI8 1440/390 real 409→review→apply→selected-publication cases, with sibling feeds unchanged; no new template feature is needed. The server nested-decision cell is the named diagnostic cancellation case: focused DOM passed, 320px browser UNRUN. Preserve historical capacity/cleanup/NET03 uncertainty; no all-dialog claim.
5. **No claim of GitHub publication, native CI execution, real VPS deployment or production readiness is made without corresponding verified evidence.**
   - Candidate groups: `SOURCE_BOUND_RECEIPTS`.

