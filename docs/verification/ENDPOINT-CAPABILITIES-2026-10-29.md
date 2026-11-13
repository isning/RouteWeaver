# WIP47 endpoint contracts — 2026-10-29

Backend implementation evidence, not product parity or live-network certification. UI, final integrated checks and owner-private demo delivery are separately coordinated.

## Implemented matrix

Exact versions: Mihomo 1.19.32 client, sing-box 1.14.3 client/server, Xray 26.3.27 generic server. Generic server means listener plus outbound connectors; it is not the separately metered managed-Xray runtime.

| Protocol | Authentication | Security | Transports | Roles |
| --- | --- | --- | --- | --- |
| SOCKS5 | optional client username/password, authenticated listener | no added TLS wrapper | TCP | existing generic clients/server |
| Shadowsocks | password + three existing AEAD methods | existing protocol cipher | native | existing generic clients/server |
| VLESS | UUID | none, TLS, existing REALITY | TCP, WS, HTTPUpgrade, gRPC | existing generic clients/server |
| Trojan | password | ordinary TLS required | TCP, WS, HTTPUpgrade, gRPC | generic clients/server |
| VMess AEAD | UUID, alterId=0 | optional ordinary TLS, no REALITY/flow | TCP, WS, HTTPUpgrade, gRPC | generic clients/server |

VMess `vmessSecurity` accepts auto (default), aes-128-gcm, chacha20-poly1305, none, zero. The latter two disable VMess payload encryption; TLS remains a separate layer. This parameter is an outbound choice. Listener accepts empty/auto only and rejects custom cipher instead of implying server-side enforcement. Legacy alterId>0 and unknown security values reject import. No arbitrary raw JSON pass-through was added.

New `transport.headers: Record<string,string>` supports WS and HTTPUpgrade **client/outbound request headers only**. Listener inventory, principal projection, server registry and direct generic/managed adapters reject nonempty maps with `HEADERS_OUTBOUND_ONLY`; they cannot be silently reused as server response/enforcement settings. Host remains the separate `transport.host` field; conflicting Host map entries, duplicate case-insensitive names, malformed tokens, controls/CRLF, >32 entries or >8192 bytes reject. Core-owned Connection, Upgrade, Sec-WebSocket-Key/Version/Extensions, Content-Length, Transfer-Encoding and Trailer reject case-insensitively rather than being overwritten by native transports. Authorization, Cookie, X-* and supported Sec-WebSocket-Protocol survive roundtrip. `transport.authority` is gRPC-only and supported by generic Xray outbound/legacy client dial roles only; listener role rejects it because pinned Xray only reads it in the dialer. sing-box and Mihomo targets reject it explicitly. Existing server listener fields also form the published-client template: SNI/fingerprint and applicable packet encoding remain client hints, not listener enforcement. sing-box WebSocket Host remains a client dial hint and is omitted from inbound native configuration while retained in connectors/public projection; the UI must not claim that this listener enforces Host. server-side certificate/private-key paths remain separate `ServerProgram.TLS` data.

Listener HTTP paths use an explicit portable pathname contract: no query, fragment or percent escapes; WebSocket additionally requires URI-safe characters without escaping. This avoids differences between native `URL.Path`, escaped `RequestURI` and URI-string handling. It is not a claim that every native core rejects these values: Xray HTTPUpgrade can match a literal escaped path, while sing-box WebSocket has an extra raw RequestURI-prefix check. HTTPUpgrade decoded Unicode/space path validation remains allowed; the loopback fixture uses ordinary ASCII paths. Outbound request-URL handling is unchanged, and invalid listener values are rejected, never stripped.

Existing packetEncoding values remain explicit typed choices; Xray outbound and managed targets continue rejecting unverified wrappers. Existing REALITY pairing validates private/public key, accepted short IDs and handshake names. sing-box allows exactly one REALITY server name. Managed Xray keeps its existing VLESS/TCP/none-or-ordinary-TLS envelope and metering controls; Trojan/VMess/non-TCP/REALITY/Vision were not enabled there.

## Import, privacy and preservation

