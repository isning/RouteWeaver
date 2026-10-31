# RouteWeaver first-release product specification

> Scope precedence, 2026-10-19: the earlier narrow first-release scope below is superseded by [the jointly reviewed capability register](CAPABILITY-REGISTER.md) until reconciled. The register confirms the full converter, platform subscription center, admin/cluster operations and maintenance scope, not a prototype-sized MVP. Retain established IR, ownership/security, stable-identity and accounting invariants; do not use this older scope to discard confirmed capabilities. The later eight-item bundle authorizes autonomous engineering refinement and implementation of the full register. Detailed tests remain to be established, not presumed passed; real VPS/account/persistent-credential operations remain separately gated.

Status: review draft. Acceptance statements are proposed release conditions, not evidence of implemented behavior. Refer to the decision map for confirmation sources.

## Problem Statement

The founder operates several VPS resources but needs to offer understandable, controllable routes to a small invited group. A raw list of core-native settings makes it hard to see entry/exit, forwarding relationships, availability, permissions and provider budgets. Users separately hold external airport subscriptions and want one convenient client configuration without surrendering control over preferences or accidentally forwarding those providers through platform VPSs.

## Solution

**Confirmed:** one founder administrator manages shared infrastructure, topology, published routes, users and limits. Invited users manage their own external sources, client-side routing preferences and generated subscriptions. RouteWeaver is itself a connectivity provider plus a convenient subscription converter, not a user-editable shared server mesh. User-owned airports are client-side only by default. Only explicitly administrator-approved upstreams may participate in server transit. The architecture must support more than two core families; Xray and sing-box are initial candidates, not a closed universe.

**Proposed release promise:** an invited user obtains a truthful client configuration combining an entitled FRA-entry → UK-exit platform route and their own imported options, uses ordered rules to route ChatGPT traffic to the FRA → UK group, with a user-controlled manual choice within that group, and can understand what is unavailable without any silent exit substitution. A generated file is not proof that a deployed route works.

### Audience and roles

- Founder administrator: infrastructure, deployment, service offerings, invitations, entitlements, provider accounting and recovery. Also has an ordinary personal user workspace; admin powers do not merge other users' profiles into it.
- Invited user: own sources, own profiles, client export/feed credentials, permitted platform routes and own allowance/status. No infrastructure editing or other user's sources.
- Future service operator: a later role, not an implemented permission matrix. Preserve ownership and grant boundaries now so multiple admins, service tiers and commercial operations can be added without rewriting route identity.

### Known resource inputs

UK ISP VPS: reported 2 TB/month. FRA CN2 VPS: reported 800 GB, IN+OUT counted; cycle remains unconfirmed. LAX VPS: reported unlimited, not a proven absence of fair-use, speed or other constraints. Units, cycle anchors, provider reconciliation and limits must be verified before enforcement. The FRA → UK case describes a platform route; a user's external source is not another VPS resource.

### First usable release and non-goals

Included: invitation/access isolation, inventory with multiple core instances, explicit topology drafts, capability validation, preview/deploy/observed status, published offerings and entitlements, private source import/refresh, profile composition, client-target preview/export/feed rotation, named manual group selections, confirmed route-level weighted traffic allowance, usage visibility and the agreed fail-closed-and-prompt principle with explicitly specified enforcement bounds.

Excluded: public signup, checkout/monetary billing/payments, automated purchasing, reseller accounting, HA control-plane clustering, generic plugin marketplace, universal protocol/client parity, automatic best-exit selection, provider scraping to infer limits, and server transit through user-owned providers without a distinct approved feature. The accepted full register includes optional native advanced editing. Development is now authorized by the later eight-item bundle; real VPS/account/persistent-credential actions remain separately gated.

### Success measures

Proposed usability review: founder can explain entry/exit and affected users before deploying; invited user can import, select and export without encountering server settings; every failed action provides a next step and preserves editable work. Release evidence must demonstrate the journeys below, not merely CRUD screenshots. Performance targets wait for measured fixture sizes rather than invented SLOs.

## User Stories

