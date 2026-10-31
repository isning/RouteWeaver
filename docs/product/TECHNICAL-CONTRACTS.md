# RouteWeaver technical contracts

Design-review draft, 2026-10-19 UTC. **No implementation authorization, deployment, passing runtime tests, or production-readiness claim is created by this document.** This is the contract between the [product specification](SPEC.md), [domain model](DOMAIN-MODEL.md), and later implementation slices. It does not endorse the exploratory prototype's two-hop or single-engine assumptions.

## 0. Decision status and evidence

| Status | Meaning here |
| --- | --- |
| Confirmed product constraint | Multi-core architecture; separate server and client IRs; file-referenced rules preferred over flattened subscription rules; administrators own shared topology while users compose their own subscriptions. See C1–C6 in [the decision map](DECISION-MAP.md). |
| Confirmed privacy principle | The first release may process private sources on the server with explicit operator-visibility disclosure. See [the exact question and answer](decisions/privacy.md). This is not blanket approval of the packet or permission to expose credentials in administrative screens. |
| Confirmed multiplier requirement | User: “还有倍率计费功能，也是需要的”, followed by “是的” to the explicit traffic-quota interpretation: raw route traffic × route multiplier = quota debit, once per whole route rather than per hop; separate raw/weighted/provider usage, retain policy history, and show the multiplier when selecting routes/viewing usage. Money/payment billing is excluded. Arithmetic, attribution and cutover details below remain proposed. |
| Proposed contract | Every schema, API operation, boundary, state transition, numeric representation and default below, unless explicitly labeled otherwise. These are concrete recommendations for review, not resolved human decisions. |
| Technically unverified | Exact supported core/client versions; reload atomicity; observable active-config identity; counter attribution/reset guarantees; private rule authentication/cache behavior; session termination and enforcement delay. Official format documentation is not execution evidence. |

Implementation was authorized by the user on 2026-10-19 after acceptance of the full capability register and the final eight recommended policies. This document remains an engineering contract draft: concrete details may be refined within those approved policies; live VPS changes, external account authorization and persistent credentials remain separately gated. Xray and sing-box are initial adapters, not a closed family enumeration. No additional database, message broker, microservice, arbitrary plugin loader or paid-billing subsystem is required by this contract. The approved capability register separately includes target-specific advanced client configuration editing; this older contract must not be used to remove that requirement. The pinned Matt Pocock skill checkout named in AGENTS.md was unavailable during this drafting pass; no rereading or execution of that absent checkout is claimed. Existing product-method records remain historical evidence only.

## 1. Modules, ports and dependency direction

Use a modular control-plane application plus a narrow node agent. Logical boundaries are not separate network services. Implementation may use established framework/library components behind ports, without making framework types part of durable intent.

| Module | Owns | Must not own |
| --- | --- | --- |
| Domain | Immutable identity/revisions; route path invariants; ownership; entitlement evaluation inputs; policy semantics; ledger accounting definitions | HTTP, SQL, operating-system commands, native core configuration, network fetches |
| Application | Authorized commands/queries; transactions; snapshot assembly; job lifecycle; cross-module orchestration | Undocumented implicit exits, ambient tenant state, hidden renderer fallbacks |
| Intent repository | Revision/CAS persistence; immutable input manifests; job/idempotency records; observations and journal transactions | Meaning of a route or discretionary authorization |
| Policy/IR builder | Deterministic resolution from a frozen manifest into ServerDeploymentIR or ClientProfileIR; semantic validation and required capabilities | Runtime mutation; fetching mutable “latest” during compilation |
| Resource service | Safe fetch; accepted immutable blobs; digest/provenance; version selection; tenant-authorized delivery; retention | Assuming file syntax proves semantic equivalence or upstream trust |
| Server renderer | ServerDeploymentIR → per-instance native configuration/resource plan; capability-specific diagnostics | Applying configuration; reading secret stores; rendering client subscriptions |
| Client renderer | ClientProfileIR → client artifact/resource manifest; explicit target/version handling | Creating deployments/links; exporting internal platform topology or transit secrets |
| Deployment reconciler | Persisted desired generation; dependencies; target attempts; evidence-based aggregate status; explicit recovery plans | Declaring a distributed transaction across cores or treating a render as success |
| Node runtime adapter | Local validate/stage/apply/observe/quiesce/restore primitives for a declared family/version envelope | User profile decisions; source subscriptions; entitlement policy authoring |
| Meter ingestion/accounting | Measurement identity; deduplication; epoch/gap handling; immutable raw and weighted journal; cycle reconciliation | Payment collection; silently equating provider and user bytes |
| HTTP/agent transport/UI | Authentication and request mapping; role/ownership enforcement through application seams; truthful display | Reimplementing domain decisions or inferring success from a 202 response |

Dependency direction: UI/HTTP/job drivers → application → domain and declared ports. Persistence, resource fetch, secrets, renderers and runtimes implement those ports. Shared policy primitives do not import a renderer; a server renderer does not import the client renderer. Agent wire DTOs are not database entities. Dependency tests later prevent these reverse imports.

The agent accepts only a scoped deployment envelope for its enrolled node/instances, resource/credential material needed locally, and bounded control operations. It has no arbitrary remote-shell API, no access to the subscription-source database, and no permission to enumerate other tenants. Enrollment, certificate issuance/rotation, operating-system privileges and installation are separate reviewed security procedures, not enabled by a design document.

Extension consists of registered adapter identifiers, versioned capability descriptors and contract fixtures. Core family is an open namespaced identifier, not `xray | singbox`. Unknown families are storable as disabled inventory but cannot become runnable by bypassing validation. Initially load trusted built-in adapters; a hypothetical third fixture proves extensibility of the boundary, not support for a real third core.

## 2. Common representation rules