- Fixed Mihomo HTTPUpgrade native import: WS with `v2ray-http-upgrade: true` round-trips as HTTPUpgrade rather than failing or changing protocol.
- Trojan URI and VMess v2rayN version-2 base64 JSON share-link subsets supported, plus native Mihomo/sing-box extraction. Unsupported behavior-bearing fields fail; full-config extraction warnings remain.
- Rendered native roundtrip covers four transports, Trojan and five VMess security modes.
- Header maps are deep-cloned through processing; stage previews and ordinary server summaries remove them. Explicit authorized admin reveal preserves them. Source/output label sanitization and optional native-node inspection include header values as protected strings.
- Native node inspection and semantic fingerprints include new protocol, security and header settings. VMess security is categorized as protocol options, SNI as security. Legacy `domain.Node` / admin connection-endpoint editing uses the same flattened fields and `ConnectionValue` adapter; existing IDs/routes persist without migration. Store serialization and source identity matching use complete connection JSON, retaining the typed extensions without exported credential-derived identities.
- Public publication remains principal-scoped VLESS; generic new protocols do not unlock principal provisioning, billing or managed route publication.

## Executed checks

- Failing-before/passing-after: HTTPUpgrade import, typed headers validation, header client roundtrip, authority unsupported-target rejection, preview header privacy/cloning; new Trojan/VMess render/import tests initially failed absent protocol support; VMess share-link test failed before implementation. Reserved handshake/framing-header tests failed with nine accepted forbidden names before the validation fix, then passed.
- `scripts/go.sh test ./internal/domain ./internal/importer ./internal/render ./internal/conversion -count=1`: pass.
- Focused HTTP source/output and server summary/reveal privacy regressions: pass.
- Real pinned parser checks: Trojan 16 cases (4 transports ×4 target roles); VMess 96 cases (5 security modes with TLS, plus auto without TLS, ×4 transports ×4 target roles), total 112. Listener headers remain empty; egress request headers remain populated. Xray checks use the staging agent's certificate-location environment. These invoke only `-t`, `check`, or `run -test`; they do not launch proxy traffic or deploy infrastructure.
- Official Go 1.27.2 and all three pinned native binaries recovered with existing checksum-verifying bootstrap scripts. `/usr/bin/go` was not used as a compiler.
- Independent post-fix domain/importer/render/conversion and all 112 parser checks passed; role semantics were additionally reviewed against pinned runtime handlers, not only JSON schemas.
- Final affected package race tests and HTTP inventory/save/preview/redaction regressions passed. `scripts/native-cores.sh parsers` passes its complete required set; new Trojan/VMess matrices are now mandatory in that gate.
- Actual Xray localhost handshakes and payload echo pass for Trojan and VMess × four transports. Each case then closes the first client, stops the exit process and requires a fresh attempt to fail while echo remains live, excluding accidental direct fallback. Trojan uses an ephemeral test CA only in the supervised children's SSL_CERT_FILE, with normal certificate/hostname verification, no allowInsecure and no host trust-store changes. This does not prove remote network behavior, arbitrary headers on wire, or metered-runtime support for these protocols.
- Canonical Xray-only local runtime gate passes; sing-box process startup is deliberately not requested because the known netlink restriction is not bypassed. sing-box parser checks did run.
- Main-module full race+vet passed before final role corrections. Managed-runtime unit race+vet passed. A fresh final-source full main race/vet/build and managed vet/race/build is running against the release-candidate freeze below; completion is not inferred from earlier checks. UI/final deployment gates remain separately coordinated.

## Remaining boundary

Not blanket 3x-ui/s-ui parity. Hysteria2, TUIC, XHTTP, VMess legacy alter IDs, arbitrary inbound fallback/sniffing/multiplex/socket settings, and multi-inbound instance lifecycle are not implemented by this slice. Unsupported choices must not appear as working portable form controls. A native parser accepting a fixture does not prove remote connectivity, traffic metering, certificate trust, mobile interoperability, or real deployment readiness.

## Primary references

- https://sing-box.sagernet.org/configuration/shared/v2ray-transport/
- https://sing-box.sagernet.org/configuration/outbound/trojan/
- https://sing-box.sagernet.org/configuration/outbound/vmess/
- https://wiki.metacubex.one/en/config/proxies/trojan/
- https://wiki.metacubex.one/en/config/proxies/vmess/
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/infra/conf/grpc.go
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/infra/conf/vmess.go
- https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link

