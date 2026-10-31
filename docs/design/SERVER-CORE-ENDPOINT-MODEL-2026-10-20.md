# Server, core and endpoint model

Date: 2026-10-20
Status: proposal only; not implemented. Read-only source review, with this design note as the only deliverable. Source line references describe the reviewed baseline and may move.

## Product decision

Users select a server, then an endpoint on that server. A core is the implementation that serves endpoints, not another compulsory route-selection step. A server may run sing-box and Xray together. Ordinarily reuse the appropriate existing core rather than encouraging users to create redundant copies.

Keep host ID, runtime instance ID, adapter ID and endpoint ID distinct internally. A runtime instance remains the configuration, process, upgrade, rollback and failure boundary. Do not impose same-family uniqueness now: current semantics do not support the desired one-core/many-active-endpoints model. Existing duplicates can represent intentional isolation, different versions, or the present one-listener limitation. Never silently merge them.

Stock Xray and managed Xray are not interchangeable implementations. Managed Xray has verified admission/accounting capabilities and narrower transport support. Existing tests use managed ingress and stock transit on one host (`internal/httpapi/published_routes_test.go:40–54`; `internal/render/principals.go:21–49`). A family label must not erase adapter capability identity.

## What is true today

- Inventory has host → instance → endpoint references (`internal/domain/topology.go:5–25`). Inventory can contain multiple endpoints per instance, but that does not establish simultaneous runtime support.
- `ServerProgram` has one `Listener` (`internal/domain/topology.go:91–100`). `compilePath` rejects two selected endpoints on one instance (`web/src/infrastructure-model.ts:14–19`). The renderer rejects repeated instance IDs within an IR and writes one config per instance (`internal/render/server.go:62–67,126`). Native renderers emit a single inbound (`internal/render/server.go:278,420`).
- Publishing deployment B to an instance already used by deployment A is not rejected merely for that overlap. `publishServer` renders only B, extracts its instance artifacts, and calls `GenerateRecord("agent-desired", instanceID)` (`internal/httpapi/server_deployments.go:223–270`). That advances the counter and replaces the desired record (`internal/store/records.go:187–217`). It does not compose A and B. This is a code-path finding, not a newly executed integration test.
- The duplicate-instance guard protects one IR, not separate publications. The submitted-draft fingerprint protects review freshness for that draft; it is not an ownership or cross-deployment conflict check.
- Once the replacement is observed, old routes absent from its immutable manifest fail closed (`internal/httpapi/published_manifests.go:66–100,105–139`). This protects credential export/path claims but does not preserve old listeners or avoid disruption. Old configuration can remain active while a candidate is pending or fails; queued does not mean applied.
- Direct publication writes desired state before its manifest, with explicit partial-failure responses (`internal/httpapi/server_deployments.go:268–279`). Fleet already has a useful atomic compare-and-generate primitive and writes desired plus manifest in one transaction (`internal/httpapi/fleet_execute.go:209–243`; `internal/store/generation_records.go:8–50`). Reuse that approach rather than creating a new orchestration framework.

## Minimal next model

### 1. A complete runtime configuration, containing endpoint programs

Split the existing fields into two simple structures:

- Runtime program: one `CoreInstance`, an ordered collection of endpoint programs, and only genuinely runtime-wide settings.
- Endpoint program: existing `Listener`, `Principals`, `Connectors`, `Rules`, `Resources`, `TLS`, `DefaultAction`, and `DestinationPolicy`.

The runtime collection is keyed by stable endpoint ID; each endpoint must reference its owning instance. One runtime program produces one complete artifact package and one desired generation. Keep explicit adapter/version selection and the existing registry; update renderer interfaces deliberately rather than adding a generic plugin framework.

Accept legacy single-listener IR through a versioned normalization layer into a one-element collection. Keep endpoint and runtime IDs unchanged. Do not permit two simultaneously authoritative representations of the same program. Old immutable manifests remain readable with their original schema; do not rewrite historical evidence.

### 2. Compose authoritative published contributions, not drafts