- Product revision, compile identity, artifact digest, deployment attempt and runtime observation are different identifiers. A display rename changes no stable object identity. No IP address, source URL, array index or core's mutable display tag is the durable identity.
- Every compilation consumes an immutable input manifest: relevant object revisions, resolved entitlement revision, source snapshot IDs, resource revision/digests, credential version references, accounting-policy versions, renderer build and target descriptor. No later lookup may substitute a newer value under the same identity.
- IR is **derived and immutable**. Persist product intent plus its revisions; retain IR/manifests for reproducibility and audit. Editing native output is not editing product intent.
- Proposed schema envelope: `kind`, `schemaVersion`, `compilationId`, `inputManifestRef`, `requiredCapabilities` and the kind-specific payload. Version `1.0` below is a proposed contract version, not an implemented release.
- Unknown major versions are rejected. Minor versions may add optional descriptive metadata, but cannot change matching, accounting, defaults or action semantics. Unknown behavior-bearing fields, operators or required capabilities are rejected even at the same major version. Metadata has a separate bounded namespace and must not affect runtime behavior. No “ignore unknown fields” shortcut for policy.
- Migrations create a new derived artifact, retain the old manifest and record migration version/diff; they never mutate an old published digest. A major semantic migration requires review before replacing an effective generation. Do not silently coerce unknown operators to the nearest known operator.
- Canonical hashing fixes encoding, key order, integer representation and array-order preservation; excludes nondeterministic rendering timestamps. Rule/group/path arrays remain ordered. Intent hashes include immutable secret **version references**, not secret values; materialized artifacts have their own restricted digest and access policy. A redacted preview is explicitly not an importable canonical IR.
- Byte quantities, sequence numbers, generations and revision counters use unsigned decimal strings on JSON seams, avoiding JavaScript precision loss. Timestamps carry timezone/UTC and are not ordering authority. UUID-like strings below are illustrative opaque IDs, not a prescribed ID library.
- A named target-specific extension declares namespace, version, scope and mandatory capability. It is validated only by an adapter declaring that capability and shown as nonportable in preview. Never pass through arbitrary native fields while claiming portable semantics.

## 3. Separate versioned IRs

### 3.1 ServerDeploymentIR

Represents an approved administrator topology/policy revision compiled for an explicit target set. Each concrete interface and forwarding edge is resolved through a pinned manifest; no endpoint secret or latest database lookup is implicit. It expresses the intended route, not proof that the path works.

Illustrative structural instance, not executable core configuration. All references name synthetic frozen records; the manifest must contain their exact definitions for a real compilation. `coreVersionRef` resolves to an exact verified version/build before validation can pass, not a floating version range.

```json
{
  "kind": "ServerDeploymentIR",
  "schemaVersion": "1.0",
  "compilationId": "compile_server_example",
  "inputManifestRef": "manifest_server_17",
  "topologyRevision": "17",
  "requiredCapabilities": ["server.ordered_forwarding.v1", "rules.external_resource.v1"],
  "targets": [
    {
      "instanceId": "core_fra_a",
      "nodeId": "node_fra",
      "adapterId": "routeweaver/xray",
      "coreVersionRef": "target_xray_exact_build",
      "program": {
        "managedInterfaceRefs": ["iface_fra_entry_r4"],
        "connectorRefs": ["connector_to_uk_r7"],
        "credentialVersionRefs": ["secret_fra_entry_auth_r6", "secret_uk_transit_r2"],
        "policy": {
          "rules": [
            {
              "ruleId": "rule_server_allow",
              "match": {"op": "resource", "resourceRef": "resource_allowed_r3"},
              "action": {"kind": "forward", "connectorRef": "connector_to_uk_r7"}
            }
          ],
          "defaultAction": {"kind": "reject"}
        }
      }
    },
    {
      "instanceId": "core_uk_b",
      "nodeId": "node_uk",
      "adapterId": "routeweaver/sing-box",
      "coreVersionRef": "target_singbox_exact_build",
      "program": {
        "managedInterfaceRefs": ["iface_uk_transit_r2"],
        "connectorRefs": ["connector_uk_egress_r1"],
        "credentialVersionRefs": ["secret_uk_transit_r2"],
        "policy": {
          "rules": [],
          "defaultAction": {"kind": "forward", "connectorRef": "connector_uk_egress_r1"}
        }
      }
    }
  ],
  "routeBindings": [
    {
      "routeId": "route_fra_uk",
      "routeRevision": "8",
      "entryInterfaceRef": "iface_fra_entry_r4",
      "orderedLinkRefs": ["link_fra_uk_r7"],
      "intendedExitRef": "connector_uk_egress_r1",
      "accountingPolicyRef": "quota_route_fra_uk_r3"
    }
  ],
  "ruleResourceRefs": ["resource_allowed_r3"]
}
```

The manifest schema separately freezes interface address/listen intent, typed protocol/transport/security parameters, directional connector credentials, authorization/entry-meter binding and resource semantic descriptors. A reference without that record is invalid; this example does not assert either initial core supports every illustrated operation. Agent envelopes contain only the assigned target's configuration and necessary local dependencies, not the complete multi-node IR or unrelated credentials.

Graph inventory may have branches; each published route revision is a finite ordered simple path with one explicit entry and intended exit. Its length is constrained by proven adapter/runtime capabilities, not a global two-hop rule. A private user source cannot appear here unless a separate authorized administrative upstream workflow created the appropriate explicit reference. Client compilation has no authority to do that.

### 3.2 ClientProfileIR

Represents one owner's profile at frozen access/source/resource revisions. It may contain entitled platform **entry** options and owner-private imported endpoints, but never reconstructs the platform's internal server chain. Client target identity is distinct from the server core running the route.

