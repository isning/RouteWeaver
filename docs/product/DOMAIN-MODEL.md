# Durable product model and derived representations

Status: proposed details except explicitly confirmed boundaries. This is a product model, not a database schema. Root glossary is vocabulary only. IDs below mean immutable opaque identity, not a mutable name, IP address, URL or list position.

## Object boundaries and lifecycle

| Object / owner | Identity and relationships | Lifecycle and non-negotiable consistency |
| --- | --- | --- |
| VPS Node / admin | node ID; provider/accounting scope; hosts zero or more Core Instances | Draft → enrolled → active/offline → retired. Renaming/readdressing preserves identity; replacing a machine requires an explicit identity/re-enrollment decision. Retiring with live dependencies is blocked until impact reviewed. Provider allowance is not a user quota. |
| Core Instance / admin | instance ID; exactly one VPS Node, core family/version, runtime identity; many Endpoints | Declared → discovered/verified → enabled → disabled/retired; observation can independently be unknown/offline. Multiple families or versions may coexist on one VPS. Family changes are replacement/migration, not casual rename. |
| Endpoint / admin or source provenance | endpoint ID; managed endpoint belongs to one Core Instance; imported endpoint belongs to a source identity track and snapshots, not a VPS Node | Draft → validated → available/disabled → retired for managed endpoints. Connection address, transport, credentials and capabilities are versioned separately from display name. Secrets referenced, not used as names or public identity. |
| Link / admin | link ID; source managed forwarding interface, destination endpoint, direction and forwarding intent | Draft → validated → included in a deployment revision → retired. Graph position is presentation only. A directed edge is not proof of runtime connectivity. No user-owned source may be selected implicitly. |
| Published Route / admin | route ID plus immutable revision; explicit entry, ordered link path, intended exit, supported access conditions | Draft → validated → staged → available/published → suspended → retired. Draft edit never mutates active version. Availability depends on deployment observations; publication and deployment are different operations. Existing grant references route identity and effective approved version policy, not a mutable route name. |
| Service Offering / admin | offering ID plus revision; set of Published Route identities and proposed service limits | Draft → offered → suspended → retired. Free/invite-only is normal. No price, payment or billing object is required. Changed route membership requires impact preview. |
| Entitlement / admin grant to one user | entitlement ID; user, offering/version policy, start/end/status, allowance scope | Scheduled → active → suspended/expired/revoked. No grant emerges from owning a subscription URL. Effective rights intersect account state, entitlement state, route availability and policy. Explicit quotas must not accidentally multiply across overlapping grants. |
| Subscription Source / one user | source ID; secret source location, origin/provenance and refresh policy | Added → fetching → ready/stale/error → paused → deleted. Fetch attempt failure does not overwrite last successful snapshot. Transfer to another user is not a rename. Server-transit approval is not a flag users can grant themselves. |
| Normalized Endpoint Snapshot / source owner | immutable snapshot ID; source ID, retrieval time, parse/normalization version and item identities | Candidate → accepted or rejected; later superseded or expired. Retained snapshots do not imply endpoints remain authorized/usable. Partial parse is surfaced and needs explicit handling; no silent data loss. |
| User Profile / one user | profile ID and revision; references entitled routes or imported endpoint identities; ordered rules/groups/default and naming policy | Draft → validated → published-version reference → archived. Editing a profile never creates admin Links or modifies server intent. One user may have several profiles without new entitlements. |
| Generated Subscription / one user | generation ID; profile revision, entitlement evaluation revision, snapshots, rule resources, renderer/version, target and digest | Preview → valid/blocked → published artifact → stale/revoked. A feed identity/credential points to an eligible generation, not to unbounded server authority. Downloaded copies cannot be recalled. Every fetch rechecks applicable access policy. |
| Deployment / admin | deployment ID; server intent revision, target instance set, desired generations and artifacts | Planned → validated → queued → applying → observed success / partial / failed / unknown → rollback attempt. An artifact is not an observation. Per-target results survive retries. Rollback is a new fenced attempt to known-good intent, not a status edit. |
| Usage Ledger / scoped account/node/user | ledger ID and explicit subject, metric, unit, cycle anchor/timezone, measurement origin/epoch | Append measurements/adjustments, reconcile, close cycle; never rewrite history to reset counters. Deduplicate accepted measurement identity; handle restart epochs and late observations. Provider IN+OUT, route transit and user traffic are distinct accounting scopes. |