1. As an administrator, I want to inventory a VPS separately from its proxy services, so that multiple cores do not look like multiple machines.
2. As an administrator, I want versioned capability information, so that unsupported forwarding is rejected before I apply it.
3. As an administrator, I want to link explicit endpoints, so that the traffic path is unambiguous.
4. As an administrator, I want stable route identity across renames, so that subscriptions and grants do not break.
5. As an administrator, I want a graph and equivalent ordered form, so that keyboard use and complex selections remain practical.
6. As an administrator, I want to inspect entry, each hop and exit, so that I do not publish the wrong egress.
7. As an administrator, I want previews to list affected instances and users, so that I understand change impact.
8. As an administrator, I want deployment status per instance, so that partial success is never represented as success.
9. As an administrator, I want recovery to identify known-good revisions, so that rollback is an explicit action rather than a guess.
10. As an administrator, I want to publish a validated, usable route separately from deployment, so that users receive only intended offerings.
11. As an administrator, I want to grant and revoke offerings, so that access is independent of route design.
12. As an administrator, I want to invite and disable users, so that private operation does not require public registration.
13. As an administrator, I want provider usage separate from user usage, so that IN+OUT charging does not silently double a user's quota.
14. As an administrator, I want accounting freshness and cycle definitions visible, so that unknown allowance is not presented as safe capacity.
15. As an invited user, I want to add a private airport source, so that my own connectivity can join my client configuration.
16. As an invited user, I want import errors and unsupported fields explained without exposing secrets, so that I can fix the source safely.
17. As an invited user, I want source refresh to show additions, removals and changed identities, so that my choices are not silently redirected.
18. As an invited user, I want source outages distinguished from an empty valid feed, so that transient failure does not erase my profile.
19. As an invited user, I want to choose among entitled routes and imported options, so that I can compose a personal configuration without changing shared topology.
20. As an invited user, I want a ChatGPT group with an explicit chosen platform route, so that the intended FRA → UK behavior is understandable.
21. As an invited user, I want ordered rules and a visible default action, so that overlaps and unmatched traffic are predictable.
22. As an invited user, I want to name options and preview duplicates, so that the client menu remains usable after refreshes.
23. As an invited user, I want client-specific capability warnings, so that exporting to one format does not silently drop policy.
24. As an invited user, I want to preview the effective configuration and provenance, so that I can see what will change before publishing it.
25. As an invited user, I want to rotate or revoke a subscription feed credential, so that a leaked URL can be invalidated.
26. As an invited user, I want a clear unavailable state for removed grants or endpoints, so that the system never guesses an alternative exit for me.
27. As an invited user, I want to delete a source and understand affected profiles, so that old credentials do not linger invisibly.
28. As either role, I want loading, stale, offline and unknown states distinguished, so that I do not mistake missing observations for health.
29. As either role, I want recoverable failures to preserve drafts, so that I do not repeat input.
30. As a future operator, I want offerings, grants and measurements to exist independently of sales, so that later commercial workflows reuse actual product boundaries.

## Journeys and acceptance traceability

| Acceptance | Stories | Scenario and externally observable result | Basis |
| --- | --- | --- | --- |
| A01 | 1,2,30 | One VPS contains Xray and sing-box instances with separate versions/endpoints; adding a synthetic third adapter does not require redefining the product's core-family vocabulary. | C4 + proposed model |
| A02 | 3–7 | Admin drafts FRA entry → UK exit, renames both nodes and route, then previews: IDs/grants remain stable, ordered path remains identical, deployment/user impact is shown. | C2 + proposal |
| A03 | 2,7–10 | Unsupported capability blocks apply; render-only, native-validated, applied and observed-healthy are distinct. Partial failure shows per-instance outcome and does not publish a usable route. | proposed safety contract |
| A04 | 11,12,19 | User A cannot read user B's source, snapshots, profile, artifacts or bearer feed; UI and direct requests deny admin topology changes; revoked grant disappears from future effective generation. | C1,C2 + proposal |
| A05 | 15–19 | A user's airport is imported only into that user's client profile; generating/downloading it causes no VPS deployment and creates no admin Link. | C2,C3 |
| A06 | 17,18,22,26 | Refresh fixtures exercise unchanged, renamed, duplicate, credential-changed, removed and failed source entries. Stable matches retain choices; ambiguous matches require review; failed refresh retains last good snapshot with stale warning, not empty success. | proposal |
| A07 | 20,21,26 | A profile selects FRA → UK for ChatGPT and a separately selected airport option for other traffic. Preview shows ordered matching and final default; blocked route remains blocked until explicit edit, never silently falls back. | target scenario + proposal |
| A08 | 22–24 | Same profile is previewed for two supported client targets; unsupported mandatory rules prevent publication, duplicate output names receive stable disambiguators, provenance identifies each source version. | C4 + proposal |
| A09 | 13,14,28 | FRA provider IN+OUT and user counters are separately labeled; unknown reset date, stale telemetry, counter reset and retry do not fabricate available capacity or double-count accepted measurements. | resource facts + proposal |
| A10 | 8,9,28 | Two-instance deployment with one offline instance remains partial/unknown; retry is idempotent; newer generation prevents stale overwrite; rollback reports actual observations, not optimistic success. | proposal |
| A11 | 25,27 | Revoked feed credential cannot fetch new output; source deletion warns of dependent profiles, removes live secret access and invalidates future generation using it; already exported client copies are explicitly not recallable. | proposal |
| A12 | 5,28,29 | Core journeys work by keyboard/form alternative, labels/focus and error association are present, mobile narrow view is usable, failures retain values, and no critical status relies on color alone. | user UX preference + proposal |
| A13 | 11–14,26 | Tests demonstrate the approved exhaustion/revocation behavior, reporting maximum enforcement delay under stated runtime conditions; no production strict-limit claim while the policy or telemetry evidence is missing. | open quota decision |
| A14 | 15,16,24 | Source fetch blocks local/private/metadata destinations including redirects and resolution changes; size/time limits and malformed-content handling hold; logs, preview and errors redact source credentials. | proposed security gate |

