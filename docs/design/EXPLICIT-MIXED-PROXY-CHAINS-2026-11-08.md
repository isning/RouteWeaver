# Explicit mixed proxy chains

## Product contract

A path is an ordered sequence of compatible proxy hops. The final hop is a
position in that sequence, not a different class of object. Managed listeners
and administrator-approved upstream connectors must remain distinguishable:
only managed listeners are deployment targets whose applied revision we observe.

A connector dependency is dialed outside-in. For `managed A → X → Y → managed B`,
A's connector for B has `via: Y`, Y has `via: X`, and X has no `via`. Selecting
only B without recording X and Y is not evidence of the requested path.

## Existing capability and limits

The server renderer already accepts explicit `ServerProgram.Connectors` with
`Via` references and legacy ordered `Egress`. Xray emits `dialerProxy`; sing-box
emits `detour`. Both must preserve the selected order, protocol, destination,
authenticated-principal action and rejection fallback. Declaration order is not
routing order. Unknown references, cycles, duplicate IDs, unsupported protocols
and ambiguous combinations fail the whole render, never produce a partial chain.

The published-route API now accepts explicit typed `hops`, preserving external
proxies between managed listeners or after the last managed listener. The first
hop remains the managed public entry. `endpointIds` and `Path` are only the
managed deployment/observation projection; `Path.Exit` need not be the physical
final proxy. Legacy requests without `hops` retain their managed-only meaning.
The API proves all declared detours instead of weakening the old path checks.

Stock Xray, sing-box and the metered managed-Xray runtime have different verified
capabilities. In particular, managed-Xray connectors accept SOCKS, Shadowsocks
and VLESS TCP with no Vision, REALITY, non-TCP transport or packet wrapper. Chain
composition must not bypass these existing validation and accounting gates.

## Implemented publication contract

- Explicit typed managed/connector hops are part of the published path. Connector IDs
  are scoped to the preceding managed program and reference frozen administrator
  intent, not arbitrary tenant source IDs or supplied connection values.
- Managed endpoint IDs remain the deployment/observation projection. Saved and
  effective summaries compare the complete sequence, including an external final hop.
- Publication proves the entire connector dependency chain and the next managed listener's
  exact dial connection. No conditional forwarding, hidden detour or ambiguous
  match can masquerade as the selected path.
- Every applied managed manifest must agree on the same complete route
  snapshot. A route-only edit must be visible as a pending change even when the
  deployment's program fingerprint is unchanged.
- Complete path intent is preserved on revisions. The API rejects old managed-only edits and
  two-endpoint retargeting when they would omit external hops. Diagnostics which
  cannot represent the mixed path must refuse instead of reporting a wrong exit.

Each hop is either `{ "kind": "managed", "endpointId": "entry" }` or
`{ "kind": "connector", "connectorId": "proxy-a" }`. Connector identity is
scoped to the nearest preceding managed hop. A connector used to dial the next
managed listener is implicit in that managed transition and must uniquely match
the listener's full dial connection and the preceding connector's `via` chain.
The API rejects a mismatched supplied `endpointIds` projection, repeated managed
listeners, repeated connectors in one program, more than 32 managed listeners
or more than 64 total hops. The same connector ID may occur in different programs.

For example, `A → X → Y → B → Z` is represented by managed A, connectors X/Y,
managed B and connector Z. A's connector for B must dial via Y, Y via X, and X
directly. B must actually select Z, with no unrecorded detour. Declaration order
alone never proves the traffic order.

Only managed-Xray ingress can select the route by authenticated principal rather
than by the global fallback. All transit programs must follow the selected
unconditional action. Existing conditional rules or transit principals are not
flattened into a simple path. An empty-principal managed ingress can be prepared
as a draft before principal allocation; it is not a publishable authenticated
service until the normal principal and validation requirements are met.

Pure-managed explicit paths keep their existing edit and retarget behavior.
Existing mixed paths are protected from the legacy managed-only editor and
two-endpoint retarget operation. Complete-path authoring must preserve connector
ownership, capability checks, and any existing principal/policy branches.

## Privacy and authorization

An administrator supplying explicit server connector configuration is separate
from a user's private subscription. This work does not authorize copying that
user's credentials to managed servers, other accounts or shared offerings.
A future source-import flow must identify the source owner, destination and
scope, obtain the required authorization, freeze provenance and connection
material, and retain revocation and update behavior. Source refresh must never
silently change an administrator-published path.

Managed path summaries expose names and stable references. Connector summaries
expose only the stable connector ID and its managed-program scope, not a supplied
connector display name or connection host. Server credentials,
raw connection values and private subscription content do not belong in public
route summaries, generated client entries or diagnostics.

## Evidence boundary

`internal/render/mixed_chain_test.go` exercises the public server-render seam
for current stock Xray, current sing-box and managed-Xray, including shuffled
connector declarations and fail-closed negative cases. These are structural
compilation assertions, not a live external-proxy handshake or deployment claim.
The new native parsing test checks named mixed connector chains with the pinned
stock cores, including reordered declarations. Domain, HTTP API and store tests
exercise complete-hop validation, snapshot agreement, principal selection,
scope isolation, legacy edit refusal and unavailable partial-path diagnostics.

The HTTP publication regression uses the real enrollment, publish, desired-state,
scoped observation and credential-reveal APIs. Its observations are synthetic:
it proves that every managed hop must report the matching applied revision before
public entry credentials become available. It does not prove that a native
process applied that revision or that an external proxy carried traffic.

All exact-source Go checks run in repository CI; the authoring container does not
contain a usable Go compiler. Full-suite quality and actual loopback traffic
evidence remain separate from focused unit, publication and native-parser checks.
No result here asserts that a user's remote server or subscription was deployed.

## Verified checkpoint

At `48db101fc41cedc8f5bfbef53c82dce38080e57a`, the fixed
[focused mixed-path CI run](https://github.com/isning/RouteWeaver/actions/runs/42495815598)
passed exact-source formatting, race-enabled focused domain/render/HTTP/store
regressions, frontend type checking and all 38 tests in the three published-path
DOM suites. The [complete quality run](https://github.com/isning/RouteWeaver/actions/runs/42495815618)
was still in progress when this checkpoint was recorded; it is not described as
an aggregate pass.

The focused run does not execute native binaries. The mixed native-parser test
was initially absent from the parser gate's test selector; the follow-up gate
change explicitly selects it and requires its pass result. Its native result
must be checked separately. Actual isolated mixed-chain traffic tests are a
further acceptance slice, not evidence supplied by this focused run.