Keep these concepts logically distinct even if first storage uses a small number of tables. Do not build one microservice per noun. Account identity/authentication and secret storage are supporting security concerns, not synonyms for User Profile or Entitlement.

## Versioned intermediate representations

**Confirmed user requirement:** explicitly design separate server and client IRs, including routing rules. Prefer file-based rule resources such as SRS rather than expanding their contents into subscription files. This preference does not assert universal SRS support or automatic semantic equivalence.

### ServerDeploymentIR

Derived from an approved administrator topology revision and current explicit deployment targets. Describes concrete managed instances/interfaces, ordered forwarding, server-side policy, credential references, resource references and required runtime behaviors. Carries traceability to route/link versions. It must not contain a user's private airport choices unless a separately authorized upstream workflow has deliberately incorporated a permitted endpoint. A client export never produces this IR or a Deployment as a side effect.

### ClientProfileIR

Derived from one profile revision, effective entitlements, accepted snapshots and rule resources. Describes client-visible proxies, ordered groups and rules, DNS intent, default behavior, manual selections and target-independent policy requirements. It contains only entitled platform entry interfaces, never the platform's internal transit credentials or administrator topology. Selecting a platform route does not recreate its server chain inside the client. It cannot change the server path behind that route.

### Shared semantic primitives, not one universal IR

Share explicit match predicates, rule order, action references, DNS intent, default action and resource provenance. Server/client scopes still own different execution semantics and allowed actions. Define unknown and unsupported semantics explicitly. Do not reduce both IRs to the common denominator of two initial cores. Preserve target-specific supported extensions only within named capability gates; do not call passthrough a portable feature.

See [verified rule-format evidence](RULE-COMPATIBILITY.md) for initial target differences; those facts do not certify cross-format equivalence.

### RuleSetRef: first-class referenced resource

A RuleSetRef has stable identity, immutable revision/version or pinned content digest, source/provenance, format and format version, intended scope, update policy, last successful fetch, authenticity/integrity information, authentication reference, size bounds and semantic/capability requirements. Public source URL is not sufficient identity; private locations and auth material are secret. Profiles reference rule-set identity plus an explicit pin/update policy, not an uncontrolled latest URL.

Proposed lifecycle: declared → retrieved → integrity/format validated → accepted version → cached/distributed → superseded/revoked. A mutable upstream creates a candidate new immutable version and a previewable change; it never rewrites the content behind an allegedly pinned digest. Deduplicate public immutable content only where permission-safe; do not reveal private resource existence across users.

File preference: use external references where the client can fetch the supported format securely, or package an authenticated/pinned file resource when supported. SRS is one target option, not a universal interchange format. Target selection may require another supported binary/text rule-set format. Capability evidence must establish matcher, rule order, DNS and domain/IP interpretation fidelity; syntactically valid conversion alone is insufficient. If exact representation is unavailable, block that target with actionable diagnostics. Inline expansion is allowed only under an explicit profile/export policy the user has approved, with size and semantic impact shown; never silently flatten.

Caching/failure defaults (Proposed): use a last accepted pinned version while still within its declared freshness/security window, mark it stale and show next action. If unavailable, expired, revoked or integrity-failed, block new publication rather than omit the rule or widen access. An existing client may independently cache old files; show this limitation and target-specific refresh behavior. A scheduled fetch policy must respect upstream limits and user authorization. Resource garbage collection waits until no retained/published generation references that version and retention rules permit removal.

Private rule delivery: enforce the same ownership/entitlement checks as the generated artifact; use scoped revocable retrieval authorization where supported, avoid embedding a long-lived source credential into output, and disclose that delivered files are readable by the receiving client. If a target cannot authenticate a private resource safely, block the export or offer an explicitly approved local bundle. Redact secrets in diagnostics; defend resource fetching against SSRF, redirects, oversized content and credential leakage to changed hosts. Server operator visibility follows the confirmed processing model below.