## Implementation Decisions

**Confirmed constraints:** multi-core extension, mature frameworks, separation of administrator topology from user composition, default client-side external airports. Go/Rust is a preference. The earlier stack ADR is historical engineering context; the later eight-item bundle supplies development authorization, not blanket ratification of earlier stack assumptions.

**Proposed boundaries:** intent is the durable source of truth; server rendering, runtime operations and client rendering have independent version/capability contracts. Generated configuration is derived and traceable, never the editable authoritative object. Initial implementation should be a modular control plane with a thin agent, avoiding distributed services and empty extension frameworks. Service Offering, Entitlement and Usage Ledger are useful now for grants and visibility, not hypothetical billing machinery. Detailed lifecycles and contracts are in the domain model. No new architectural ADR is declared accepted here.

## Testing Decisions

These test seams are historical proposals to refine under the authorized engineering work; major product trade-offs still require user review. Highest seam: user-visible route-to-entitled-client-config journey through the application API, with real persisted ownership/revisions, deterministic synthetic feeds and actual supported core/client validators where available. Add only lower seams needed to explain failure: shared renderer capability contract, deployment lifecycle/observations and ledger reconciliation properties. UI tests cover complete tasks and keyboard behavior, not component internals.

Prior art exists in exploratory route validation, renderer registry, persistence, HTTP and UI route-model tests. Reuse fixtures/test patterns only after checking them against the product model; their two-hop/Node assumptions are not a contract. The existing tests do not establish deployment, tenant security, source ingestion or real-core parity. Required CI/harness reports passed, unsupported and unrun checks separately. Small bounded state models for generation fencing and idempotent accounting are proportionate evidence, not a claim of full formal correctness. Never use live subscriber secrets or live VPSs in acceptance tests.

## Out of Scope

See release non-goals above. Historical planning exclusions no longer block authorized engineering development. Live production deployment and external account/persistent-credential actions remain separately gated; local ticket drafts are not published issues.

## Further Notes

The privacy model was confirmed on 2026-10-19: server-side private-source processing with explicit operator visibility. This approves the product model, not importing actual credentials or bypassing action-time security approvals. Exact enforcement bounds and the supported first-release compatibility envelope remain unresolved release gates. A product review can continue without inventing their answers. Inspect the decision map for the smallest next conversation; show UI alternatives before claiming the primary flow is reviewed.

## Rule-resource requirement addendum

**Confirmed:** design ServerDeploymentIR and ClientProfileIR separately; support routing rules while preferring referenced/packaged rule files such as SRS, not flattened subscription contents. The domain model specifies the proposed contract and failure behavior.

31. As either role, I want rule sets represented as versioned resources in the appropriate server or client intent, so that policy remains maintainable without bloated inline exports.
32. As a user, I want client compatibility and private rule delivery checked before publication, so that a file preference never silently weakens my routing or leaks credentials.
33. As either role, I want pinned versions, refresh differences and failed resource fetches visible, so that upstream changes do not silently alter policy.

A15 (stories 21,23,24,31–33; confirmed C6 + proposed details): the same policy produces separate server/client IR manifests with RuleSetRefs; supported targets reference or package rule files, unsupported SRS targets either use a demonstrably equivalent supported resource format or block with diagnostics. No silent inlining is allowed. Tests preserve order, DNS intent, defaults and failure behavior, verify pin/digest/cache expiry, rejected unsafe fetch, authenticated private delivery and credential redaction. No automatic format conversion is presumed semantically lossless.


## Requested multiplier accounting (2026-10-19)

User explicitly requests “倍率计费”. Inclusion and weighted-quota rather than monetary-charging interpretation were confirmed by the user’s “是的” on 2026-10-19 (Sentinel_1031ed7a803c8191903abab89793e9da). Confirmed product behavior: each published route has an explicit versioned allowance multiplier; first-entry raw upload plus download is charged once using that policy, regardless of hops. Actual bytes, weighted allowance debit and provider IN+OUT are distinct quantities. UI shows multiplier before use and actual-versus-charged usage afterward. Policy edits are prospective, never silently recompute history. No payment integration is included. Exact arithmetic, telemetry attribution and transition mechanics remain proposed until verified.

A16 (proposed acceptance): a synthetic route consumes 1 GB of raw user traffic under 2× and debits 2 GB of allowance; adding a relay does not debit again. Replayed measurements have no additional effect. Tests cover fractional and zero rates if supported, exact rounding/carry rules, epoch resets, late batches and policy changes. If telemetry cannot attribute a user to a route or split a policy transition accurately, that charging mode is unavailable rather than estimated as exact. Provider counters remain unweighted. Users see which values are measured, derived, delayed or unavailable.
