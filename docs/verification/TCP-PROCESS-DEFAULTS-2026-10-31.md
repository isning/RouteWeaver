# Ordinary TCP defaults after the upstream MPTCP warning

Scope: application/listener policy, not a kernel patch or live rollout.

The official [Xray 26.10.31 notice](https://github.com/XTLS/Xray-core/releases/tag/v26.10.31)
withdraws 26.10.29 and disables default MPTCP in response to its Linux kernel
security warning. The [Go process setting](https://go.dev/doc/godebug) and
[`ListenConfig.SetMultipathTCP`](https://pkg.go.dev/net#ListenConfig.SetMultipathTCP)
are supported application controls. No sysctl, kernel, capability, host networking
or process ownership guard is changed here; no exploit traffic is used.

## Enforcement points

- The control-plane HTTP/TLS listener explicitly calls `SetMultipathTCP(false)`;
  even inherited `GODEBUG=multipathtcp=1` cannot override that listener policy.
- The managed executable sets `GODEBUG`'s `multipathtcp=0` before command dispatch
  or runtime construction. It removes conflicting inherited entries while
  retaining unrelated local Go settings. The embedded upstream module and its
  version identity are unchanged; this is not a relabeled upstream upgrade.
- Both bounded native checks and supervised launches use one credential-free
  environment builder which forces `GODEBUG=multipathtcp=0`. Ambient Go settings
  are not inherited. Unrelated trusted adapter Go settings are retained, but a conflicting MPTCP
  setting cannot override the enforced default.
- Native checker validation rejects actual JSON boolean enabling declarations named
  `tcpMptcp` or `tcp_multi_path` (case-insensitive) in nested Xray/sing-box/managed
  configurations. These options are not supported RouteWeaver capabilities.
  JSON string contents, including credentials containing those words, are not
  treated as options. Duplicate nested members are all inspected rather than
  collapsed into maps, and trailing JSON values/garbage are rejected. Explicit
  false remains a no-op unless another declaration enables MPTCP. The managed
  configuration validator additionally rejects stream and TLS ECH socket-option
  blocks on ingress and egress.

The official sing-box 1.14.4
[`ListenTCP` implementation](https://github.com/SagerNet/sing-box/blob/v1.14.4/common/listener/listener_tcp.go)
only explicitly sets MPTCP when its option is true; it does **not** explicitly
set false for the Go default. It therefore also needs the supervised process
policy and unsupported-enable rejection. The same applies to the unchanged
managed upstream 26.3.27 listener. The production managed command is the process
startup enforcement point; separate direct library embedders must establish an
ordinary-TCP process policy themselves before constructing listeners.

## Verification and limitations

Regression tests cover inherited/default/conflicting Go settings, actual benign
supervised process validation plus activation and TCP payload, control-plane
loopback HTTP and Linux socket protocol, and native/managed enabling-option
rejection. The control-plane test also checks `ListenConfig.MultipathTCP()`:
actual socket protocol alone passed the original code on this host because Go
fell back to TCP. The host-independent requested-policy assertion failed before
the fix. Managed-command and supervised-helper tests independently failed before
their process defaults were enforced. Unsupported native enabling configurations
previously reached successful native validation and now fail beforehand.

This does not establish that the host kernel was vulnerable or patched, nor a
positive MPTCP-capable-host execution test. Actual managed/stock traffic CI is a
separate required gate; these synthetic helper tests are not substitutes.
Existing running processes and inherited sockets are not retroactively changed.
Deployment acceptance must verify the kernel and carry out a reviewed stop/new
activation or process restart; copying binaries alone is not mitigation. Unknown
ownership must still be investigated, not blindly killed or replayed.

Recorded with official Go 1.27.3:

- Focused CP/agent regressions `-race -count=3`: passed, 1.063s / 1.536s.
- Full adjacent `go test -race ./internal/agent ./cmd/control-plane -count=1`:
  passed, 79.916s / 10.278s.
- `go -C runtimes/xray test -race ./... -count=1`: passed, runtime 12.840s,
  command 4.136s. Command hostile-environment regression also passed race ×3.
- Vet for agent, control-plane and managed command, architecture import guard,
  and `git diff --check`: passed.

These runs do not enable optional pinned stock native tests or replace the
required managed-native end-to-end CI gate. Integrated-source CI must rerun both.

Independent source review found a first-pass map scanner could hide a duplicate
nested socket object that upstream Go structs merge. The follow-on token scan
retains every declaration and requires EOF. New public Submit fixtures for nested
duplicates and trailing values failed before this correction. Direct managed
TLS ECH socket-option tests also failed before the profile was made fail-closed.