## Compilation, validation and observation

1. Persist versioned product intent, not renderer output as the source of truth.
2. Resolve references and effective access at a defined revision; construct the appropriate IR and input manifest.
3. Check semantic capabilities for the exact core/runtime or client target and version. Distinguish unsupported from unverified.
4. Produce deterministic artifacts/resource manifest and diagnostics; secret-bearing artifacts require restricted handling.
5. For servers, run native validation where supported, then explicitly deploy and observe runtime. For clients, validate target output/resource availability and explicitly publish/export.
6. Retain provenance and versions so later updates can show exact changes and reproduce an outcome. A renamed source does not create a new endpoint; changed credentials may invalidate identity matching and require review.

Server renderers translate ServerDeploymentIR. Runtime adapters validate/apply/observe/control only declared core versions. Client renderers translate ClientProfileIR to independent client target formats. A server core family and a client application's accepted format are not the same contract. Support matrix dimensions include protocol/transport, chaining, rules, DNS, external rule format, validation, stats and revoke/enforcement behavior. No giant generic hook framework is required: prove extension with one constrained adapter contract and negative capability fixture.

## Topology invariants and difficult cases

- Product default: each route revision is a finite ordered simple path. Graph inventory can contain alternative links, but a published path cannot cycle, reference missing endpoints or have ambiguous entry/exit. Protocol compatibility and hop limits are adapter capabilities, not a universal two-hop law.
- Multiple routes may reuse a link or instance. Editing a shared link produces revisions and an affected-route preview; no in-place invisible rewrite of published paths.
- Deleting an in-use node/instance/endpoint/link requires retiring or migrating dependents. Disabling a user does not delete topology or ledger history.
- Platform endpoint credentials are issued/scoped per relevant access policy, not shared indiscriminately through every entitled profile. Effective revocation latency depends on runtime capabilities; do not promise instant revocation of exported credentials.
- A route is not interchangeable merely because exits have the same country label. Repointing exit is a consequential route revision requiring explicit admin publication and visible client-change policy.
- Health means observed evidence at a time, not truth forever. Unknown/offline/stale is not healthy or failed by implication.

## Confirmed privacy boundary and open quota details

Confirmed 2026-10-19: the first release may process private subscriptions server-side with explicit operator visibility. This is a product decision, not permission to retrieve real secrets or expand persistent access.

Encrypted-at-rest private source credentials protect against storage theft, not a server operator who holds decryption capability or can inspect processing. Server-generated normalized snapshots/configs can contain credentials. Do not promise privacy from the operator. An operator-blind client-side mode requires separate fetching, storage, generation, refresh and delivery design and may reduce server-side features; it is not achieved by hiding a UI field.

Quota questions include accounting unit and cycle, user vs provider counting, revocation/exhaustion response, telemetry delay/offline policy and permitted overshoot. Parent-provided conversation context records agreement on the principle of fail-closed with a prompt when quota/route state is uncertain. Never auto-select an alternate exit. Exact thresholds, cycle semantics, stale-observation windows, offline behavior and runtime enforcement delay remain open; the principle is not evidence that production enforcement has been implemented or verified.


## Confirmed quota-multiplier scope and proposed accounting model

The user requested multiplier accounting on 2026-10-19 and confirmed route-level weighted quota, separate actual/provider counts and no monetary payment collection. Proposed technical model: a route-scoped UsagePolicyRevision with a nonnegative exact rational multiplier, effective boundary and immutable identity. An entitlement supplies the user's allowance; an accepted first-entry usage event attributes bytes to user, route and policy epoch. A derived charge journal references the original measurement and policy revision. Raw bytes are never overwritten with weighted bytes; provider IN+OUT has its own scope and is never multiplied. Do not multiply each hop or sum transit measurements as user consumption.

Prospective policy edits require an observable epoch boundary. If the adapter only reports cumulative bytes across multiple routes or cannot segment a transition, do not claim exact route-rate attribution. Specify safe cutover or block the unsupported mode. Rounding must not depend on batch size: retain exact fractional remainder at the documented ledger scope. Corrections are auditable adjustments, not edits to historical measurements. Monetary invoicing and payment remain outside the confirmed scope.