## Broad regression recovery log

Initial `go test -race ./...` discovered that the recovered compiler under `bin/toolchain/go/test` was traversed as application packages. Its upstream compiler-negative fixtures intentionally fail compilation. `scripts/bootstrap-go.sh` now writes an installation-local nested module boundary at ignored `bin/toolchain/go.mod`; all actual product packages remain in `./...`. The original failure log remains `/tmp/wip47-backend-race.log`.

A clean rerun briefly overlapped the still-running failed-setup process; a backup race test was resource-killed. Both were explicitly interrupted and terminal exit 130 confirmed. Neither attempt is counted as a pass. A subsequent package-serialized run was interrupted before restarting with the coordinator-requested `GOMEMLIMIT=768MiB`. The next attempt was explicitly interrupted (exit 130) after discovering the repository harness already requires `-timeout=20m`: historical unchanged backup-race evidence takes 985.518s for the default 40000-row workload. That exact resource-bounded main race+vet attempt completed successfully: backup 580.490s, HTTP 700.989s, store 168.813s, all packages passing. Its raw evidence is `wip47/backend-race.prefinal.log` and `backend-vet.prefinal.log`; it precedes the final role/header/path corrections. This uses the established timeout, not a reduced fixture or relaxed assertion. Native runtime environment variables remain unset in broad unit regression; exact parser fixtures were separately executed, and unsupported live runtime stages are not inferred passed.

Pinned gRPC role evidence: `transport/internet/grpc/dial.go` reads Authority through grpc.WithAuthority; `hub.go` does not enforce it. Listener controls therefore reject it rather than relying on parser acceptance.

Backend freeze manifest: `wip47/backend-freeze.sha256` (SHA-256 `1e470212066ff88ed183230fed13ee18f92c6b21a11d66fff3911e9c1841c022`), recorded at 15:00 UTC. The run began at 14:59:26 UTC; one authority ASCII/control/length validation edit landed between start and freeze. Therefore the broad run is explicitly intermediate for `internal/domain/profile_validation.go`; final affected-package verification subsequently passed (`wip47/backend-postfix-focused.log`, `backend-postfix-http.log`). No backend edits during the freeze. UI-only work may continue independently.

## Final source binding

Release-candidate freeze began 15:43 UTC: `wip47/backend-release-candidate.sha256`, digest `3a405c70031196c972e9a8902b6d0508461e49631654c7302d56787ebcb229da`. It includes root Go dependency files plus internal/cmd/runtime/script sources; UI and evidence documents are outside this backend freeze. Main-module final race uses GOMAXPROCS=2, GOMEMLIMIT=768MiB, `-race -p=1 -count=1 -timeout=20m ./...`, followed by vet/build and the managed module's vet/race/build. Final terminal result and manifest-after-check will be recorded here; backend source must not change while this runs.

Further pinned role references:
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/transport/internet/grpc/dial.go
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/transport/internet/grpc/hub.go
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/transport/internet/websocket/hub.go
- https://raw.githubusercontent.com/XTLS/Xray-core/v26.3.27/transport/internet/httpupgrade/dialer.go
- https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.3/transport/v2raywebsocket/server.go
- https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.3/transport/v2rayhttpupgrade/server.go
- https://raw.githubusercontent.com/SagerNet/sing/0ad23b637bd4/protocol/http/link.go

The listener-header defect was confirmed as ignored/wrong-role configuration. A credential response echo was initially considered a risk but was **not demonstrated** by the exact pinned handlers; no post-deployment incident is claimed.

The 15:43 candidate broad attempt found a second generated-artifact traversal issue after managed-runtime dependencies were downloaded: a legacy dependency without its own go.mod under `bin/cache/go-mod` was discovered by `./...`. It failed setup and was explicitly interrupted (exit 130), not counted as passing. `scripts/go.sh` now establishes the ignored `bin/go.mod` module boundary for all generated compiler/cache artifacts. A clean `go list ./...` preflight enumerated all 24 actual main-module repository packages; no product test was excluded. See `wip47/backend-release-cache-boundary-failed.log`.