```json
{
  "kind": "ClientProfileIR",
  "schemaVersion": "1.0",
  "compilationId": "compile_client_example",
  "inputManifestRef": "manifest_client_24",
  "ownerId": "user_example",
  "profileId": "profile_main",
  "profileRevision": "24",
  "entitlementEvaluationRef": "access_eval_12",
  "targetDescriptorRef": "client_target_exact_build",
  "requiredCapabilities": ["client.manual_group.v1", "rules.external_resource.v1"],
  "proxyOptions": [
    {
      "optionId": "option_platform",
      "kind": "platform_entry",
      "routeId": "route_fra_uk",
      "routeRevision": "8",
      "entryConnectionRef": "client_entry_fra_r6",
      "credentialVersionRef": "secret_user_entry_r4",
      "accountingPolicyRef": "quota_route_fra_uk_r3"
    },
    {
      "optionId": "option_private",
      "kind": "private_source_endpoint",
      "snapshotRef": "source_snapshot_9",
      "endpointRef": "source_endpoint_a",
      "connectionRef": "private_connection_r9",
      "credentialVersionRef": "secret_private_endpoint_r9"
    }
  ],
  "groups": [
    {
      "groupId": "group_chatgpt",
      "kind": "manual_select",
      "orderedMembers": ["option_platform", "option_private"],
      "selectedMember": "option_platform",
      "onUnavailable": "block"
    }
  ],
  "policy": {
    "rules": [
      {
        "ruleId": "rule_chatgpt",
        "match": {"op": "resource", "resourceRef": "resource_chatgpt_r5"},
        "action": {"kind": "select_group", "groupRef": "group_chatgpt"}
      }
    ],
    "defaultAction": {"kind": "use_option", "optionRef": "option_private"},
    "dnsIntentRef": "dns_profile_r2",
    "resourcePolicy": {"inlineFallback": "forbid"}
  },
  "ruleResourceRefs": ["resource_chatgpt_r5"]
}
```

This is an illustrative profile choice, not a mandatory fallback to a user's airport. `selectedMember` is the published/default selection; runtime selection made within a client may diverge and is not observable unless that client provides verified telemetry. Do not show an exported default as the user's live choice. An unavailable chosen member is not permission to pick another exit. If the target cannot preserve that failure behavior, it is unsupported for this profile. Groups must be nonempty, acyclic, referentially valid and ordered; the default action is explicit and valid at publication time.

Client serialization uses an allowlisted projection: output names, needed connection parameters and the recipient's own necessary endpoint credentials/resource authorization. Do not serialize owner IDs, source URLs, internal instance IDs, admin topology, transit credentials, secret-store references or accounting internals merely because they occur in an IR/manifest. Platform entry credentials and imported provider credentials are necessarily readable by the authorized receiving client; this is not operator-blind encryption.

## 4. Capability negotiation and diagnostic contract

Capability descriptors are evidence-backed data, not boolean marketing labels. A descriptor identifies adapter/build, role (server renderer/runtime/client renderer), exact target family/application/version/build, protocol and transport combinations, rule/DNS operators and limits, resource formats/versions/delivery/auth/cache/integrity behavior, validate/apply/observe/revoke behavior, and meter attribution/epochs. Capabilities may have parameter constraints and incompatible combinations; checking a flat feature list is insufficient.

For each requirement return one of: **supported with evidence**, **unsupported**, or **unverified**. “Not mentioned” is unverified. Initial release publication/apply requires supported evidence for every mandatory requirement. Optional metadata warnings may continue; a mandatory unsupported semantic is never downgraded to a warning. Missing enforcement/meter capabilities block the corresponding promise even if a configuration renders.

Negotiation sequence:
1. Freeze target identity and manifest; reject unsupported IR/schema versions.
2. Derive all semantic requirements, including implicit DNS/missing-field behavior and action failure policy.
3. Match the full capability constraints and their evidence against each exact target.
4. Plan resource variants/delivery without changing semantics. An alternative file representation is allowed only for a documented supported subset with equivalence evidence; it is not generic format conversion.
5. Render deterministically, then run the pinned native validator when available. Lack of a validator is explicit and requires a reviewed alternative validation envelope, not fictitious success.
6. For server deployment, independently obtain apply/runtime observations. For clients, validate resource access/output, then publish; client execution remains unobserved unless separately measured.

Proposed structured diagnostic fields: stable `code`, `severity`, phase, IR/object ID and JSON pointer, exact target descriptor, required capability, reason category (`unsupported`, `unverified`, `conflict`, `unsafe`, `stale`), redacted human explanation, and an actionable remediation. No credentials, bearer URLs or fetched content fragments in error messages.

Examples: `RULE_SEMANTICS_UNSUPPORTED`, `TARGET_EVIDENCE_MISSING`, `RESOURCE_VERSION_INCOMPATIBLE`, `RESOURCE_REFRESH_STALE`, `RESOURCE_INTEGRITY_FAILED`, `PRIVATE_RESOURCE_AUTH_UNSUPPORTED`, `STALE_GENERATION_REJECTED`, `COUNTER_BOUNDARY_UNRESOLVED`, `ENTRY_ROUTE_ATTRIBUTION_MISSING`. A diagnostic names the unsupported predicate/combination, not merely “invalid configuration.” It cannot quietly replace a regex with suffix matching or erase a DNS-dependent rule.

## 5. Ordered rules and resource semantics

### 5.1 Semantic primitives

Use a typed expression tree with explicit operations such as domain exact/suffix/glob/regex, destination/source CIDR, transport/port, `all`, `any`, `not`, and immutable resource membership. This is an extensible vocabulary, not a claim that all primitives are in the first compatibility envelope. Each operator needs defined input availability, case/IDNA normalization, regex dialect, wildcard boundaries, IPv4/IPv6 handling and evaluation stage before it becomes supported.

Proposed routing evaluation is ordered, first matching **terminal** action wins; otherwise the explicit default action executes. No implicit terminal rule is appended by a renderer. Resource membership is a predicate at its original rule position, not a separate priority group. Nested boolean structure is preserved. Rule ordering cannot be inferred from map iteration or sorted display names. Nonterminal native operations, sniffing, DNS rewriting and subroutines are unsupported unless represented by a separately specified capability; do not force them into a terminal-rule model.

