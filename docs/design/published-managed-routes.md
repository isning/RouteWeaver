# Published managed routes and authenticated principals

## Intent and ownership

A `PublishedRoute` is a stable service-facing ID over an ordered path of registered managed endpoints and a server deployment. It is not a legacy client `Route`, and no legacy chain is cloned to create an entitlement. The administrator supplies ordered endpoint IDs; preview resolves real inventory and verifies actual forwarding. Generated link identities derive from endpoint pairs, not names. One endpoint is a valid direct path.

`ServerProgram.Listener` owns bind address, protocol, security and transport. Explicit `authentication: "principals"` means a credential-free listener; `ServerProgram.Principals` owns authenticated UUID/flow and opaque subject → account/route/credential-version mappings. Legacy listener authentication and principal credentials cannot coexist. Duplicate native credentials and subjects fail closed. Authentication identity is never supplied by the client as an account label.

Xray v26.3.27 uses the opaque subject in VLESS `clients[].email`; sing-box v1.14.3 uses `users[].name`. Their principal-specific rules select the declared route action. Neither stock adapter advertises managed account enforcement. The distinct `routeweaver/managed-xray@26.3.27-rw1` adapter emits standard native JSON plus a credential-free `entry-policy.json`; its tested public path is VLESS raw TCP with no security or TLS, not Vision, REALITY, fallback inbounds or arbitrary transport wrappers.

## Administrator workflow

- `POST /api/published-routes/preview`, `POST /api/published-routes`, `PUT /api/published-routes/{id}` accept `id`, `name`, `deploymentId`, ordered `endpointIds`, `publicHost` and `publicPort`.
- `GET /api/published-routes` and `GET /api/published-routes/{id}/resolve` return safe path IDs, public address, readiness and fingerprint. No transit authentication is returned. `pendingChanges` distinguishes the current draft from a still-available applied route; `savedPath.hops` projects endpoint IDs and names from the saved deployment program snapshots. `effective` contains the frozen applied public address, endpoint IDs, fingerprint and `path.hops` names from the same fully verified per-hop manifests. Each hop exposes only `endpointId`, optional `name`, and `metadataState` (`snapshot` or `unavailable`); missing or ambiguous saved metadata retains identity without a catalog guess. Current catalog rename/deletion never rewrites these snapshot labels. No connector, credential or server TLS material enters either path summary. The current draft address is never presented as the applied address.
- A service's `routeIds` references real published route IDs. Overview labels distinguish managed server paths from the retained explicit legacy client-chain workflow.
- `POST /api/published-routes/{id}/principals` accepts `accountId`, a fresh `credentialVersion`, optional stable grant `entryId`, and optional `credential: {uuid, flow}`. An omitted UUID is generated locally. This writes a pending credential, not effective access.
- Provisioning atomically fences and writes the deployment, inventory listener, grant, credential-version tombstone, admission binding and observation-only meter binding. Rotating uses the same entry ID and a new version; previously used versions cannot revive.
- Existing administrator entry reveal and user profile resolution require the effective manifest. Tenant callers cannot modify topology or another account's entries. Legacy entry writes cannot replace managed grants.

## Queued, observed and effective are different

Publication pins one immutable `PublishedManifest` per exact desired identity, including instance/enrollment, generation, revision, operation and artifact digest. It contains the frozen program and published route snapshots. A saved draft or successful render never activates credentials.

Effective resolution requires a known, quiescent (no in-flight application), native-checked observed identity matching that manifest, and a current unrevoked enrollment. Every frozen path endpoint must be observed with the same deployment fingerprint. The opaque subject, account, route and credential version must match the applied principal, and the projected public credential must match the grant. A different operation, partial path application, replaced enrollment or newly saved version cannot borrow prior evidence.

Mutable compatible drafts do not overwrite the last effective snapshot. Public credentials come only from that frozen entry's public address/security and this user's principal. Connector credentials and server TLS private material cannot enter the projection.

## TLS and destination policy

Public DNS names and public IP VLESS entries require TLS. Unencrypted entries are accepted only for an explicit private or loopback IP, not a DNS name that happens to resolve internally.