The superseding **final backend freeze** is `wip47/backend-release-final.sha256`, digest `676847a6bf89eb3c0207b1c98b3d7f91532cf004034599a1d2bd7ed839203867`, 15:47 UTC. Its serial verification runs shell syntax, main vet/race/build, managed vet/race/build and an after-manifest check. The main race retains all default workloads with `-race -p=1 -count=1 -timeout=20m`, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. Result remains pending until terminal. The final Xray-only canonical runtime gate (including eight positive plus exit-stopped negative protocol cases) already passed; `wip47/xray-runtime-gate.log` records its allowed sing-box-not-requested skip distinctly.


## Consolidated target-parity correction

The 15:47 freeze completed **main vet/race/build and managed vet/race/build successfully**, with exact after-manifest match (backup 554.596s, HTTP 673.210s, store 163.083s, managed race 12.541s). Its evidence is retained as `wip47/backend-preparity-race.log` and related pre-parity logs. It is not counted as final-source acceptance after the following correction.

A complete legacy/generic/direct field audit (`wip47/endpoint-target-parity-audit.md`) found legacy Xray could omit REALITY ALPN semantics, and direct adapters did not consistently apply registry-only target checks. The shared outbound target validator now applies domain contracts, Xray explicit-packet/REALITY-ALPN guards, pinned Xray REALITY transport restrictions (TCP/gRPC among modeled transports), and existing M/S authority/fingerprint capability checks at all corresponding seams. Unknown Xray native fingerprints remain native validation errors; legitimate version-specific names are not artificially narrowed. Direct server methods retain their normalized-program contract.

Inventory/direct listener validation now rejects non-auto VMess cipher choices as outbound-only. The direct managed adapter independently enforces its existing SOCKS/SS/VLESS egress protocol allowlist. Neither change enables new managed capabilities. Xray listeners also reject explicit REALITY ALPN and incompatible transport, while ordinary TLS ALPN and intentional client-template SNI/fingerprint/packet fields retain their established roles.

New parity regressions failed before these fixes and pass after, including valid exact field preservation. Full domain/render/importer/conversion package race passes on the correction. Pinned parser/runtime gates and the final consolidated-source broad gate are being recorded separately; no pass is inferred until terminal.

The consolidated target-parity source is now frozen at 16:19 UTC: `wip47/backend-parity-final.sha256`, SHA-256 `2271b511a690e7593dd6a318ba92bbe4bc531f5303b0fda8143022079df293ab`. Its full focused domain/render/importer/conversion race, exact three HTTP legacy/inventory/reveal race regressions, complete canonical native parser gate and Xray-only runtime gate all pass. Architecture negative fixtures/production import guard, Go formatting and ticket render/check also pass. Evidence: `target-parity-focused.log`, `target-parity-http.log`, `native-parity-parser-gate.log`, `native-parity-xray-runtime-gate.log`, `target-parity-architecture.log`, `target-parity-format.log` under `wip47/`. The coordinator owns the final global `scripts/verify.sh quick` after global UI/backend freeze; no redundant standalone aggregate was started. Until that terminal result, previous broad acceptance remains explicitly pre-parity.

## Evidence availability and superseding gate (2026-10-29)

Raw runner logs named above are retained locally, not included as archive attachments. Their hashes and sizes are in `CHECKPOINT-EVIDENCE/WIP47/local-evidence-index.json` (relative to the repository root). Public scoped receipts retain the results and limitations. Earlier “pending” paragraphs describe the named historical attempts, not the latest state.

The later global `scripts/verify.sh quick` R2 passed every Go and managed-runtime vet/race/build stage, all preceding static guards, and frontend typecheck on an unchanged 1,355-file source manifest. It then failed two frontend behavior tests (1,783 passed, 2 failed out of 1,785); production frontend build was not reached. Backend acceptance is retained only for unchanged backend source. The subsequent repaired frontend passed all 1,796 tests, typecheck and production build on unchanged source. A final 542-file backend/API scope comparison found no changes. Acceptance is a repaired modular aggregate, not a relabeling of the failed quick run. See `CHECKPOINT-EVIDENCE/WIP47/quick-r2.failed.json` and `docs/verification/WIP47-FINAL.md`.


## 2026-11-13: direct Hysteria2 slice