Domain and destination-IP matching are not interchangeable. DNS intent freezes whether/when resolution occurs, which answers enter matching, fake-IP/real-IP interpretation where applicable, and routing of DNS queries themselves. A matcher with unavailable input does not gain a silent “false” or “true” interpretation; the IR must specify the stage/availability behavior and the adapter must support it, or compilation fails. This prevents `not(domain-match)` from accidentally allowing traffic when a domain was never available. “DIRECT” is an explicit action with deliberate scope, never an error-recovery default.

### 5.2 RuleSetRef and variant manifest

RuleSetRef requires immutable resource identity/revision, owner/access scope, provenance, semantic descriptor/version, pinned content digest, accepted retrieval record, size constraints, freshness/security policy, and revocation state. Source locator and fetch credential references stay private. A delivery variant additionally names exact native format/version, derivation tool/version, semantic subset/evidence, variant digest and target constraints. Semantic identity and raw native file digest are related but not interchangeable.

Illustrative resource descriptor:

```json
{
  "kind": "RuleResource",
  "schemaVersion": "1.0",
  "resourceId": "resource_chatgpt",
  "revision": "5",
  "ownerScope": "user_example",
  "semanticDescriptorRef": "domain_suffix_set_v1",
  "sourceRevisionRef": "private_source_locator_r2",
  "acceptedBlobRef": "blob_accepted_5",
  "pin": {"algorithm": "sha256", "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "freshnessPolicyRef": "resource_freshness_reviewed_r1",
  "variants": [
    {
      "variantId": "variant_srs_5",
      "format": "sing-box/srs",
      "formatVersionRef": "exact_supported_srs_version",
      "artifactRef": "blob_srs_5",
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "capabilityEvidenceRef": "evidence_srs_domain_subset",
      "delivery": {"mode": "authenticated_resource", "authorizationRef": "resource_grant_scoped"}
    }
  ],
  "inlineFallback": "forbid"
}
```

The example digest values and version/evidence references are placeholders, not actual artifacts or passing evidence. A release manifest must resolve them to concrete immutable records. Do not expose private source locations or upstream credentials in the delivery URL. A scoped resource token is a distinct credential from the upstream source credential.

Documented initial distinctions are in [RULE-COMPATIBILITY.md](RULE-COMPATIBILITY.md): sing-box's source/SRS versions are version-dependent; Xray uses its own supported geosite/geoip/DAT mechanisms; Mihomo MRS is not a general classical-rule representation. These upstream facts justify capability gates, not blanket SRS → MRS/DAT conversion. The runtime is not assumed to validate RouteWeaver's manifest/signature or digest merely because the control plane does.

### 5.3 Refresh, delivery and failure

1. Fetch into a candidate, apply safe-fetch limits, verify provenance/integrity where available, parse and check the declared semantics. No fetch result directly replaces an accepted blob.
2. Resolve a new immutable revision and impact diff. Publication pins an accepted revision according to the reviewed update policy; a mutable upstream URL never rewrites pinned bytes.
3. A timeout/non-200/parse failure is a failed refresh, not an empty rule set. Retain the last accepted version only within its explicit freshness/security policy and label it stale. Do not invent freshness durations before capability/security review.
4. Missing, expired, revoked or integrity-failed resources block new publication. Suspected compromise is not an availability failure eligible for automatic stale fallback. Existing active generations are marked affected/degraded; controlled server enforcement follows the reviewed fail-closed procedure and reports its observed result. Cached clients cannot be remotely assumed stopped.
5. Publish only when all referenced delivery artifacts exist and access checks succeed. Delivery paths are immutable by revision/digest; revocation denies future retrieval. Use a client-supported authenticated fetch, a protected local bundle, or block that target. Do not pretend bearer-in-URL and header authentication have equal support or exposure.
6. Referenced rule files are the default. Inline fallback requires a distinct explicit export/profile policy, semantic and size diff, and user approval. It does not happen because a download failed or a renderer lacks support.
7. Retain a blob while a permitted live/retained generation references it, subject to retention/deletion policy. Retention does not authorize access after revocation. Private deduplication must not leak another owner's resource existence, size, digest or hit/miss.

## 6. Deployment reconciliation, fencing and recovery

### 6.1 State and success claims

Plan states: `draft → validated → staged → queued → reconciling`. Aggregate results are `observed_success`, `partial`, `failed`, `unknown`, or `superseded`, each derived from per-target records, never one optimistic boolean.

Per-target attempt states: `pending → accepted → resources_ready → native_validated → applying → applied_unobserved → observed_conformant`; additional states include `validation_failed`, `apply_failed`, `observation_failed`, `unknown`, `superseded` and `blocked`. `applied_unobserved` means an adapter operation acknowledged completion, not that the service works. Native parse success is not apply success. An unreachable runtime after a request is `unknown`, not safe to blindly reapply.

Each observation includes enrollment/instance/runtime identity, boot ID where supported, attempt/generation, observed artifact identity where verifiable, observation type/time, freshness and evidence level. Process liveness, port acceptance, configuration identity, authorized end-to-end route probe and traffic egress are distinct observations. A route is available only when its required generation vector and reviewed health/enforcement evidence are current; a successful TCP connect alone cannot prove the UK exit. Exact probes and validity windows remain technically unverified.

Deployment and route publication are separate commands. No newly mixed/partial route is published as usable. A previously published route affected by an update is explicitly transitioning/degraded/unavailable until its required evidence is restored; do not retain a green badge simply because its old revision once worked. Whether native connection draining can preserve existing sessions is adapter-specific and not equivalent to uninterrupted atomic migration.

### 6.2 Generation fence

