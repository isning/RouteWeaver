# Managed route exit change — isolated candidate

Status: coordinator-authorized isolated implementation, **not integrated or deployed**. Source work at 2026-10-23; focused domain/store/HTTP checks passed, UI and final composed verification remain in progress. This does not claim native acceptance, running traffic, production availability, or a general quality benchmark.

## User task and evidence

Change the saved FRA → UK managed route to FRA → another existing UK endpoint without recreating credentials or editing JSON. A strategy-group display label is not a server chain. The server checks the selected route's actual principal actions and matching connector, then changes actual forwarding intent. Client rules, platform grants and immutable subscription Outputs are separate objects and are not rewritten here.

The original friction was source-confirmed: `canEditLegacyPath` correctly rejects managed principals/conditional policies, removing the old legacy endpoint controls; forwarding inspection is read-only. Relaxing that predicate would erase policy. This implementation leaves it unchanged and adds a route-scoped operation in the existing route detail.

## Bounded model operation

`domain.RetargetManagedExit` is a pure intent transformation, without HTTP/store/renderer dependencies. It supports an existing two-hop route with managed ingress, a single proven route-principal forwarding action and no conditional ingress rules. All selected route principals retain their subject/account/route IDs, credentials, credential version, metering PolicyRevision, CycleID and other policy fields. Other principals, programs, connectors, rules and public entry are retained.

Legacy sole egress is explicitly normalized to connector `egress-1`; its implicit default is preserved as an explicit forward action. The old connector and old terminal program remain. A new isolated connector is added (or one unique exactly matching connector reused), and only selected-route principals move to it. Ambiguity, via detours, unsupported conditional structure or changed retained snapshots are refused rather than flattened.

An existing inventory credential-bearing stock VLESS/TCP endpoint need not already have a program: matching endpoint/core/host metadata can produce one direct terminal program using the existing credential. No credential is created. Principal-only transit requires separate principal binding and is unsupported. TLS configuration stays authoritative: explicit paired paths may be saved as configuration-only draft; matching PEM, when supplied, is validated. No generated paths, silent security flag normalization or TLS downgrade occurs. Missing packaged PEM produces an application-readiness blocker, not a false applicability claim. Existing publication verification remains separate.

## Server and persistence boundary

Preview returns an allowlisted summary: saved-draft before/after endpoint identity/address/protocol/security/transport/material category; associated account count (not active users); preservation facts; security-change categories; application readiness; opaque review token. No raw IR, credentials, certificates, private hashes or renderer error text enter this DTO. Wildcard listeners show adopted dial address from Host, not `0.0.0.0`.

Commit recomputes the proposal and atomically writes deployment, published route, deterministic link and actor-bound operation receipt using existing record and membership CAS. It fences discovered route/inventory/ownership/desired/observation/fleet dependencies and active or uncertain application. Normal heartbeat timestamp/evidence refresh alone does not invalidate human review; complete fresh raw observations are nevertheless CAS-protected between safety check and write. Meaningful observation identity/status/native/recovery changes remain review-relevant.

Receipt lookup is authorized and exact-input-bound before stale checks. Concurrent same-operation losers re-read the receipt; same ID with changed input or another actor never replays. A local uncertain save retains the exact request and operation ID in memory for reconciliation, can be dismissed safely, and does not persist TLS inputs in browser storage. Commit returns HTTP200 only with an exact durable outcome: `draft-saved` or `draft-rejected` (allowlisted `EXIT_DRAFT_REJECTED` and safe detail). A typed nonretryable failure claims a rejected receipt using the same absence CAS as success, without draft writes. Thus an original in-flight success cannot later overwrite a rejected outcome, even if external inputs are restored. Unknown storage/auth/transport failures never claim rejection. Only an exact matching terminal receipt resolves UI uncertainty; rejected preserves choice/material, never invokes saved success, and requires explicit fresh review.

Existing deployment/route updates require `If-Match` opaque `revisionToken`; creates compare absence. Published-route saves CAS their loaded deployment and inventory proof, not just the route. UI strips read metadata from mutation bodies. Tokens use purpose-separated HMAC derived from the existing store master primitive; no new auth setup or dependency.

## UI hierarchy and recovery

One route detail, one contextual 更换出口 action, endpoint selection → server review → save draft. Before/after means saved draft, not currently applied. Applied route evidence remains separate. The review displays security changes where the user decides; path-only TLS can be saved knowingly with contextual material entry. Retained unrelated TLS material is not silently repaired by this operation; its existing path setup remains the recovery context.

Cancel before commit writes nothing. Save does not apply server config, publish client Outputs, create grants, or rotate credentials. Applied manifest resolution retains the old frozen path until an independently observed deployment supersedes it. A conflict preserves selection and requests a new review; an uncertain response retains the same operation for retry, not a newly generated mutation.

## Design-method attribution and limits

- Repository `AGENTS.md`, `CONTENT-DESIGN-RULES.md`, and glossary: distinguish viewing/editing/diagnostics, concrete action/state/recovery copy, semantic keyboard controls and visible material consequences.
- Pinned mattpocock/skills `tdd` and `codebase-design` at `49dd158d1076134a641b33efb035946536778336` (official files read): tests at public behavioral seams, a pure intent module and thin adapters, no UI reconstruction of private policy. Initial test source preceded implementation, but the runtime gate prevented an observed initial RED: the first focused run passed. The later durable-rejection gap had an observed HTTP RED (generic409, no terminal receipt), followed by GREEN after the receipt correction.
- Independent source review by a separate agent informed legacy default isolation, immutable applied-manifest references, accounting identity, observation fences, receipt concurrency, summary privacy and TLS evidence-strength decisions. Coordinator resolved path-only TLS as valid draft intent with an explicit application blocker.

Verification must distinguish pure transformation, HTTP/store/CAS, rendered configuration, mocked browser interaction, native validation, applied observation and actual traffic. Synthetic recorded observations prove resolver behavior only; mocked UI APIs prove interaction only. The candidate does not exercise native or deployed traffic. Keep final run outcomes in the accompanying verification record, not product banners.

## Final backend review corrections

The durable-negative outcome is restricted to proven refusal, not merely a sanitized HTTP status. Dependency/read failures preserve their operational error identity through path and ownership adapters; they do not claim a terminal receipt. Public HTTP regressions exercise malformed operational observation and nested manifest records, verify no receipt, restore the exact record and recover the same operation successfully. Missing records and completed domain-proof refusals remain distinct from generic operational errors.

Unknown-field refusal applies to every existing record this operation reconstructs, including an optional existing deterministic Link. Different-deployment routes are first classified by a valid ID/deployment envelope and are not subjected to this operation's strict related-route schema; unclassifiable records fail closed. Full list membership/raw CAS and instance ownership fencing remain unchanged.

Focused backend verification: first pure/store/HTTP run passed; subsequent durable-negative, related-record scope, and operational-error/Link regressions had observed RED then GREEN. The composed selected run also covers the independent recovery-required readiness guard, existing ownership and TLS publication contracts. Browser evidence and remaining limits are recorded separately; no native application or traffic claim follows from these results.
