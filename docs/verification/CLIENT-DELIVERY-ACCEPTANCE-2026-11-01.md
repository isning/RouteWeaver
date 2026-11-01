# Downloaded-client and applied-route acceptance

Scope: single control plane, Linux reference execution, private invitations. This
record supplements, not replaces, the current production-readiness checklist.

## Evidence already present

- `TestNativePublishedManagedPrincipalEndToEnd` uses actual scoped HTTP admission,
  accepted invitation identities, immutable desired packages, native managed
  ingress and required native stock Xray transit. Credentials remain unavailable
  while queued or only partially observed. Exact applied observations unlock
  delivery. Real VLESS payload settles into the canonical ledger; independent
  principals and a shared quota are checked. The client here is a hand-written
  protocol probe, not Mihomo or sing-box.
- `TestNativeFleetConfigureStopStartAndRollback` verifies actual native forwarding
  through SOCKS. The control plane cannot mark success before the scoped report.
  Configure, stop, start, rejecting configuration and a new-generation rollback
  all have observable traffic outcomes. This is not a browser test.
- `TestNativeClientNodesOnlyConsumption`, template and override parser tests check
  emitted syntax and receiving shapes. They are not client traffic evidence.

The first two ran in the previously completed CI gate. Their exact source/run
binding must be retained by the coordinator; additions below are **not executed
native evidence yet**.

## Added joined ordinary-user client journey

`TestNativeInvitedUserDownloadedClientTraffic/{mihomo,sing-box}` runs each pinned
client with the exact bytes downloaded from the newly published authenticated
user's subscription. No generated configuration is patched after publication.

1. Create a synthetic invitation, accept through HTTP, create a private profile,
   publish and download its full configuration.
2. Another invited identity cannot retrieve the output's access information.
3. Start the actual pinned client using that downloaded file and a private data
   directory; reach a test-owned HTTP origin through the required SOCKS peer.
4. Forward `route.example.invalid` as a domain to that controlled peer. The peer
   allows only that reserved name or the origin's exact loopback IP and port;
   it never resolves a name or connects to an external destination.
5. An explicit reject rule for `blocked.example.invalid` prevents any connection
   to the upstream peer.
6. Rotate the subscription URL: the old URL returns 404, the new URL retains
   identical frozen bytes, and the already running client still works.
7. Stop the peer while the origin remains directly reachable. The client must
   fail rather than silently fall back to direct routing.
8. Revoke the feed: its current URL returns 404.

Rotation/revocation of a **download URL** is deliberately not represented as
revocation of an already downloaded proxy credential. Managed principal and
admission revocation are separate server-runtime tests.

This covers domain **delegation**, not local DNS resolver behavior, fake-IP,
split-DNS, TUN, IPv6, OS proxy installation, every endpoint protocol, WAN
reachability or ISP performance. Required multi-hop identity is covered by the
separate published-native path above; the new client test has one controlled
SOCKS peer and must not be called a multi-hop client proof.

## Execution and limits

- Explicit `ROUTEWEAVER_CLIENT_PROCESS_TESTS=mihomo,sing-box` enables both cases.
  The native CI job sets it; `scripts/native-cores.sh runtime` verifies pinned
  binary hashes first and requires both selected subtests to pass. A missing
  binary, selected skip or failed case cannot be reported as success.
- One client process at a time, 20-second process context, 5-second startup bound,
  2-second HTTP requests, 3-second fixture I/O/cleanup deadlines. No external
  traffic, TUN, network settings or production data are involved.
- Local process activation of sing-box remains prohibited by the previously
  denied host operation. Neither client was launched locally for this work.
- `TestClientDeliverySOCKSFixtureIsDestinationBounded` locally exercises the
  fixture's public SOCKS wire seam: IP/domain forwarding, refusal of foreign
  addresses and ports, and stopped-peer failure. Its passing result is only
  fixture evidence. The actual client cases remain awaiting CI execution.

## Local preparation results

- Public SOCKS fixture regression: passed, including `-race`.
- Native test compilation: passed; both process subtests skipped because the
  explicit opt-in was absent. No client-traffic pass is claimed.
- Three offline gate regressions: passed; selected-client missing/skip/fail and
  unknown selection reject, explicit partial selection reports its limit.
- Shell syntax and `git diff --check`: passed.

## Independent reject-rule proof correction

Independent review found that counting only allowlisted forwarded requests could
falsely pass the reject-rule check: a client forwarding the blocked name would
be refused by the bounded peer, without increasing that counter. The fixture now
counts every accepted TCP connection and every fully decoded SOCKS destination
request before allowlisting. After both successful IP/domain HTTP transactions
complete, exactly two peer connections/requests establish the baseline; neither
counter may change for the blocked request. This also prevents a direct-IP
positive result from masquerading as a proxied one.

The offline fixture regression forwards the blocked name and two other forbidden
destinations itself: each attempt must be recorded, and the owned origin must
receive no additional request. With the attempt increments removed through a Go
overlay, that regression fails with `refused upstream attempt was not recorded`.
With the fix, ten repetitions under `-race` pass. The three offline gate tests,
shell syntax and diff whitespace checks also pass. Actual native client process
cases remain **unrun locally**, pending authorized CI execution; this correction
does not change the downloaded feed or loosen the peer's destination allowlist.

## Configured DNS resolution addition

`TestNativeDownloadedClientConfiguredDNS/{mihomo,sing-box}` is a separate native
case. It saves an ordinary user's direct-route profile with an explicit UDP DNS
resolver through HTTP, publishes it, downloads the exact resulting configuration,
and runs the corresponding pinned client without rewriting any configuration.
A test-owned UDP resolver returns only `resolved.example.invalid` → `127.0.0.1`.
An HTTP request through the actual client's mixed listener must generate a query
to that resolver and reach the owned HTTP origin with the exact expected payload.
A fresh `unavailable.example.invalid` name returns NXDOMAIN; the client request
must fail, the resolver must observe the failed query, and the origin's request
count must not increase. Different names prevent a successful cached answer from
masking the negative case. A/AAAA traffic is supported: only A has an answer.

The fixture does not forward DNS, and all configured resolver and origin
addresses are loopback. No TUN, host resolver change, external domain lookup,
firewall change or production credential is requested. These observations prove
use of the configured resolver and one explicit NXDOMAIN failure path. They do
not establish zero DNS leaks, timeout behavior, split DNS, encrypted DNS, IPv6,
or every platform's device integration.

Local preparation verifies the UDP fixture's actual query/answer packets,
positive/negative counters and the exact published resolver address, port,
transport and selection for both adapters. This is not native execution.
The existing client-process gate now requires both DNS subtests when both clients
are selected; missing, failed or skipped DNS results fail the gate. **Actual
native configured-DNS cases remain unrun until the next authorized CI.**

Preparation results for the DNS addition: public fixture/publication regression
passed with `-race`; `go vet ./internal/httpapi`, four offline client-gate tests,
shell syntax and `git diff --check` passed. Neither native client was activated
locally. Source review and CI execution remain separate acceptance steps.
