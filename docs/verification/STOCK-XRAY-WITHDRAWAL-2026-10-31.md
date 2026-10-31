# Xray withdrawal and replacement acceptance

This supersedes the **current Xray target** in the earlier stock-security
maintenance report, not its historical evidence or immutable receipts.

## Official source and byte verification

The official [26.10.31 release](https://github.com/XTLS/Xray-core/releases/tag/v26.10.31)
withdraws 26.10.29 for emergency MPTCP default hardening. Actual CI failed when
that withdrawn archive returned 404; see the [failure diagnosis](NATIVE-CI-WITHDRAWN-RELEASE-2026-10-31.md).
The replacement Linux amd64 archive SHA-256 is
`e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214`;
executable SHA-256 is
`cc4b84d3069569f297a61f04b914f2bb37e9d202fd7b84cb50def1fc30fd40e1`.
Downloaded archive hash matches both official release asset metadata and `.dgst`.
Build metadata records Go **1.27.3**, grpc-go **1.84.0**. This is checksum
provenance, not independent publisher-signature validation.

Reviewed official sources:
- [command flags](https://github.com/XTLS/Xray-core/blob/v26.10.31/main/run.go): existing foreground and validation commands retained.
- [freedom policy](https://github.com/XTLS/Xray-core/blob/v26.10.31/proxy/freedom/freedom.go): default private-target protection and explicit final-rule exceptions retained.
- [TLS trust](https://github.com/XTLS/Xray-core/blob/v26.10.31/transport/internet/tls/config.go): bundled trust behavior retained; tests supply an explicit fixture CA rather than treating host roots as authority.
- [listener implementation](https://github.com/XTLS/Xray-core/blob/v26.10.31/transport/internet/system_listener.go): explicit MPTCP default disable. Process/listener hardening for the application and other adapters is a separate paired change, not an implicit managed-upstream upgrade.

## Receipt and authorization contract

26.10.29 catalog fields, digests, registration and rendering identity remain
unchanged and resolvable. Historical journal recovery is observational and can
stop an owned runtime. They are **not** authorization to install, start, configure,
rollback into, or refresh a withdrawn core. New grants are refused in Fleet,
direct publication, agent submission and both CP/agent refresh paths. A previously
running process is not blindly killed based on version; existing bounded lease
and identity-safe stop rules remain. Operators must review an upgrade or stop.

Only new stock defaults/installability move to 26.10.31. Client and managed
runtime identities remain unchanged. Saved 26.10.29 configurations remain
renderable for inspection and stop; their earlier destination-policy semantics
are not silently rewritten. The stock lock separately names the unavailable
26.10.29 fixture: bootstrap never fetches it or mirrors withdrawn bytes. Current
31 and available historical fixtures remain mandatory positive gates. A protocol
regression requires the unavailable list to name exactly the withdrawn identity.

## Local verification and limits

- Official bootstrap: all seven available compatibility/stock assets verified.
- Full required native parser script: passed.
- Xray-selected native runtime script: passed, including real upgrade/lease,
  SOCKS/Shadowsocks/VLESS/Trojan/VMess payload, TLS trust and wrong-host negatives,
  private-target default denial, explicit CIDR exceptions and no-direct-fallback.
- Withdrawal-specific tests: historical simulated journal reopen/owned stop,
  pending installation/upgrade recovery without fetching, no new grant/refresh,
  direct publication rejection with no Desired queued, Fleet stop availability.
- Targeted withdrawal/catalog/renderer race tests repeated three times: passed.
- Three affected frontend suites: **56 tests passed**.
- Offline bootstrap/managed script contract tests: **16 passed**.

The historical journal test is deliberately benign fixture evidence, not a
reconstructed 26.10.29 executable. Local sing-box process activation is not
claimed or retried around the existing host restriction. The exact integrated
published SHA still requires CI parser, **both** stock process targets and all
managed traffic tests, including the continuous payload/revocation positive.
No skip/timeout weakening, host network changes, kernel changes or exploit
traffic were used. Real-host kernel patch status and deployment/soak remain
separate acceptance requirements.
