# Endpoint target parity audit (2026-10-29)

Read-only audit against backend freeze `676847a6bf89eb3c0207b1c98b3d7f91532cf004034599a1d2bd7ed839203867`. The running full regression is not evidence for the queued corrections below.

## Field inventory

| Intent | Legacy Node / generic outbound | Listener distinction |
| --- | --- | --- |
| host, port, protocol | Node.ConnectionValue preserves; shared Xray/sing-box emitters, separate Mihomo emitter preserve | bind address is distinct from advertised address; registry requires explicit bind IP |
| username/password/method | SOCKS pair, SS supported AEAD methods, Trojan password validated by domain and emitted | server credentials or principal material, never interchange with server TLS secrets |
| UUID, flow | UUID VLESS/VMess; Vision VLESS TCP+security only; emitted | principal users deliberately replace inventory placeholder; managed Vision remains forbidden |
| vmessSecurity | empty defaults auto; supported AEAD cipher modes emitted | non-auto is outbound-only; registry currently guards, inventory/direct guard queued |
| packetEncoding | sing-box/Mihomo emit; Xray legacy and generic reject explicit wrapper | intentional generated-client hint; managed listener forbids |
| TLS enabled | disabled with active security fields rejected; ordinary TLS and none preserve | certificate/private material separately validated and staged |
| serverName/fingerprint | client dial parameters emitted; M/S declared fingerprint lists, Xray pinned native validation | deliberate published-client hints, not falsely claimed inbound enforcement |
| ALPN | ordinary TLS emitted; sing-box/Mihomo REALITY preserved; Xray generic connector rejects REALITY ALPN | ordinary TLS emitted; Xray REALITY cannot honor explicit ALPN, consistent rejection queued |
| REALITY publicKey/shortId | validated and emitted; server private key never placed in client output | paired against separate server private key, server names and short-ID list |
| transport type/path/Host | tcp/ws/httpupgrade/grpc; exact target mappings; HTTPUpgrade import roundtrip repaired | portable path guard; sing-box WS Host deliberately retained only as published-client hint, omitted inbound |
| serviceName/authority | service emitted; authority supported only Xray outbound | authority rejected as not enforced |
| headers | typed request map, duplicate-case/reserved/framing guards, exact allowed values emitted; deep cloned and redacted | request headers rejected, not repurposed as response headers |

## Consolidated corrections implemented after frozen run terminal

1. Shared outbound target validator used by legacy, generic connectors and direct client adapters. Reuse domain connection validation. Preserve existing scope rather than invent portable fallbacks.
2. Xray: common packet-wrapper guard, REALITY ALPN guard, pinned REALITY transport restriction (TCP/gRPC among modeled transports). The latter currently produces a native error, not successful silent output; early target diagnostic improves consistency.
3. M/S: common authority and existing declared fingerprint checks, including direct client adapters and legacy/generic sing-box outbound.
4. Shared listener role guard: custom VMess cipher rejected at inventory and direct adapters as already rejected by registry. Keep intentional SNI/fingerprint/packet client-template semantics.
5. Managed direct renderer: mirror existing declared SOCKS/SS/VLESS egress protocol capability; do not allow direct Trojan/VMess calls to bypass registry restrictions.

Xray valid version-specific fingerprints are not narrowed to an invented list: pinned infra/conf TLS builder normalizes and explicitly errors unknown fingerprints. Generic direct server renderers retain their existing normalized-program contract; no connector lifecycle or model migration is introduced by this correction.

## Exact pinned source observations

- Xray `infra/conf/transport_internet.go` StreamConfig.Build rejects REALITY except tcp/splithttp/grpc. XHTTP is outside this implemented model.
- Xray REALITY settings have no ALPN field; ordinary TLS settings do.
- Client adapters already declare bounded fingerprint lists; shared validation must preserve these declarations and existing lowercase handling.
- Native parse checks cannot establish actual wire headers or traffic; loopback positive/exit-stopped-negative evidence is recorded separately.

Tests to bind final changes: stable diagnostic parity across legacy/generic/direct seams; positive ordinary TLS/REALITY supported output; exact allowed transport-header values; listener inventory rejection; managed direct rejection. Then native parser/runtime gates and one serialized final-source broad regression. This document does not mark queued work as completed.

## Implementation status

The frozen run exited 0 unchanged. All five corrections above landed in one batch. New parity failures were captured before the shared validator fix; full focused domain/render/importer/conversion race passed afterward. Final broad acceptance awaits the superseding source freeze.

Final scoped evidence is complete: canonical parser and Xray-only runtime gates pass after the corrections, exact HTTP legacy/inventory/reveal race regressions pass, architecture and formatting guards pass. Backend source is frozen by `backend-parity-final.sha256` (digest `2271b511a690e7593dd6a318ba92bbe4bc531f5303b0fda8143022079df293ab`). Root owns final global quick verification; no further backend production edit is pending.

## Evidence availability and superseding gate (2026-10-29)

Raw runner logs named above are retained locally, not included as archive attachments. Their hashes and sizes are in `CHECKPOINT-EVIDENCE/WIP47/local-evidence-index.json` (relative to the repository root). Public scoped receipts retain the results and limitations. Earlier “pending” paragraphs describe the named historical attempts, not the latest state.

The later global `scripts/verify.sh quick` R2 passed every Go and managed-runtime vet/race/build stage, all preceding static guards, and frontend typecheck on an unchanged 1,355-file source manifest. It then failed two frontend behavior tests (1,783 passed, 2 failed out of 1,785); production frontend build was not reached. Backend acceptance is retained only for unchanged backend source. The subsequent repaired frontend passed all 1,796 tests, typecheck and production build on unchanged source. A final 542-file backend/API scope comparison found no changes. Acceptance is a repaired modular aggregate, not a relabeling of the failed quick run. See `CHECKPOINT-EVIDENCE/WIP47/quick-r2.failed.json` and `docs/verification/WIP47-FINAL.md`.