- A durable control-plane transaction assigns monotonically increasing desired generations **per target instance** and an immutable attempt identity; a deployment records the required target-generation vector. Reusing a generation with a different payload/digest is a conflict.
- Command envelopes bind node enrollment epoch, instance identity, generation, artifact/manifest digest and operation ID. A re-enrollment invalidates old epochs through the control-plane/agent trust procedure; a counter reset after reinstall must not make old commands valid again.
- The agent durably records the highest accepted generation before mutation and maintains a single serialized mutation lane for that instance. Lower generations are rejected; same-generation/same-payload retries return the recorded outcome or resume the same verified attempt. Same-generation/different-payload is rejected.
- Checking the fence only before an asynchronous native reload is insufficient. An older in-flight native operation must finish, be canceled with verified quiescence, or block the lane before the newer operation can mutate runtime. All mutation paths, including recovery, share this lane. A runtime API with unbounded unobservable delayed completion cannot receive a “stale apply impossible” guarantee.
- Admission of a newer generation does not retroactively undo an old side effect. While the old operation is in flight and the new desired generation is pending, report actual running state and transition. Never label a late old acknowledgement as current-generation success. Discard stale observations for current status while retaining them as history.
- After agent/control-plane restart or an uncertain crash window, reconcile the durable attempt journal with actual runtime/resources before mutating again. If the adapter cannot establish quiescence/current identity, mark unknown and block unsafe progress rather than replaying commands optimistically.
- Lease/command expiry and offline behavior require a reviewed local clock/monotonic-clock design. Wall-clock timestamps alone do not fence operations. A disconnected agent must not run an unbounded sequence of queued obsolete deployments.

This serial fence prevents an older operation from overwriting a newer **completed** activation under its stated adapter/storage/single-writer assumptions. It is not a distributed consensus claim, and cannot protect against an administrator editing native configuration out of band. Detect unexpected drift where observable; surface unobservable drift limits explicitly.

### 6.3 Partial apply and rollback

Prestage/validate all possible targets before activation, then follow a reviewed dependency order that prepares downstream forwarding before enabling new upstream access when supported. That reduces risk; it does not provide a multi-node transaction. Cancellation after the first side effect is a stop request with per-target outcomes, not a promise of no changes.

If target A changed and B failed/offline, store both facts. Retrying only unresolved targets uses their immutable intended payload and same idempotent attempt unless new intent requires a new generation. Do not revert A merely to make the aggregate status look failed consistently. Recovery policy is explicit and reviewed, never an unannounced route/exit substitution.

Rollback is a **new deployment with newer generations** using a selected known-good intent/resource snapshot, revalidated against current runtime capabilities, authorization and secret/resource revocation. Old credentials or access grants are not resurrected. If an old resource has expired or a secret was revoked, rollback may be blocked or need a newly rendered recovery revision. Partial rollback and unknown rollback outcomes remain partial/unknown; only observed target results establish restoration. Preserve the failed attempt and accounting records.

## 7. Usage, provider accounting and quota multipliers

The user confirmed that “倍率计费” means traffic-quota multiplication. The technical contracts in this section are proposed. Money, currency, invoicing, payments, tax and balances are not added by this requirement.

### 7.1 Three separate measures

| Measure | Proposed authority/scope | Must not be inferred from |
| --- | --- | --- |
| Provider traffic | Provider billing scope and verified included interfaces/directions/cycle; IN + OUT where the provider counts both. Reconcile against authoritative provider statements when available. | A user's quota, sum of every host/tunnel interface, or application payload counters called exact billed bytes |
| Raw user route traffic | Authenticated user's attributable first platform entry, for the selected route, upload + download in one declared metering layer | Sum of all hop/egress counters; a guessed route from exit geography |
| Weighted user quota | Raw attributable first-entry traffic multiplied once by the immutable effective route-accounting policy, posted to one explicit user allowance scope | Provider IN+OUT totals, per-hop multiplication, or client-declared counters |

Protocol/application byte counters and network-interface billed bytes can differ due to overhead, retransmission, resolution and unrelated traffic. Label measurement provenance and coverage. “Unlimited” in inventory is not evidence that provider accounting has no constraints. A private airport used directly by the client produces no platform quota charge by default; its provider's own accounting remains separate.

One platform route may traverse several nodes and contribute to each provider's allowance, but consumes user quota only at its defined first entry. The same traffic must not re-enter user accounting at the next hop. Inbound/credential/meter bindings must identify user, route and allowance scope. If shared multiplexed counters cannot distinguish routes with different multipliers, multiplier enforcement for that arrangement is unsupported until a verified attribution mechanism exists. Do not divide shared traffic among users by assumption. Overlapping entitlements resolve to an explicit nonduplicating allowance policy, not one debit per matching entitlement.

### 7.2 Measurement identity, resets and deduplication

Proposed cumulative measurement record: collector/authority ID, enrolled node/instance, logical counter ID, direction, counter epoch, monotonic sequence, cumulative byte value, observation window/clock quality, meter-binding revision and acquisition quality. Counter epoch changes when its monotonic basis resets; deployment generation alone neither proves nor disproves reset.

- Ingestion authenticates authority and validates its permitted scope. Enforce uniqueness for `(authority, counterId, epoch, sequence)`; identical retry is a no-op, conflicting values under that identity are quarantined. Transport message ID alone is insufficient.
- Journal accepted samples and the unique predecessor-to-successor delta identity in the same transaction as ledger advancement. Application crash/retry cannot debit the same interval twice. Cumulative missing samples are recoverable only where the later measurement still covers one unambiguous binding/policy/cycle interval.
- Out-of-order samples are buffered/reconciled against the predecessor chain. A lower cumulative value does not become a negative debit or automatically mean wraparound. A confirmed reset starts a new epoch; an unexplained decrease, duplicate source or changed attribution becomes unresolved measurement.
- A new epoch counts from zero only if the adapter proves its zero/start boundary and complete coverage. Otherwise the first sample establishes a baseline and the earlier interval is explicitly unknown, not zero. A crash between increment and collection can cause a gap; do not claim durable exactly-once measurement because downstream posting is idempotent.
- After an interval is posted, a late intermediate cumulative sample must not add another overlapping delta. It may supply evidence to correct prior allocation through an auditable reversal/reposting operation, never by erasing history or double-debiting it.
- Counter discovery/remapping is versioned. Two collectors reading the same native counter are not two independent billable sources. Adapter tests must establish reset behavior, export side effects and attribution for the selected versions before enforcement is enabled.

