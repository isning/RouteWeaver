# Subscription import seam

`Parse(Request)` performs bounded, offline extraction into one tenant-owned
SourceSnapshot. Network retrieval belongs to `internal/resources`; authorizing and
accepting/replacing a snapshot belongs to the control-plane application.

Implemented inputs:
- URI lines and standard/URL-safe base64 URI subscriptions: SOCKS5, SIP002
  Shadowsocks and VLESS with explicitly modeled TCP, WS, gRPC or HTTPUpgrade,
  TLS/REALITY, flow and ALPN options. Trojan ordinary-TLS URIs and bounded
  VMess AEAD v2rayN version-2 share links are also supported. Legacy nonzero
  VMess alter IDs reject rather than downgrade.
- Typed WS/HTTPUpgrade header maps preserve non-Host values; Host stays separate.
- Mihomo YAML/JSON `proxies` and sing-box JSON `outbounds` connection extraction.
- `auto` format selection, with explicit format available to avoid ambiguity.

Mihomo/sing-box import is **connection extraction**, not lossless migration of
full configurations. Diagnostics identify omitted full-config sections and
non-connection outbounds. Unknown behavior-bearing connection fields, insecure
TLS settings, unsupported protocols, duplicate JSON members and invalid nodes
reject the candidate; they are not silently stripped. An error returns no usable
partial snapshot, and callers preserve the last accepted snapshot.

IDs are source-scoped and independent of display names and secrets. Pass the
previous accepted snapshot in `Request.Previous` during refresh: exact connection
matching retains IDs across source reordering/renaming, and a unique remaining
connection preserves identity on credential rotation. Initial same-location
multiple accounts receive independent random IDs. Credentials are compared only
for reconciliation, never hashed into an exported ID. Ambiguous bulk credential
changes reject the candidate rather than guessing which previous identity each
replacement belongs to. Explicit ambiguity-resolution UI remains an acceptance
gap; the previous accepted snapshot stays usable.

No arbitrary script execution, live fetch or external credentials appear in tests.
Tests include positive imports, rename/credential identity continuity, rejected
security degradation, non-partial failures and bounded fuzzing. Parser acceptance
is not evidence of working remote connectivity.

Primary format references inspected 2026-10-19:
- https://github.com/XTLS/Xray-core/discussions/716
- https://shadowsocks.org/doc/sip002.html
- https://wiki.metacubex.one/en/config/proxies/vless/
- https://sing-box.sagernet.org/configuration/outbound/vless/

Explicit empty native arrays (`proxies: []`, `{"proxies":[]}` or
`{"outbounds":[]}`) are complete empty snapshots. A missing/null array, blank
URI list, whitespace or HTML is invalid. The application treats a transition
from accepted endpoints to a complete empty snapshot as a removal candidate,
not a fetch outage. Recognized non-connection outbounds remain extraction
warnings requiring application review before first acceptance.

Bounds: parser input is at most 16 MiB, 10,000 native connections, 20,000 URI
lines and 64 KiB per URI line. The HTTP adapter has a smaller 2 MiB request/fetch
limit and a 15-second fetch deadline; the file picker accepts up to 1 MiB.
No embedded provider URL, external schema or script is fetched by the parser.

WIP47 exact protocol/role matrix and verification: [endpoint capabilities](../../docs/verification/ENDPOINT-CAPABILITIES-2026-10-29.md).
