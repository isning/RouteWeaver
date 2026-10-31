# Managed Xray runtime

`routeweaver/managed-xray@26.3.27-rw1` is a separate executable embedding the
unchanged official `github.com/xtls/xray-core v1.260327.0` module. It is **not** a
feature claimed for a stock Xray binary. The control-plane module never imports
Xray; this nested module imports only the root's pure policy/private-IPC contracts.

## Supported entry profile

- Authenticated VLESS over raw TCP, optionally TLS; TCP payload, including native
  VLESS mux streams. TLS tests use a temporary CA trusted only by the test client.
- Every inbound tag and authenticated `email` must have exactly one sidecar
  binding. `email` is an opaque SubjectID, not an account name received from the
  client. The private binding fixes account, route, logical entry and immutable
  credential version. CP independently resolves and verifies that mapping.
- Vision (including outbound Vision), REALITY, other entry protocols/transports,
  UDP, fallbacks, reverse APIs,
  dynamic inbound APIs, PROXY protocol/socket/finalmask wrappers and enabled sniffing are
  rejected. Vision is not claimed safe from code inspection or a splice flag.
- Ultimate user destinations default to public unicast only. Administrator-owned
  `destinationPolicy.allowCidrs` grants specific canonical networks for an
  intentional exception. This is independent of the declared transit connector.
  Domain destinations are resolved once, the whole answer set is checked and the
  selected IP is pinned before native dispatch. Sniffing cannot replace the pin.

The wrapper is registered through the upstream public dispatcher feature seam.
It constructs and delegates to the official dispatcher, rather than copying it.
Both `Dispatch` and `DispatchLink` are enforced. Authenticated mux streams retain
independent admission and interruption even when their carrier remains open.

## Policy and accounting

`entry-policy.json` is separate from the ordinary native `native.json`; native
configuration grammar is unchanged. Schema, managed runtime and upstream version
must all match exactly. The sidecar's `bindings` contain `subjectId`, `accountId`,
`routeId`, `entryId`, `inboundTag`, `credentialVersion`, `policyRevision`, `cycleId`.
No broad CP bearer credential is passed to the runtime.

Admission is authoritative outside this process. `entrypolicy.Admission` accepts
the physical connection's normalized peer IP, not client-controlled mux source
metadata. The CP transaction enforces the account-wide deduplicated IP union
across entries/nodes. This runtime does not call a process-local count global.
The same transaction independently caps account-global active logical streams;
each mux stream counts separately even on the same client IP. A new stream at
the cap is denied while an existing admitted stream may renew. New-stream denial
closes only its logical link, not an already-admitted sibling's mux carrier.
Leases last at most 30 seconds and renew at most every 10 seconds. Independent
monotonic local expiry interrupts payload even while CP/agent polling is stalled.
A transient authority failure may consume only the last valid lease and reserved
budget; it cannot create a grant. Local per-account revoke is sticky for the
runtime revision and rechecks delayed allow responses before flow registration.

A single 4 KiB-burst token bucket is shared by upload plus download, all flows,
for each account × logical entry. Different logical entries have separate rate
buckets. CP supplies the authoritative bytes/second rate.

For finite quotas CP supplies an absolute per-presence raw-byte ceiling. Both
directions reserve bytes before admission and stop at the ceiling; low-budget
renewal requests more. CP globally reserves weighted quota before granting a
ceiling and settles monotonic admitted bytes. `Final=true` settles actual usage
and releases only proven unused reservation. Release/expiry alone does not refund
an unknown reservation. Accounting is payload admitted to the native link, not
remote receipt: Xray's writer API does not expose partial-write bytes on errors.

Native cumulative counters are observations (`ledgerMode: admission-budget`), not
a second billing ledger. They have random runtime epochs and binding-specific
counter epochs. A real all-bindings zero snapshot is fsynced before listeners
start, then the agent durably spools that baseline before subsequent samples and
keeps source cursors with its exact-ACK outbox. A final snapshot is written after
flow quiescence. There is no per-byte native WAL: a crash leaves a running marker,
blocks automatic epoch restart, and retains unsettled quota reservations for
explicit reconciliation. Neither the outbox nor zero baselines prove away a
native pre-enqueue crash gap.

## Private process interface

The verified default is inherited anonymous pipes, supplied by the agent's
extensible native process descriptor using `exec.ExtraFiles`:

| Child FD | Direction | Purpose |
| --- | --- | --- |
| 3 | read | Admission response |
| 4 | write | Admission request |
| 5 | read | Control request |
| 6 | write | Control response |

Frames use bounded, versioned, strict JSON through a small fixed-operation
stdlib RPC codec. There is no arbitrary shell command or broad RPC dispatch.
Admission calls are deadline-bounded; outstanding calls remain bounded even when
a caller cancels. EOF closes access and the owned subprocess exits. Native logs
are not IPC. The Linux supervisor additionally retains its existing process
ownership and parent-death protection.