### 7.3 Multiplier policy and exact arithmetic

Proposed first-release representation uses nonnegative fixed-point integer arithmetic with a fixed scale of 1,000,000. A policy contains `policyId`, immutable revision, route ID, allowance scope, multiplier units/scale, effective attribution boundary and status. Example: `multiplierUnits: "2000000", scale: "1000000"` denotes 2×. Recommended initial accepted range is positive and bounded after validation; a free/0× policy is a separate explicit supported choice, not a missing-value default. No binary floating-point money/byte arithmetic.

Each resolved raw delta has exactly one route policy version and one cycle allocation. Append both raw bytes and `weightedMicrobytes = rawBytes × multiplierUnits`. Use checked sufficiently large integers; define overflow rejection, not saturation/wrap. Values not exactly representable at the accepted scale are rejected with an explanation, not silently rounded during policy authoring.

Aggregate weighted microbytes across all applicable policy versions in the user allowance cycle. Compare against `limitBytes × scale` using exact integers. Display whole charged bytes by rounding the **aggregate** upward if needed and explain fractional precision. Do not round each packet, observation, direction, policy bucket or API page separately. Thus splitting one measurement into 100 batches does not change the debit. Never multiply accumulated weighted usage again when policies or displayed units change. Decimal GB versus binary GiB is explicit at import/display; storage is bytes.

Policy edits create a new revision and an announced future effective boundary; no retrospective re-rating of already accepted traffic. Show the effective multiplier beside route selection, preview and usage, including a pending change. A client file or cache may show an old label; authoritative charge policy and its effective interval are server-side and visible to the user, not whatever the client sends.

### 7.4 Policy boundaries, rollover and late measurements

An API `effectiveAt` timestamp does not make cumulative telemetry precisely splittable. Prefer a verified metering barrier: capture/close the old attributable interval, apply the new binding/policy under the deployment protocol, and start a provable new interval. Existing sessions require an adapter-supported attribution policy; if necessary, defer the effective change until sessions drain or use a separately approved interruption. Do not promise an exact switch timestamp without that evidence.

If one cumulative delta spans different multiplier policies or billing cycles without trusted subinterval counters, put it in an unresolved boundary journal. Do not apportion linearly by time, charge it wholly at the higher multiplier, or call an estimate exact. The UI shows the gap and policy effect; new admission uses the agreed conservative fail-closed principle when allowance cannot be safely established. Resolution requires new evidence or an explicit audited adjustment policy. An unsupported exact-boundary guarantee is a release blocker, not a number the user should guess.

Cycle policy includes anchor, timezone, duration/calendar semantics and unit definition. Provider and user cycles may differ. Rollover opens a new ledger bucket; it does not zero or rewrite native counters or the old journal. Late measurements are attributed to their proven original cycle/policy window; they never silently become current-cycle usage. Corrections to a closed period append adjustments retaining original-cycle attribution and a visible amended total. Carryover, forgiveness or cross-cycle debit is not assumed and requires an explicit allowance policy. Fractional accumulated charge remains in its original cycle; no hidden transfer caused by display rounding.

### 7.5 Enforcement and truthfulness

The already agreed principle is fail closed with a prompt when route/quota state is uncertain, without silent exit switching. Enforcement still needs verified meter freshness, local permission lease behavior, offline policy, admission rejection and existing-session termination capabilities. Provider allowance uncertainty and user allowance exhaustion are distinct reasons.

No strict zero-overshoot guarantee follows from periodic counters. Any proposed bound must state its assumptions, for example verified aggregate rate bound × worst-case observation/distribution/termination latency plus known in-flight allowance. If rate, downtime or termination latency is unbounded, overshoot is unbounded under that model. Record measurable bounds after isolated runtime testing; do not invent production thresholds in this draft. Future-feed denial alone does not stop already exported credentials or active sessions.

## 8. Credential handling, ownership and SSRF

- Store private source locators, upstream auth, normalized credentials, generated artifacts and entry credentials under explicit owner/scope and version references. At-rest encryption, restricted decryption and audited access reduce risk but do not hide server-processed data from an operator able to control the server. Display this trust model before source submission.
- Renderers receive typed necessary inputs through scoped resolution, not unrestricted secret-store handles. Materialize secrets only at the restricted delivery/apply boundary; exclude them from normal logs, diagnostics, tracing tags, CLI arguments, crash reports, preview diffs and public hashes/URLs. Secret-bearing temporary files use minimal permissions and defined cleanup; backups and retained artifacts are covered by retention/deletion policy.
- Redacted preview and actual authorized export are distinct endpoints. A user may obtain their own necessary client connection secrets, never another user's, a platform transit secret or the original source access token merely by requesting “raw IR.” Administrative operator visibility is not default permission to browse private credentials.
- Resource and subscription fetchers treat all imported URLs/redirects/content as untrusted data. Permit only reviewed protocols; reject URL userinfo and local/file schemes; resolve and reject loopback, link-local, private, metadata and other forbidden destinations in IPv4/IPv6 forms. Validate every redirect and every new connection resolution, including DNS rebinding; pin validated destinations at connection time while preserving TLS hostname validation. Proxy settings cannot silently bypass egress controls.
- Block private-source SSRF even for a logged-in owner. Do not relay upstream credentials to a redirect host or different origin. Constrain redirects, body/decompression size, response time, concurrency, recursion and parsers; never fetch arbitrary URLs embedded in a source simply because the source contained them. Test allowed public redirects separately from credential-bearing cross-origin redirects.
- Source deletion stops future secret resolution and refresh, invalidates future dependent generations and reports the effect on live artifacts, retained records and backups. Any grace/retention policy is explicit. Data required for an accounting audit can be retained without retaining source credentials. No claim of instantaneous erasure from backups or downloaded clients.

