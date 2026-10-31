# Stock-core security maintenance — 2026-10-31

Superseded current Xray target: upstream withdrew 26.10.29 later on this date.
See [withdrawal/replacement acceptance](STOCK-XRAY-WITHDRAWAL-2026-10-31.md);
the observations below remain historical, not a recommendation to install 29.

This later correction follows [the Go compiler rebuild](GO-CERTIFICATE-MAINTENANCE-2026-10-31.md). Rebuilding RouteWeaver does not rebuild separately downloaded official stock cores. The old releases were production-installable, not irrelevant test fixtures. No live node is upgraded by this change.

## Verified upstream bytes

Exact official Linux/amd64 archives were SHA-256 checked **before extraction**; the extracted executable hashes were checked separately. Official `go version -m` inspected build metadata without executing the cores during the audit:

| Official release | Embedded compiler | grpc-go module | New install policy |
| --- | --- | --- | --- |
| Xray 26.3.27 | Go 1.26.1 | 1.79.3 | Retired |
| sing-box 1.14.3 | Go 1.26.8 | 1.79.1 | Retired |
| Xray 26.10.29 | Go 1.27.3 | 1.84.0 | Current |
| sing-box 1.14.4 | Go 1.26.10 | 1.79.1 | Current |

All four immutable archive/executable digests are recorded in `scripts/stock-core-lock.json` and checked against the Go catalog in tests. Candidate archive digests matched the official [Xray release metadata](https://github.com/XTLS/Xray-core/releases/expanded_assets/v26.10.29) and [sing-box release metadata](https://github.com/SagerNet/sing-box/releases/expanded_assets/v1.14.4). Xray's published `.dgst` agreed. The decoded sing-box immutable-release attestation subject also bound the same archive, tag and commit `c005f35300ce76427dc285481ec5695f5b179cd2`; its signature chain was **not** independently verified. Checksums pin bytes, not cryptographic publisher identity. Historical receipt metadata, including the old sing-box checksum-verification flag, is unchanged.

## Security applicability and limits

- [GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809) affects Go before 1.26.10 and Go 1.27 before 1.27.3. Both old binaries contain affected standard libraries; both candidates use fixed compiler releases.
- Stock Xray legitimately supports VLESS/Trojan/VMess gRPC. Its old grpc-go 1.79.3 falls in the generic transport denial-of-service ranges of [GO-2026-6061](https://pkg.go.dev/vuln/GO-2026-6061) (fixed 1.82.1) and [GO-2026-6348](https://pkg.go.dev/vuln/GO-2026-6348) (fixed 1.83.1). The xDS-specific [GO-2026-6441](https://pkg.go.dev/vuln/GO-2026-6441) and [GO-2026-6443](https://pkg.go.dev/vuln/GO-2026-6443) do not have an established supported xDS path here. Xray's new grpc-go 1.84.0 is outside all four affected ranges; no managed-only transport restriction is transferred to stock.
- The official sing-box binaries omit `with_grpc`; their gRPC transport uses [the upstream grpc-lite implementation](https://github.com/SagerNet/sing-box/blob/v1.14.4/transport/v2ray/grpc_lite.go), not grpc-go. No supported RouteWeaver sing-box server path into the vulnerable grpc-go implementation was established. The module remains in the build dependency metadata: **this is not a globally grpc-clean dependency claim**.
- [Xray GHSA-5wf9-h793-w73c](https://github.com/XTLS/Xray-core/security/advisories/GHSA-5wf9-h793-w73c) is fixed from 26.7.11, so the new stock release is past the fix. The old issue requires specific gRPC/Hysteria certificate-pinning conditions. RouteWeaver's typed renderer does not emit the implicated pin field; Hysteria remains unsupported. No vulnerable generated profile was demonstrated, and no protocol is newly enabled.
- Binary vuln scans of these stripped executables fell back to conservative known-symbol enumeration; synthetic symbol findings are not proof of binary presence or reachable exploitation. This bounded maintenance is not a clean audit of all upstream dependencies or proof of no vulnerabilities.

## Intentional upstream behavior changes

A real-byte differential found that old Xray passed existing loopback protocol fixtures while the new release authenticated VMess/VLESS and then denied their private final destination. Trojan also rejected the synthetic CA previously supplied through `SSL_CERT_FILE`. These were not treated as permission to remove security checks or discard protocol coverage.

Official [freedom policy source](https://github.com/XTLS/Xray-core/blob/v26.10.29/proxy/freedom/freedom.go) confirms default private-target protection on freedom/direct egress for VLESS, VMess, Trojan and Shadowsocks (not SOCKS). The existing typed `DestinationPolicy.AllowCIDRs` is now supported only for those protocols on current stock Xray. Each validated canonical, non-default CIDR becomes an explicit `rw-direct` freedom `finalRules` allow exception. Missing/empty policy leaves upstream defaults unchanged; other versions, sing-box and stock SOCKS still reject unsupported exception intent. Managed-Xray policy remains in its separate enforced descriptor. Connector dial addresses are not user-requested final destinations and are not rewritten by this mapping. Operators using legitimate private final services must review a current-version configuration/policy migration before upgrading; the UI editor is version/protocol aware. Historical drafts deliberately cannot save these current-only exceptions. This checkpoint does not add a separate candidate-policy editor to fleet upgrade: do not assume an old draft can pre-store new-version policy or blindly upgrade a dependent private route. No catch-all allow or new protocol is introduced.

The official [TLS implementation](https://github.com/XTLS/Xray-core/blob/v26.10.29/transport/internet/tls/config.go) uses bundled CA roots by default, not the old system-root behavior. Custom OS roots and `SSL_CERT_FILE` are not equivalent after upgrade. This change does **not** turn on global `useSystemCA` or add unmodeled custom-CA controls to the product. Deployments relying on private trust anchors need an explicit supported trust migration; do not substitute insecure TLS. Native tests trust only their generated fixture CA through a staged `certificates` entry with `usage: verify` and `disableSystemRoot: true`, retaining hostname and chain verification. Negative tests retain default destination denial, nonmatching CIDR denial, unknown CA rejection and wrong-name rejection. A SOCKS domain request for locally resolved `localhost` also verifies default denial versus explicit `127.0.0.1/32` and `::1/128` exceptions; payload remains IPv4/TCP loopback. This is not UDP, IPv6 payload, DNS-rebinding, all-address-class or external public-network certification.

Xray 26.10.21 was also inspected as a smaller possible update: its exact official archive (`0eec3ed4163c273d8c8bf821f7d219e257921cf584aa3fb970715e458e631978`) contains Go 1.27.3 and grpc-go 1.84.0, but official source already has **both** behavior changes. It offers no compatibility escape and is not added to the installation catalog. The reviewed target remains 26.10.29.

## Version and recovery contracts

- New catalog choices and Infrastructure stock defaults are Xray **26.10.29** and sing-box **1.14.4**. Native commands and parser/runtime tests name the exact binary versions.
- `InstallableCoreReleases` is a separate admission allowlist. Immutable `CoreRelease` records have no mutable retirement field, so exact old `release.json` receipts keep validating. Incoming install/upgrade, fleet preview/create and `CoreInstaller.Prepare` reject retired IDs before archive access.
- Private retained journals use structural/identity/artifact validation, not today's admission policy. Completed old installations recover from verified local bytes; authentic pending old install/upgrade history remains readable but is blocked with `core_release_retired`, never downloaded/replayed. Existing runtime observation, lease handling and tamper checks remain in force. A historical configure/rollback may use an already installed receipt, never fetch a retired executable.
- Historical render versions remain supported for saved drafts, receipts and rollback. This does not label vulnerable old binaries safe or automatically migrate running nodes. Operators must explicitly review and upgrade existing stock instances.
- Client compatibility pins in `scripts/core-lock.json` remain unchanged (including sing-box 1.14.3). Managed runtime identity stays **26.3.27-rw1**, with embedded Xray **26.3.27** rebuilt using Go 1.27.3 by the separate maintenance patch. No old binary is relabeled with a new version.
- Stock cache paths use the full release ID (`bin/stock-cores/<release-id>` plus `.download`), independent of compatibility cache filenames. Bootstrap verifies both hashes and refuses unsafe/corrupt existing files. Native gate preflight requires every requested stock receipt/cache asset and explicit positive tests; missing/skipped tests are not passes.

## Verification scope

Passed locally on this scoped implementation with Go 1.27.3:

- Canonical `scripts/verify.sh static`: 42 offline helper regressions, ticket/architecture checks and pinned actionlint. Root command packages build, Go formatting, web typecheck and diff checks pass.
- Focused race tests in controlprotocol, agent, render and HTTP API: active catalog identity, retired admission, historical/pending recovery, higher-generation replacement, tamper rejection, transition/lease fencing, fleet ownership and TLS contracts. The render package also passed independently.
- 98 focused UI tests across Infrastructure, destination-policy, TLS/forwarding and fleet tasks, one worker. Regression evidence includes failing-before-passing current defaults, same-family historical version preservation, scoped policy editing and migration feedback.
- Exact current/historical stock parser/installer checks: 45 positive test events, plus 114 Trojan/VMess server-matrix events, with no failures or skips. Current VLESS transport fixtures include the typed destination exception. These are parser/preparation results, not process activation claims.
- Selected Xray runtime checks: 25 positive test events across supervisor/restart, SOCKS two-hop, generated route no-fallback, shared VLESS principal isolation, all eight VMess/Trojan transport roundtrips, fleet configure/stop/start/rollback, security-default/hostname/trust cases, and actual official old-to-new upgrade. The deliberately unselected sing-box supervisor subtest is the only skip.
- The real-binary failed-new-launch case retains uncertainty until recovery proves both owners absent. It rejects expired historical rollback, restores the old receipt only through an explicit fresh-lease rollback, and terminates that restored process on expiry. It never silently restarts an old runtime or revives old permissions.

Pending: the final commit's full backend/web/browser/package gates and complete canonical native gate in authorized CI. The local compatibility Mihomo cache is absent, so manually selected stock evidence is **not** labeled a full native gate. Known sing-box runtime/netlink host restrictions were not bypassed or retried; current sing-box parser coverage does not imply runtime traffic acceptance. Public-network behavior, UDP, IPv6 payload, DNS rebinding and deployed performance/enforcement remain outside these local proofs.

No live installation, external credential, system trust-store change or protocol expansion is part of this patch. Existing vulnerable runtimes are not automatically migrated; historical recovery/rollback support is not a security endorsement of those bytes.