Maintain an explicit published contribution for each deployment revision, containing its endpoint programs and route bindings. Saved drafts and all inventory endpoints are not automatically active contributions. For an affected instance, the control plane gathers every accepted active contribution and produces a complete runtime snapshot.

Publishing an update replaces only that deployment's contribution. Withdrawing it removes only its owned contribution. A new deployment cannot silently replace another deployment's endpoint policy. Initially reject overlapping endpoint ownership; multiple public route bindings within the endpoint's owning deployment remain possible. Supporting multiple writers to one endpoint is a separate feature, not a prerequisite for many endpoints in one core.

For each affected runtime:

1. Read and fence the contribution set, inventory/adapters, enrollment, current desired identity and policy inputs.
2. Build a deterministic full candidate and manifest. Validate conflicts before any write.
3. Review the full runtime effect, including other endpoints affected by a restart.
4. Compare-and-swap the reviewed set; atomically write contribution revision, desired generation, manifest and audit data. A concurrent publication must force recomposition/review, not lose the other writer's endpoint.
5. Keep observed state separate from queued state. Route usability is established only by exact observed identities and matching route bindings across all hops.

Reuse existing store transaction/fencing patterns. Multi-instance publication is not automatically distributed-atomic: record per-target progress, retain immutable intent and do not claim the route is active until all required hops match. If a contribution spans several instances, its staged/accepted revision and resumable per-target work must not accidentally make partially committed desired records appear fully applied.

### 3. Render semantically, not by concatenating JSON

Emit all listeners and inbound-scoped rules into one config. Namespace connector tags, resource tags and secret paths by endpoint ID; preserve connector `via` references after namespacing. Validate endpoint ID, bind address/port/transport overlap, wildcard and IPv4/IPv6 conflicts, referenced resources and native names. Host-wide port conflicts also matter across different core instances.

Each endpoint's default route must become an inbound-scoped terminal rule. In particular, sing-box currently uses global rules/defaults (`internal/render/server.go:390–420`), which cannot be concatenated safely. Preserve rule order and prevent one endpoint's reject/default from swallowing another endpoint's traffic. Shared direct/reject/system-DNS objects may be emitted once when truly identical; no broad deduplication framework is needed.

Keep listener credentials, TLS material and principal credentials scoped to their endpoint. Use private artifact paths such as `endpoints/<endpoint-id>/...`; reject collisions, and retain summary/redaction boundaries. Runtime package access remains sensitive because it contains every served endpoint's secrets.

### 4. Admission, users and policy must keep their boundaries

Managed bindings already carry `EntryID`, `InboundTag`, subject/account, route and credential version (`internal/entrypolicy/policy.go:47–69`; `internal/render/principals.go:51–63`). Aggregate all bindings without dropping these dimensions. Native authenticated identities must remain unambiguous within the runtime; reject collisions or derive a stable endpoint-scoped native identity while preserving external account, subject and grant identities.

The current sidecar descriptor has one global destination policy, not an endpoint policy map. Do not union allowlists: that would widen authorization. For the first safe managed multi-listener increment, require identical runtime-wide destination policies; supporting different policies requires explicit endpoint-scoped descriptor and runtime enforcement changes with tests.

Audit metering identity before enabling shared runtimes: the current native meter dedup key uses counter epoch, subject, route and measurement layer (`internal/agent/managed_xray_meter.go:35–57`), not entry ID. Either prove existing subject/route identities remain unique per active binding or extend the protocol/key without corrupting prior counters. Do not reset accounting or regenerate credentials merely to consolidate processes.

### 5. Lease, manifest, diagnostics and rollback

Keep the current lease as a runtime safety envelope. Never extend an older contribution's authorization because another deployment was published. Bound a composed runtime lease by the earliest applicable valid policy/enrollment expiry, and require all included contributions to be authorized. Until verified endpoint-specific enforcement exists, expiry/uncertainty can stop the entire runtime; disclose that shared failure boundary. A later per-endpoint lease feature must actually enforce endpoint closure, not just add metadata.