An explicitly selected owner/peer-checked Unix-socket implementation also exists.
Its positive fixture is gated with `ROUTEWEAVER_UNIX_SOCKET_TESTS=1`; this restricted
host denied Unix socket creation, so Unix operation is **not** claimed verified.
No unauthenticated TCP fallback or host-security change was made.

## Commands and verification

Build from this directory with the pinned Go toolchain:

```
go build -o ../../bin/routeweaver-xray ./cmd/routeweaver-xray
../../bin/routeweaver-xray version
../../bin/routeweaver-xray check --config native.json --policy entry-policy.json
```

`run` additionally requires `--ipc pipes --journal-dir /absolute/private/path`
and inherited FDs. Normally the enrolled node-agent owns this process and the
admission broker. The agent requires durable meter state and an explicit meter
stream epoch; do not launch the runtime with broad CP credentials.

Public-seam tests cover native TCP/TLS payload, shared duplex rate, two-entry
synthetic IP union, local expiry, delayed-allow revoke races, retained-auth mux
rejection, natural-close cleanup, exact finite byte ceilings and crash markers.
The root integration suite covers the actual renderer → checker → process → pipe
broker path, two users' independent direct/SOCKS-transit routes, unknown UUID
rejection, selective account revoke and no exit fallback. Synthetic authority
fixtures test runtime enforcement, not CP-global reservation correctness. CP
transaction tests and the separate real-CP/native integration must be considered
alongside them before enabling finite-quota public publication.

Run nested `go test -race ./...`; run root agent/private-IPC tests and the opted-in
native integration gate as documented by `scripts/verify.sh`. Missing binaries,
gated tests and blocked host capabilities are not passing evidence.

## Platform and dependencies

The delivered agent-supervised process path is supported and positively tested on
Linux (this environment: amd64). It uses the Linux supervisor's existing pidfd
ownership checks and parent-death signal. Do not infer Windows/macOS supervised
runtime support from Go portability; unsupported supervisors remain rejected.
The module requires the pinned Go version declared in `go.mod` (currently 1.27.3).
No Xray source files are modified or vendored. Transitive libraries are selected
by Go's module graph and checked in `go.sum`; some shared Go libraries are newer
than Xray's minimum due to the root module requirements.

[Third-party notices](THIRD_PARTY_NOTICES.md) identify the linked pinned modules,
include upstream license texts, and link the official MPL-2.0 Xray source. Include
that file, `licenses/`, `go.mod` and `go.sum` with packaged managed executables.
Review notices when dependencies change, rather than assuming one upstream
license covers the whole binary. No real server or system trust store is changed
by the synthetic tests.

The opted-in agent test
`TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal` joins the
actual CLI/process, inherited broker, live VLESS flow and native journal. It
closes the broker without a supervisor signal, verifies the flow/listener/process
exit, and checks the genuine zero baseline plus exact quiescent final counters.
Three race-enabled repeats passed on 2026-10-19. This establishes local clean
shutdown, not acknowledgement of a CP final settlement across severed IPC;
unacknowledged reservations remain held under the authoritative quota protocol.
Use an immutable/versioned executable path while a supervised process is active;
replacing its executable invalidates the intentional exact-identity safety check.


## Bounded administrative connector diagnostics

Owned private control pipes optionally accept a scoped `RunDiagnostic` and exact
`CancelDiagnostic`, never shell commands or user-supplied native configuration.
The immutable renderer principal-prefix mapping selects one explicit configured
connector. An unexported Go context forces that outbound and bypasses tenant
admission/counters only for this operational task; normal VLESS clients cannot
create it. The shared `internal/diagnosticexec` adapter still validates the target,
checks every public DNS address, forwards one checked literal IP, verifies original
TLS hostname, and limits application bytes, time and concurrency. Native target
policy is not bypassed. Missing/ambiguous route mapping never uses native default.

`TestManagedDiagnosticTraversesNativeTransitAndNeverFallsBack` executes genuine
entry→VLESS transit→HTTP fixture traffic, checks replay/override denial and proves
that stopping transit fails despite a direct default. Cancellation and private EOF
close the actual native tunnel. Only test construction can authorize the exact
loopback target, and its destination policy must separately allow that literal.
Production CLI has no such diagnostic target bypass. This is core→configured
transit/exit→target evidence, not public-entry TLS or tenant-admission evidence;
provider/NIC bytes still accrue even though tenant quota is not debited.

## Ordinary TCP process policy

The managed command disables Go's default MPTCP before constructing the unchanged
upstream runtime, even when an inherited `GODEBUG` requests it. The agent also
forces ordinary TCP for supervised native processes. MPTCP socket options remain
unsupported; this does not patch the host kernel or alter existing sockets.
Direct library embedders must establish the same process policy before runtime
construction. See [verification and rollout limits](../../docs/verification/TCP-PROCESS-DEFAULTS-2026-10-31.md).