## 9. API public seams and subscription revocation

These are proposed operation contracts, not newly published network endpoints. Concrete paths/auth mechanisms are decided during implementation review. HTTP DTOs validate independently of frontend checks. Every operation derives actor/tenant from verified authentication and checks object ownership/role; knowing an ID is never permission.

| Public seam | Input/concurrency | Observable result |
| --- | --- | --- |
| Validate route/profile | Intent revision + exact target + references; no side effects | Typed diagnostics, explicit required capabilities and frozen preview manifest |
| Save draft | Expected revision/CAS | New revision or conflict with recoverable edits; no active deployment change |
| Plan deployment | Approved route/topology revision + frozen target descriptors | Immutable plan, affected routes/users/resources and transition/recovery limitations |
| Execute/cancel/recover deployment | Explicit plan/digest + expected desired generations + idempotency key | Durable operation ID; per-target state/observations; no immediate success claim from enqueue |
| Refresh/accept source | Owner-scoped source and expected accepted snapshot revision | Candidate/failed refresh and redacted diff; acceptance creates immutable snapshot, not an admin upstream |
| Preview/publish client generation | Profile revision, target, access evaluation and resource manifest | Preview or publish result tied to exact revisions; access checked again at publication |
| Fetch subscription/resource | Scoped credential or authenticated owner, artifact/resource identity and current access | Authorized current generation bytes, or explicit denied/stale/unavailable response; no cached unauthorized 304 |
| Rotate/revoke feed | Owner and expected credential revision; idempotent action | Future retrieval denied for old credential, plus explicit independent credential/session consequences |
| Read usage/change multiplier | Authorized subject/cycle, or admin route-policy revision/CAS | Separate raw/weighted/provider totals, unresolved gaps and effective/pending policy version |
| Ingest observations/measurements | Authenticated enrolled scope; unique event/sample IDs | Accepted/deduplicated/quarantined result and durable receipt, not asserted end-to-end truth |

Mutation idempotency key is scoped to actor/operation and bound to request digest; same key plus changed request is a conflict. CAS and idempotency solve different problems. Operations and input manifests persist across restart. Read responses have stable machine-readable error codes/correlation IDs and redacted details. Pagination and filter permissions must not leak private resource existence.

An “accessible subscription link” is a bearer credential, not a public anonymous data file. Recommended feed behavior: authenticate/authorize before conditional caching or content delivery, select only currently eligible immutable generation, and deny or explicitly mark unavailable if no generation satisfies policy. Never silently return a stale revoked generation when regeneration fails. Secret-bearing responses must not be placed in an unauthenticated shared CDN cache. ETag/304 handling must recheck authorization, not bypass it. Avoid leaking bearer paths in referrers, logs or analytics.

Revocation has at least four different scopes: (1) feed retrieval, (2) private rule retrieval, (3) managed entry credentials/new sessions, (4) existing sessions/client caches. Rotating (1) does not automatically accomplish (2)–(4), and never revokes a third-party airport's credentials. State exactly which operations completed and their observed enforcement delay. Files and publicly cached resource bytes already downloaded cannot be recalled. A resource digest proves identity only where a receiving verifier actually checks it; HTTPS and a digest in our manifest do not force clients to reject substituted content.

Publication/retrieval races with entitlement revocation must have a defined authorization linearization point. Recheck current effective access before issuing a generation; reject an ineligible pinned generation rather than trusting its historical access evaluation. Bytes already authorized/in flight at revocation cannot be pulled back; disclose this limit. Credential revocation and affected server reconciliation are separate durable work, with truthful completion status.

## 10. Required counterexamples and expected outcomes

| Counterexample | Contractual outcome | Evidence required later |
| --- | --- | --- |
| Generation 41 starts an asynchronous reload; 42 is accepted; 41 completes late | Serialized mutation lane waits for verified quiescence; never marks 41 as 42. After 42 completes, an old operation cannot reapply under stated assumptions. Unobservable delayed completion blocks the guarantee. | Fault-injection adapter tests plus runtime-specific reload probes |
| One node applies and another is unreachable; rollback also loses contact | Per-target facts remain; aggregate partial/unknown; no successful publication or rollback badge. No silent switch to another exit. | Reconciler crash/network tests and UI task assertion |
| SRS refresh returns HTML, times out or changes digest behind a pin | Reject candidate, preserve permitted accepted version with stale indicator; expired/revoked/integrity-invalid cases block publication. Do not replace with empty/inline rules. | Resource fixtures, digest and expiry tests |
| Regex/classical/nested rule cannot be represented by a chosen file format | `RULE_SEMANTICS_UNSUPPORTED` identifies the exact semantic gap; target blocked. No wildcard/suffix approximation or generic “converted” badge. | Negative capability fixture and target-specific semantic corpus |
| Same 1 GiB user flow passes through FRA and UK; FRA provider counts IN+OUT; route multiplier is 2× | User raw is 1 GiB at its defined entry, weighted quota is 2 GiB, not 4 GiB from two hops. Provider totals are independently measured and labeled; payload bytes need not equal network billed bytes. | Synthetic ledger scenario with explicit metering-layer assumptions |
| User source resolves publicly, then redirects/rebinds to metadata/private IP | Block before any prohibited connection/credential transmission; show redacted fetch failure, not a successful empty source. | Controlled resolver/transport security tests, no live metadata probing |
| User revokes feed URL after downloading config and rule files | New fetches with old credential denied; downloaded bytes remain. Managed credential/session revocation reported separately, third-party credentials unaffected. | Auth/cache race tests and adapter revoke evidence |
| Cumulative sample spans 1× → 2× change or cycle rollover without a boundary sample | Mark interval unresolved; do not fabricate an exact split or double-charge. Conservative admission follows reviewed uncertainty policy. | Accounting replay and boundary fixtures |
| Counter drops from 9000 to 100 after restart with no trustworthy epoch | Quarantine/reset investigation, not negative usage, automatic extra 100, or assumed zero. Known new epoch can resume from a supported baseline. | Reset/restart and out-of-order ingestion fixtures |