`ServerProgram.TLS` can contain `certificatePem` and `privateKeyPem` with declared safe relative `certificatePath`/`keyPath`. The renderer validates their pair, rejects path collisions/traversal, and packages both files. Publication rejects dangling TLS references, expired or not-yet-valid packaged leaf/chain certificates, inconsistent supplied chains, and certificates that do not cover explicit client/connector server names (or the published public host when no server name is supplied). Draft staging remains possible. These checks use only the supplied certificate material and do not assert universal public trust or change operating-system roots; deliberate private issuers remain supported. Fleet configure/start/rollback/upgrade uses the same publication gate and rechecks before queueing. This is publication-time and queued-execution-time evidence, not continuous certificate-lifetime monitoring after application. Trusted adapter code binds Xray’s certificate and asset resource roots to the verified staged revision for both native checks and process launch; relative PEM paths do not accidentally resolve beside the core executable. It never reads arbitrary control-plane or node filesystem paths. Preview redacts private material.

A managed program's optional `destinationPolicy.allowCidrs` grants explicit destination exceptions. Missing policy means private/special final targets are denied. Connector dial addresses are a separate administrator intent, not user destinations. The managed runtime owns resolution and enforcement; stock adapters reject this policy instead of claiming DNS-rebinding safety from an unproved native rule. Synthetic managed loopback fixtures explicitly allow `127.0.0.1/32`.

## Finite quota enforcement

Managed entry admission atomically reserves account-wide, route-weighted byte budgets before forwarding payload. Both upload and download share a presence ceiling, and all entries share the account pool. Final settlement enters the canonical ledger once; native snapshots are observation-only and cannot double debit. Unresolved reservation loss remains an accounting hold, not an inferred refund.

The native HTTP fixture provisions the same finite-quota account on two separate managed ingress processes, with one route requiring a stock SOCKS transit and the second ingress using a CP-packaged TLS certificate for a public DNS hostname. A synthetic CA is trusted only by that test client; an untrusted handshake fails without disabling validation. Eight concurrent oversized payloads compete for a 4,096-byte remaining combined budget. The assertions count actual bytes at the destination and client, require no excess payload, and require the exact exhausted ledger. This test exposed a stale request-time/serialized settlement race; the control-plane regression and fix include all committed current-cycle ledger entries when reserving more bytes.

## Verification seams

- `internal/domain/published_routes_test.go`: public TLS requirement and explicit bounded destination exceptions.
- `internal/render/principals_test.go`: split authentication, unique identities, private sidecar and distinct managed capability.
- `internal/render/principals_native_test.go`: both pinned native parsers accept generated two-principal VLESS configurations.
- `internal/render/server_tls_test.go`: matching PEM packaging and collision/traversal/mismatched-key rejection.
- `internal/httpapi/published_routes_test.go`: real route → service entitlement → two principal drafts → queued identity → scoped observed identity → effective own credential; wildcard next-hop listeners dial only their registered host address; pending reveal, cross-account access, stale operation and retired versions fail closed; draft public-address edits preserve applied credential.
- `internal/integration/principals_test.go`: stock IR → native validation → owned process → two users sharing a VLESS socket; direct versus mandatory transit routing and unknown UUID rejection. Managed variant adds private broker/sidecar and targeted account revoke isolation; it uses private inherited pipes and requires explicit managed-binary/process opt-in. A host denial is not a pass.

- `internal/httpapi/published_native_test.go`: `TestNativePublishedManagedPrincipalEndToEnd` exercises actual administrative provisioning, finite service entitlement, exact queued/applied identity, scoped HTTP admission, private inherited-pipe IPC, two real managed ingress processes, mandatory native transit, packaged TLS with scoped certificate trust, shared finite ceiling, and exact canonical byte settlement. No synthetic admission authority is used in this test. Executables are copied into immutable per-test paths to avoid shared build replacement changing owned process identity.

Reference grammar: [Xray VLESS inbound](https://xtls.github.io/en/config/inbounds/vless.html), [sing-box VLESS inbound](https://sing-box.sagernet.org/configuration/inbound/vless/), [sing-box route rules](https://sing-box.sagernet.org/configuration/route/rule/). Current online docs can differ from pinned releases; executable native checks are version-specific evidence, not production deployment evidence.

## Saved versus confirmed path presentation (2026-10-23)

The route detail compares ordered endpoint identities, using each snapshot’s names. Changed paths show separate saved and confirmed sequences; identical sequences remain concise without implying all configuration is equal or applied. Colliding names and missing metadata expose endpoint IDs. No confirmed path is invented when full applied proof is absent. The existing check/apply navigation remains a separate explicit action; saving a draft never performs it.

This bounded read-model follows the project content-design rules (state and consequence at the relevant task) and public-seam tests informed by mattpocock/skills TDD/codebase-design at `49dd158d1076134a641b33efb035946536778336`. It is project synthesis, not certification. Local HTTP fixtures prove frozen-name projection and rejection of incomplete/recovery proof; synthetic UI fixtures prove presentation. Neither is native forwarding or deployed-traffic evidence.