Replace the manifest's single program/deployment fingerprint assumption with a runtime snapshot plus immutable endpoint ownership and route-binding revisions. Each route binding records the exact endpoint program digests/route revision needed across its hops. Do not require unrelated deployments sharing a runtime to share a global deployment fingerprint. A new runtime generation preserving endpoint A may continue to prove A only through the new observed manifest, not by accepting stale runtime identity.

Diagnostics already carry endpoint IDs and runtime identities (`internal/diagnostics/path.go:9–37`), and the managed probe pins the exact process/artifacts (`internal/agent/diagnostics_managed.go:11–55`). Preserve both checks. Resolve the selected endpoint's connector and policy from the composed manifest; never probe a sibling listener accidentally.

Keep agent process supervision, generation fencing, artifact activation and observed identity per instance. No extra process per endpoint. Core upgrade/stop/restart affect all endpoints in that runtime, and Fleet must consume the same composed snapshot instead of rendering only its selected deployment.

Rollback a deployment change by reverting that contribution and recomposing against current other contributions and current authorization. Never blindly restore an old full runtime snapshot that deletes subsequently added endpoints or resurrects revoked users/expired leases. A whole-runtime rollback remains an explicit reviewed operation. Existing core-transition semantics already require a new generation and current policy (`internal/controlprotocol/protocol.go:42–47`).

## Staged delivery and migration

1. **Independent bounded UI change now:** server → endpoint selection, stable identities, duplicate disambiguation, unchanged runtime semantics. No same-family restriction.
2. **Small safety ticket before composition:** explicitly detect/reject conflicting cross-deployment reuse of an instance, or require an explicit reviewed replacement that enumerates removed endpoints/routes. Prefer rejection until composition exists. Add an A-then-B regression showing current replacement behavior and the intended guard. Do not mistake this guard for multi-listener support.
3. **Coherent multi-listener capability:** versioned runtime/endpoint IR, deterministic stock renderers, ownership/composition, atomic desired+manifest, route resolution, diagnostics and Fleet integration. This is a cross-cutting core change, not a small dropdown ticket. It can be split into implementation tickets, but advertise support only after the end-to-end contract is tested.
4. **Managed-runtime verification:** full user/binding/accounting tests; identical-policy restriction initially if needed. Unsupported adapter capabilities fail explicitly, without falling back to weaker enforcement.
5. **Optional explicit consolidation:** existing duplicate instances stay intact. An operator-reviewed migration selects surviving runtime, plans endpoint reparenting and all route/manifest/enrollment consequences, validates port/policy compatibility, observes the complete candidate, and only then retires the old runtime. Endpoint identities should remain stable; runtime generation/scope changes must be reflected in manifests and diagnostics. Do not opportunistically migrate on page load or ordinary publication.

Seed published contributions from known accepted immutable revisions, not all saved drafts. If historical ownership is ambiguous, require explicit review rather than guessing. Never turn an unobserved draft into a running endpoint during migration.

## Acceptance gates

- One instance serves two independently named/protocol-configured endpoints in one native config; one process and one observed generation.
- Publishing A then B keeps both endpoints; editing/removing B leaves A's configuration and authorization intact. Concurrent writes cannot lose either contribution.
- Conflicting endpoint ownership, binds, native identity, adapter/version or incompatible policy fail before desired state changes.
- Endpoint-specific default routes, rejects, principal branches, connectors and TLS cannot bleed into sibling endpoints.
- Identical connector/resource names in two endpoint programs do not collide.
- Current inventory duplicates and legacy IR/manifests remain readable without identity rewriting; managed and stock Xray remain separate adapters.
- Desired and immutable manifest are committed together; fault injection cannot expose an unmanifested candidate. Partial multi-instance activation is not reported as route-ready.
- An unchanged route on a newly observed shared runtime is provable through its new manifest; deleted/revoked routes cannot use old manifests or credentials.
- Lease expiry and quota uncertainty fail closed with the documented runtime-wide blast radius; no publication renews another endpoint's expired authorization implicitly.
- Diagnostics select the intended endpoint and exact observed runtime; stale identity fails closed.
- Metering remains separated across endpoints/users/routes and stable across restart and explicit migration.
- Fleet upgrade, stop and rollback enumerate and preserve the full affected runtime scope. Reverting B cannot delete later changes to A.

