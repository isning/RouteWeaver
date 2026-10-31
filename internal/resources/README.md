# Untrusted resource retrieval

`New(Options).Fetch(ctx, sourceURL)` is the shared retrieval seam for private
subscription imports and remote rule resources. Callers authorize ownership and
store accepted snapshots; the fetcher performs no persistence and does not decide
whether a failed refresh replaces a published configuration.

Default transport policy:
- HTTPS with normal certificate verification, no environment proxy, no URL userinfo.
- Every destination and redirect resolves to public addresses only; all answers are
  checked before dialing a checked literal IP, retaining the hostname for TLS.
- Loopback/private/link-local/metadata/shared-address/special-use networks denied.
- No HTTPS downgrade and no redirect referrer, cookies, or authorization forwarding.
- 30-second total deadline, bounded headers, five requests maximum, 16 MiB body cap
  (including transparently decompressed bodies). Operator limits are bounded.
- Errors contain no subscription URL, query token, body or raw network diagnostic.

The operator may explicitly allow HTTP feeds. This is not an import-form bypass.
This application-level defense complements, not replaces, deployment egress policy.
Private network feeds are deliberately not enabled by this module.

Tests exercise the Fetch interface through an offline `net.Pipe` HTTP transport.
They cover positive public retrieval and stable digest, private URL/DNS rejection,
mixed public/private DNS, redirects into private networks, secret redaction,
redirect limits and payload bounds. They do not assert real internet connectivity.

Standard-library references inspected on 2026-10-19:
- https://pkg.go.dev/net/http#Transport
- https://pkg.go.dev/net/netip#Addr.IsGlobalUnicast
