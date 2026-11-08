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

The published-route API currently proves a sequence of managed endpoint IDs.
It rejects hidden detours and requires a direct terminal program. Those guards
must remain until an explicit mixed path can account for every connector. Merely
relaxing the UI or renderer does not establish publication or application support.

Stock Xray, sing-box and the metered managed-Xray runtime have different verified
capabilities. In particular, managed-Xray connectors accept SOCKS, Shadowsocks
and VLESS TCP with no Vision, REALITY, non-TCP transport or packet wrapper. Chain
composition must not bypass these existing validation and accounting gates.

## Next implementation slice

- Add explicit typed managed/connector hops to the published path. Connector IDs
  are scoped to the preceding managed program and reference frozen administrator
  intent, not arbitrary tenant source IDs or supplied connection values.
- Keep managed endpoint IDs as the deployment/observation projection, but display
  and compare the complete sequence, including an external final hop.
- Prove the entire connector dependency chain and the next managed listener's
  exact dial connection. No conditional forwarding, hidden detour or ambiguous
  match can masquerade as the selected path.
- Require every applied managed manifest to agree on the same complete route
  snapshot. A route-only edit must be visible as a pending change even when the
  deployment's program fingerprint is unchanged.
- Preserve complete path intent on revisions. Reject old managed-only edits and
  two-endpoint retargeting when they would omit external hops. Diagnostics which
  cannot represent the mixed path must refuse instead of reporting a wrong exit.

## Privacy and authorization

An administrator supplying explicit server connector configuration is separate
from a user's private subscription. This work does not authorize copying that
user's credentials to managed servers, other accounts or shared offerings.
A future source-import flow must identify the source owner, destination and
scope, obtain the required authorization, freeze provenance and connection
material, and retain revocation and update behavior. Source refresh must never
silently change an administrator-published path.

Path summaries expose names and stable references only. Server credentials,
raw connection values and private subscription content do not belong in public
route summaries, generated client entries or diagnostics.

## Evidence boundary

`internal/render/mixed_chain_test.go` exercises the public server-render seam
for current stock Xray, current sing-box and managed-Xray, including shuffled
connector declarations and fail-closed negative cases. These are structural
compilation assertions, not a live external-proxy handshake or deployment claim.
The existing native server fixtures additionally parse ordered proxy chains with
the pinned cores. New checks are executed by the repository CI; the authoring
container does not contain a usable Go compiler. Application behavior remains a
separate proof from rendering and native parsing.