Hysteria2 now has typed password/TLS endpoint data, share-link and sing-box import,
sing-box client 1.14.3 output, and ordinary sing-box server 1.14.3/1.14.4
listener and connector output. The earlier "not implemented" statement above
refers to the October slice, not this increment. The UI and inventory API reject
unsupported server targets. Xray, managed-Xray and Mihomo output remain unsupported
for this protocol in RouteWeaver; this is not a claim about all upstream versions.

Only direct Hysteria2 connections are supported. Either side of a connector
`via` relationship using Hysteria2, and legacy multi-hop chains containing it,
are rejected. TLS and password are required; ALPN may be omitted or `h3`.
Obfuscation, port hopping, bandwidth knobs, insecure TLS, Reality, uTLS and
TCP/WS/gRPC transports are not silently accepted or discarded. Principal-based
metered listeners remain VLESS-only. External firewall UDP reachability and
certificate provisioning remain deployment prerequisites, not capabilities
proven by a local configuration check.

Validation includes generated native parser fixtures for all three exact targets
and a mandatory CI QUIC loopback gate with wrong-password, wrong-hostname and
stopped-server/no-direct-fallback checks. The local sandbox denies native process
startup (`create netlink socket: operation not permitted`), so parser success
alone must not be described as successful traffic validation. Use the exact
commit's CI result before claiming this slice's runtime gate passed.

## 2026-11-13: direct AnyTLS slice

AnyTLS adds a second explicit sing-box-only capability: manual endpoint entry and
strict sing-box native import, client 1.14.3 output, and ordinary server
1.14.3/1.14.4 listener/connector output. Password and ordinary TLS are required.
Optional ALPN is preserved; unlike Hysteria2 it is not forced to h3. Unsupported
uTLS, Reality, transport wrappers, padding/session knobs and unrelated protocol
credentials are rejected, not silently removed. AnyTLS share-link import is not
part of this slice. Xray/managed-Xray/Mihomo output and both sides of an AnyTLS
detour remain unsupported. Principal-based listeners remain VLESS-only.

The implementation follows the pinned upstream `option/anytls.go` and
`protocol/anytls/inbound.go` contracts. Native parser fixtures cover all three
exact targets. A mandatory generated-client TCP loopback gate covers successful
traffic, stopped-server/no-direct-fallback, wrong password and wrong hostname.
As with Hysteria2, the sandbox cannot activate native processes; rely on the
exact commit's CI runtime result, not parser success, for traffic evidence.


### AnyTLS official share-link import