## Scope conclusion

The desired product model is sound: a server normally has one suitable runtime of each needed core, serving multiple endpoints. The current implementation does not yet realize that model. The immediate selection UX is bounded; correct multi-listener runtime composition is a substantial but contained change across existing layers, not a reason for a new framework or a broad UI redesign.

## Follow-up review: bounded ownership guard before multi-listener work

The existing direct-apply confirmation is not a specific cross-deployment replacement review. Validation returns only the submitted deployment's rendered artifacts/fingerprint (`internal/httpapi/server_deployments.go:73–91`). The UI warns that connections may interrupt and lists the selected listeners (`web/src/ServerRoutes.tsx:906–929`), but does not identify another deployment or its removed routes. TLS checks select only routes belonging to this deployment (`internal/httpapi/server_tls_publication.go:23–35`). The path/manifest checks also select only that deployment and run after desired has been queued (`internal/httpapi/published_manifests.go:23–59`; `internal/httpapi/server_deployments.go:268–279`). These do not establish explicit intent to replace someone else's active configuration.

Fleet provides actual artifact diffs and current-desired fencing, but its affected-route list is filtered to the requested deployment (`internal/httpapi/fleet_prepare.go:149–160,283–300`). That is valuable review protection, not a complete cross-deployment ownership check.

Proposed immediate guard, separately reviewed before implementation:

- Record one durable owning deployment for each instance's accepted configuration. This is deployment ownership, not core-family uniqueness. First publication claims it atomically; later publications by the same deployment may update it.
- Reject a different deployment's activation with a conflict that names the instance and owner. Apply to direct publish and Fleet configure/start/restart/upgrade/rollback routes. Do not rely on a UI-only check or on scanning mutable draft programs.
- Check all requested targets before queueing; fence ownership/current desired during each atomic write. A preview can report conflict early, but cannot authorize a later changed baseline.
- Bootstrap ownership from the manifest matching the currently accepted desired revision and, where relevant, the actual observed revision. Do not treat a missing/corrupt manifest or contradictory desired/observed ownership as unowned. Return an actionable reconciliation conflict. A new, non-activating install with no prior configuration is not an ownership claim.
- An expiry, failed candidate, stale observation or explicit stop does not automatically free ownership: old configuration may remain recoverable or still running, and future same-deployment start/rollback should retain its identity. Transfer/release is a future explicit reviewed operation, not an inferred side effect.
- Keep explicit stop usable against the accepted runtime package even when its current draft is invalid. It is a deliberate whole-instance stop, not a configuration takeover. Keep non-activating installation from reassigning configuration ownership. If stopped/install desired records have no manifest, the durable owner record prevents losing the association.
- Same-deployment rollback remains allowed and continues to use historical topology with current grants/credentials and a new lease (`internal/httpapi/fleet_prepare.go:89–118`; `internal/httpapi/fleet_test.go:248–280`). If ownership has genuinely transferred through a future supported flow, a historical rollback from the former owner must not bypass that transfer.

Guard regression gates: A then B on the same instance rejects B without advancing generation or changing artifacts; A then A succeeds; concurrent first publication has exactly one winning owner; a conflicting multi-target request is rejected before ordinary queueing; missing/contradictory ownership evidence fails closed; same-deployment Fleet configure/upgrade/rollback works; explicit stop with an invalid draft still works (`TestFleetStopUsesAcceptedPackageWhenDraftIsInvalid`, `internal/httpapi/fleet_test.go:408–426`); install/stop do not erase ownership. Test direct/Fleet cross-combinations, not only one API path.

This guard is a bounded safety ticket. It prevents accidental replacement while multi-listener composition remains a separate larger capability. It must not advertise that two deployments can share one instance concurrently.
