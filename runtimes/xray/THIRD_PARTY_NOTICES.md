# Managed runtime third-party notices

This inventory records external modules linked by `go list -deps` for the Linux
managed-runtime command with this module's pinned `go.mod` and `go.sum`.
Upstream license/notice texts are reproduced unchanged under `licenses/`.
Go standard-library/toolchain license is included separately. Preserve these files
with binary distributions; dependency upgrades require regenerating and reviewing
this inventory, including package-level third-party notices in changed sources.
This is a dependency inventory, not a legal opinion or a relicensing claim.

The unchanged Xray core is MPL-2.0, source tag [v26.3.27](https://github.com/XTLS/Xray-core/tree/v26.3.27),
commit `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`, Go module `v1.260327.0`.
[Its license](licenses/github.com__xtls__xray-core@v1.260327.0/LICENSE) is included.
Source for each pinned Go module is retrievable from its module path and version,
for example `go mod download -json module@version`; checksum verification uses
`go.sum` and the configured Go checksum database. `go version -m` on the binary
provides a second record of the actual linked module versions.

| Module | Version | Upstream license/notice |
| --- | --- | --- |
| `github.com/andybalholm/brotli` | `v1.0.6` | [LICENSE](licenses/github.com__andybalholm__brotli@v1.0.6/LICENSE) |
| `github.com/apernet/quic-go` | `v0.59.1-0.20260217092621-db4786c77a22` | [LICENSE](licenses/github.com__apernet__quic-go@v0.59.1-0.20260217092621-db4786c77a22/LICENSE) |
| `github.com/cloudflare/circl` | `v1.6.3` | [LICENSE](licenses/github.com__cloudflare__circl@v1.6.3/LICENSE) |
| `github.com/ghodss/yaml` | `v1.0.1-0.20220118164431-d8423dcdf344` | [LICENSE](licenses/github.com__ghodss__yaml@v1.0.1-0.20220118164431-d8423dcdf344/LICENSE) |
| `github.com/google/btree` | `v1.1.2` | [LICENSE](licenses/github.com__google__btree@v1.1.2/LICENSE) |
| `github.com/gorilla/websocket` | `v1.5.3` | [LICENSE](licenses/github.com__gorilla__websocket@v1.5.3/LICENSE) |
| `github.com/juju/ratelimit` | `v1.0.2` | [LICENSE](licenses/github.com__juju__ratelimit@v1.0.2/LICENSE) |
| `github.com/klauspost/compress` | `v1.17.4` | [LICENSE](licenses/github.com__klauspost__compress@v1.17.4/LICENSE) |
| `github.com/klauspost/cpuid/v2` | `v2.3.0` | [LICENSE](licenses/github.com__klauspost__cpuid__v2@v2.3.0/LICENSE) |
| `github.com/miekg/dns` | `v1.1.72` | [LICENSE](licenses/github.com__miekg__dns@v1.1.72/LICENSE) |
| `github.com/pelletier/go-toml` | `v1.9.5` | [LICENSE](licenses/github.com__pelletier__go-toml@v1.9.5/LICENSE) |
| `github.com/pires/go-proxyproto` | `v0.11.0` | [LICENSE](licenses/github.com__pires__go-proxyproto@v0.11.0/LICENSE) |
| `github.com/quic-go/qpack` | `v0.6.0` | [LICENSE.md](licenses/github.com__quic-go__qpack@v0.6.0/LICENSE.md) |
| `github.com/refraction-networking/utls` | `v1.8.3-0.20260301010127-aa6edf4b11af` | [LICENSE](licenses/github.com__refraction-networking__utls@v1.8.3-0.20260301010127-aa6edf4b11af/LICENSE) |
| `github.com/sagernet/sing` | `v0.5.1` | [LICENSE](licenses/github.com__sagernet__sing@v0.5.1/LICENSE) |
| `github.com/sagernet/sing-shadowsocks` | `v0.2.7` | [LICENSE](licenses/github.com__sagernet__sing-shadowsocks@v0.2.7/LICENSE) |
| `github.com/vishvananda/netlink` | `v1.3.1` | [LICENSE](licenses/github.com__vishvananda__netlink@v1.3.1/LICENSE) |
| `github.com/vishvananda/netns` | `v0.0.5` | [LICENSE](licenses/github.com__vishvananda__netns@v0.0.5/LICENSE) |
| `github.com/xtls/reality` | `v0.0.0-20260322125925-9234c772ba8f` | [LICENSE-Go](licenses/github.com__xtls__reality@v0.0.0-20260322125925-9234c772ba8f/LICENSE-Go), [LICENSE](licenses/github.com__xtls__reality@v0.0.0-20260322125925-9234c772ba8f/LICENSE) |
| `github.com/xtls/xray-core` | `v1.260327.0` | [LICENSE](licenses/github.com__xtls__xray-core@v1.260327.0/LICENSE) |
| `go4.org/netipx` | `v0.0.0-20231129151722-fdeea329fbba` | [LICENSE](licenses/go4.org__netipx@v0.0.0-20231129151722-fdeea329fbba/LICENSE) |
| `golang.org/x/crypto` | `v0.58.0` | [LICENSE](licenses/golang.org__x__crypto@v0.58.0/LICENSE) |
| `golang.org/x/exp` | `v0.0.0-20240506185415-9bf2ced13842` | [LICENSE](licenses/golang.org__x__exp@v0.0.0-20240506185415-9bf2ced13842/LICENSE) |
| `golang.org/x/net` | `v0.60.0` | [LICENSE](licenses/golang.org__x__net@v0.60.0/LICENSE) |
| `golang.org/x/sync` | `v0.24.0` | [LICENSE](licenses/golang.org__x__sync@v0.24.0/LICENSE) |
| `golang.org/x/sys` | `v0.49.0` | [LICENSE](licenses/golang.org__x__sys@v0.49.0/LICENSE) |
| `golang.org/x/text` | `v0.43.0` | [LICENSE](licenses/golang.org__x__text@v0.43.0/LICENSE) |
| `golang.org/x/time` | `v0.12.0` | [LICENSE](licenses/golang.org__x__time@v0.12.0/LICENSE) |
| `golang.zx2c4.com/wireguard` | `v0.0.0-20250521234502-f333402bd9cb` | [LICENSE](licenses/golang.zx2c4.com__wireguard@v0.0.0-20250521234502-f333402bd9cb/LICENSE) |
| `google.golang.org/genproto/googleapis/rpc` | `v0.0.0-20251202230838-ff82c1b0f217` | [LICENSE](licenses/google.golang.org__genproto__googleapis__rpc@v0.0.0-20251202230838-ff82c1b0f217/LICENSE) |
| `google.golang.org/grpc` | `v1.79.3` | [NOTICE.txt](licenses/google.golang.org__grpc@v1.79.3/NOTICE.txt), [LICENSE](licenses/google.golang.org__grpc@v1.79.3/LICENSE) |
| `google.golang.org/protobuf` | `v1.36.11` | [LICENSE](licenses/google.golang.org__protobuf@v1.36.11/LICENSE) |
| `gopkg.in/yaml.v2` | `v2.4.0` | [NOTICE](licenses/gopkg.in__yaml.v2@v2.4.0/NOTICE), [LICENSE.libyaml](licenses/gopkg.in__yaml.v2@v2.4.0/LICENSE.libyaml), [LICENSE](licenses/gopkg.in__yaml.v2@v2.4.0/LICENSE) |
| `gvisor.dev/gvisor` | `v0.0.0-20260122175437-89a5d21be8f0` | [LICENSE](licenses/gvisor.dev__gvisor@v0.0.0-20260122175437-89a5d21be8f0/LICENSE) |
| `lukechampine.com/blake3` | `v1.4.1` | [LICENSE](licenses/lukechampine.com__blake3@v1.4.1/LICENSE) |