The URI import path now accepts `anytls://` links following the upstream
[URI scheme](https://github.com/anytls/anytls-go/blob/main/docs/uri_scheme.md):
percent-encoded username-as-password and fragment-as-name, default port 443,
explicit ports, and SNI (including IP certificate identity). Only absent
`insecure` or `insecure=0` are accepted. Insecure TLS, unknown or repeated
parameters, paths other than `/`, and ambiguous `user:pass@` authentication
are rejected. Passwords containing colons must use `%3A`. This increment replaces
the share-link exclusion above; engine, version and direct-only boundaries
remain unchanged. The real authenticated API test covers import, save, preview,
publication and downloaded sing-box connection settings without exposing source
credentials to another user or in ordinary inventory responses.

### AnyTLS through a SOCKS5 relay

Ordinary sing-box server programs now support one bounded named-connector chain:
select the AnyTLS connector as the forwarding action and set its `via` to a
SOCKS5 connector with no upstream of its own. The generated AnyTLS outbound keeps
its original server and TLS identity and uses the SOCKS5 connector's tag as its
`detour`. The upstream dialer establishes the AnyTLS TLS session through the
relay; this is not a replacement of the selected exit with the relay.

This supersedes the direct-only AnyTLS restriction for that named shape only.
Reverse use (another connector through AnyTLS), non-SOCKS5 upstreams, additional
upstream layers, legacy ordered Egress and Hysteria2 chains remain rejected.
The existing client output remains a direct connection to the selected listener;
this increment is server forwarding, not general client-side chain editing.
The native gate tests the generated chain, relay traversal, TCP/UDP delivery and
stopped-relay/no-direct-fallback. Runtime claims require its exact-commit CI
result, not merely parser acceptance.

### AnyTLS through an ordinary TLS Trojan relay

The bounded named AnyTLS chain also accepts a direct Trojan relay with ordinary
TLS, no Reality/uTLS fingerprint, and no transport wrapper (absent or TCP only).
This protects the transit connection across VPS boundaries; the inner AnyTLS
connection still authenticates its own destination and TLS identity. The two
connections' passwords and certificate identities remain separate. The UI
rejects changes that would make an existing chain unsupported.

The supported shape is still one upstream relay, not arbitrary nesting or
reverse use of AnyTLS as a relay. The native acceptance fixture uses a sing-box
entry, an Xray 26.10.31 Trojan relay and a sing-box AnyTLS exit, with isolated
trusted certificates. It exercises TCP, UDP-over-AnyTLS, stopped exit and stopped
relay without direct fallback. Engine-parser acceptance alone is not proof of
this cross-core traffic path; consult the exact commit's runtime result.

### Two encrypted Trojan relays before an AnyTLS exit

Named sing-box forwarding can also use two ordinary TLS Trojan relays in order:
`AnyTLS exit -> via second Trojan -> via first Trojan -> direct`. This represents
three remote VPS nodes while retaining the final AnyTLS server and TLS identity.
Both relays use the previously bounded Trojan settings. A third relay, a mixed
SOCKS5/Trojan two-relay chain, wrappers/fingerprints, reverse AnyTLS use, HY2 chains
and legacy ordered egress are still rejected. Existing single-relay shapes are
unchanged. The selector and parameter editor validate the complete graph before
accepting a change.

The mandatory native fixture extends the mixed-core path to two Xray Trojan
relay processes, verifies TCP and UDP delivery, and independently stops each
relay and the final exit. Positive recovery between stop cases prevents a
second stopped node from producing a false negative-path success. Recreated
entry processes avoid reusing an already established AnyTLS session. As always,
only the exact commit's successful runtime gate establishes these traffic claims.

### AnyTLS through a single ordinary TLS VLESS relay

The named sing-box connector graph also accepts one direct VLESS relay with
ordinary TLS and TCP. Flow/Vision, Reality, client fingerprints, explicit packet
encoding and additional upstreams are not included. Two-relay shapes remain
Trojan-only; this does not enable arbitrary mixed nesting or AnyTLS as a relay.
The UI and server validation reject unsupported combinations rather than dropping
fields or changing the exit. The VLESS UUID and TLS identity remain separate from
the AnyTLS exit password and TLS identity.

This path reuses an existing Xray VLESS VPS as transit to an AnyTLS exit. AnyTLS
carries its UDP payloads over its own TCP session (UoT), so VLESS in this path
transports TCP to the exit; it is not evidence of independent VLESS UDP/XUDP
behavior. An omitted packet-encoding field uses the native engine default, not an
explicit request to disable XUDP. Sources: sing-box v1.14.4
[`anytls/outbound.go`](https://github.com/SagerNet/sing-box/blob/v1.14.4/protocol/anytls/outbound.go)
and [`vless/outbound.go`](https://github.com/SagerNet/sing-box/blob/v1.14.4/protocol/vless/outbound.go).

The native fixture uses sing-box 1.14.4 at entry/exit and Xray 26.10.31 at transit,
with separately owned processes, generated configurations, TCP and UDP delivery,
and independent exit/relay shutdown and recovery checks. Parser fixtures cover
sing-box 1.14.3 and 1.14.4; traffic support requires the exact commit's successful
runtime gate. These local native processes do not verify a user's real VPS
firewall, certificates or network reachability, and no production VPS is changed.

### Visual path editing and publication for supported AnyTLS chains

The visual path reader previously retained the original five-protocol allowlist,
so even server-valid AnyTLS connector graphs were reported as uneditable. The
same reader is used when selecting a server deployment for a public route; its
rejection also prevented selecting the complete chain for publication.

The path editor now uses the existing connector-graph restrictions for both saved
and rewritten graphs, including unused connectors and generated managed bridges.
This enables the already-supported AnyTLS paths without adding combinations.
Invalid reversed, mixed or excessive relay paths are rejected before mutation;
removing a hop preserves its stored connector credentials. Public routes continue
to publish only their supported VLESS entry, not the private AnyTLS/relay secrets.
The changed UI paths are checked through the real path model, editing controls and
public-route creation. Native runtime boundaries and exact-commit CI remain as
specified above; this increment changes no engine configuration format.