## 11. Test, property and bounded-model plan

No tests in this section have been executed by writing this document. Existing prototype test passes do not establish these contracts. Each implementation slice must report passed, failed, unsupported and unrun evidence separately, with pinned tool/runtime versions and fixture digests. Do not use real subscriber secrets or live VPSs.

### Public-seam acceptance

- Route/profile validation and compilation: stable IDs across renames; finite ordered paths; frozen manifests; client compile creates no deployment; mandatory unsupported behavior blocks output; initial two adapters and a constrained synthetic third registration exercise the same contract. A synthetic adapter is not production compatibility evidence. A01–A03, A05, A07–A08, A15.
- Repository/API: real transaction/CAS/idempotency behavior; cross-owner denial through direct requests, not only hidden UI; access changes during generation/fetch; no secret in errors; source refresh failure retains accepted state. A04, A06, A11, A14.
- Native target fixtures: exact supported binaries/config validators and isolated runtime apply/reload/stat/revoke tests. Verify format semantics with allowed/disallowed traffic and DNS cases; native parse-only success is separately labeled. A03, A10, A13, A15.
- UI tasks: admin explains entry/exit/affected users before apply; sees partial/unknown; user imports source, sees multiplier and rule-file resources, chooses manual group, resolves unsupported target, rotates feed and understands copy limits. Keyboard/form alternative, focus, loading/offline/error distinctions and value preservation. A07, A11–A12, A16.
- Source/resource security: IPv4/IPv6, redirect loops, DNS rebinding, credential-bearing cross-origin redirect, private/metadata destinations, oversized/compressed/invalid content, public/private cache separation, conditional retrieval after revocation. A14–A15.

### Properties and metamorphic tests

1. Same frozen manifest + renderer build produces same canonical IR/artifact apart from deliberately separated secret materialization metadata.
2. Rename does not change route path, owner, grants or selected identity; reordering an ordered rule list changes output predictably. Unreferenced inventory changes do not mutate a pinned compilation.
3. No client projection contains a transit credential, secret-store locator or another owner's private source; no rejected resource refresh overwrites accepted content.
4. No accepted lower-generation command overwrites a completed higher generation; same-generation/different-digest always conflicts; a stale observation cannot advance current status.
5. Replay and duplicate measurements do not change total accepted raw or weighted usage. Splitting/coalescing measurements within the same policy/cycle produces equal totals. Out-of-order arrivals eventually agree only when complete compatible evidence exists; missing evidence remains explicitly unresolved.
6. Adding another transit hop does not increase user raw/weighted charge for the same first-entry traffic, but may change provider usage. Policy change never re-rates a prior posted interval. Integer overflow and unsupported multiplier precision are rejected.
7. Counter reset cannot reduce ledger history; cycle rollover cannot erase prior consumption. Late intermediate samples cannot double-post an already covered interval. Cross-policy/cycle uncertainty is never automatically proportional allocation.
8. Resource-file use preserves the semantic corpus for each supported subset. An unsupported corpus case must produce a diagnostic, not merely a syntactically valid target file. Never assert universal semantic equivalence from random test success.

### Bounded state exploration

Model the reconciler with a small finite set of two targets, competing generations, duplicate/reordered commands/observations, crashes at persistence/apply boundaries, and partial rollback. Explicitly encode durable high-water mark, serialized mutation lane, observable/unobservable native completion, and agent re-enrollment. Check safety properties above and conditional liveness only under fair scheduling, eventual connectivity and terminating native operations.

Model accounting with finite samples, epochs, duplicate/out-of-order delivery, a policy boundary and a cycle boundary. Check nonoverlap/dedup, immutable history, weighted-conservation under known attribution and refusal to invent unknown splits. Include negative models: without durable dedup a retry overcharges; without mutation serialization an old native operation can finish after the new one; without route attribution weighted quota cannot be reconstructed.

Record bounds, assumptions, explored state count, tool/version, counterexamples and reproduction commands. This is **bounded model checking / state exploration**, not a full formal proof and not evidence about an unmodeled native core. Larger concurrency, storage failures, external edits and model/implementation correspondence require separate review and testing.

## 12. What is complete, and what still gates coding/release

This document makes the architecture, IR ownership/versioning, capability boundary, rule-file lifecycle, reconciliation truth model, accounting/multiplier proposal, secret/data boundaries and test seams reviewable end to end. It does not settle unspecified upstream capabilities by invention.

Before accepting a release: verify the complete capability register and the engineering seams, including multiplier accounting, the approved first compatibility envelope and each required UI journey. Implementation has already been authorized; this is an acceptance checkpoint, not a reopened permission question. Engineers should research and recommend supported versions, meter/cycle definitions and enforceable freshness/offline bounds; do not ask the user to invent technical thresholds.

Before claiming a release: freeze concrete target/version/evidence descriptors; resolve all required schema references; validate resource/private-delivery semantics; prove sufficient route/user meter attribution through tests; execute runtime/failure/revocation/accounting and access-isolation suites; measure and disclose enforcement limits; independently review security and primary user tasks. If a required capability remains unverified or unsupported, reduce the explicitly approved envelope or remain blocked. Neither this design nor its eventual tests authorize live VPS changes, public publication or renewed GitHub authentication attempts.
