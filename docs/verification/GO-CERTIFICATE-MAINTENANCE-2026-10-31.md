# Go certificate-verification maintenance — 2026-10-31

## Change and rationale

Both Go modules now require **Go 1.27.3**. This is a compiler/standard-library
security rebuild, not a TLS redesign or a dependency-graph upgrade.
[GO-2026-6809 / CVE-2026-111943](https://pkg.go.dev/vuln/GO-2026-6809) affects
`crypto/x509.Certificate.Verify` in Go 1.27 before 1.27.3. The fixed release adds
rejection of known untrustworthy intermediate certificates in cases where the
system trust store alone is insufficient. The [official Go 1.27.3 release](https://go.dev/doc/devel/release#go1.27.3)
was published on October 19, 2026.

The prior 1.27.2 build had the affected standard library. Certificate verification
is used by SMTP/STARTTLS notifications, agent HTTPS transport and supported managed
TCP/TLS paths. This finding is not evidence of an attack or credential disclosure.
Existing TLS verification, auth policy, supported transports and core version
contracts are unchanged. Both `go.sum` files, npm manifests/lockfile and stock-core
pins are unchanged; historical verification receipts retain their original versions.

## Verified scope

- Installed the exact official Linux/amd64 Go archive through the existing
  checksum-verifying `scripts/bootstrap-go.sh`. Archive SHA-256:
  `65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40`.
- Used `GOTOOLCHAIN=local`, `GOFLAGS='-mod=readonly -p=1'` and existing dependency
  caches; no `go mod tidy`, module update or TLS bypass.
- Race-enabled focused regressions passed without skips: notifications
  (including verified SMTP/STARTTLS and no plaintext fallback), agent HTTPS
  transport/retry/redirect handling, HTTP certificate/publication and subscription
  verification, login/TOTP/CSRF/tenant isolation, managed configuration rejection,
  native TCP/TLS payload and post-revocation mux denial.
- Both modules passed `go vet ./...` and `go build ./...`.
- Rebuilt `routeweaver-control-plane`, `routeweaver-node-agent` and
  `routeweaver-xray` with `-trimpath -buildvcs=false`; `go version -m` confirms
  **go1.27.3** in all three executable build records.
- `govulncheck` v1.9.0 source/symbol scans completed separately from the root and
  managed-Xray modules using Go 1.27.3, default Linux/amd64 build tags, excluding
  test files. Database timestamp: 2026-10-27T21:16:18Z. Comparing finding records
  with the 1.27.2 baseline removes **only GO-2026-6809** from both modules.
  JSON-mode exit 0 alone was not treated as a clean result.

## Remaining limitations

The root graph still has three module-only findings: GO-2026-5932, GO-2026-6860
and GO-2026-6866. Managed Xray retains nine findings: those three plus
GO-2026-5841, GO-2026-6061, GO-2026-6348, GO-2026-6441, GO-2026-6443 and
GO-2026-6651. Four retain conservative symbol traces through Xray registrations
and interfaces. The current managed profile rejects gRPC/Hysteria/API/reverse
configuration implicated by those linked-code findings; this is a scope constraint,
not removal of vulnerable dependency code or proof of non-exploitability.

Separate grpc/Xray/module and npm maintenance remains open. Updating the application
compiler does not update separately downloaded stock-core binaries. In particular,
Xray 26.3.27 and sing-box 1.14.3 remain production-installable catalog entries;
their embedded compiler versions were not established by this maintenance pass.
This record is bounded compiler maintenance and regression evidence, not a clean dependency audit,
all-platform certification, complete repository/CI gate, or deployed acceptance.
Package reproducibility, browser/native gates and exact-commit CI require their own
results. No live node, system trust store, external credential or deployment changed.

## Subsequent stock-core correction

The statements above describe the scope and evidence of this compiler-only
checkpoint. A later [stock-core security maintenance](STOCK-CORE-SECURITY-MAINTENANCE-2026-10-31.md)
inspected the exact vendor binaries, retired the vulnerable new-install defaults,
and separated current stock installation pins from historical receipts and client
compatibility pins. That later change does not retroactively alter these results.
