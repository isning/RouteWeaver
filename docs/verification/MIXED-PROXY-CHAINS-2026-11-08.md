# Mixed proxy chain acceptance

## Scope

The path model accepts ordered managed listeners and explicitly configured
administrator connectors. The last proxy is a position in that path, not a
separate endpoint category. The published route retains its complete physical
hop sequence and a separate managed deployment/observation projection.

No private subscription has been imported, credential copied to a real server,
or production deployment performed for this acceptance. All test network peers
and credentials are synthetic. Source import, ownership, consent, refresh and
revocation remain separate requirements.

## Completed control-plane and UI baseline

Commit: `48db101fc41cedc8f5bfbef53c82dce38080e57a`.

[Fixed focused run](https://github.com/isning/RouteWeaver/actions/runs/42495815598):

- Exact-source formatting passed.
- Race-enabled focused domain, render, HTTP API and store suites passed.
- TypeScript checking passed.
- All 38 tests in the three published-path DOM suites passed, including complete
  connector summaries, legacy edit/retarget refusal and concurrent refetch guards.
- The publication test used real enrollment, draft validation, publish, desired
  retrieval, scoped observation and credential-reveal APIs. A partially observed
  managed path did not reveal the public credential; the complete matching path did.

The [complete quality run](https://github.com/isning/RouteWeaver/actions/runs/42495815618)
also passed every required job and the final `Required repository gates`
aggregate. This includes the existing frontend, browser, HTTP, native, package
and backend suites, not only the focused mixed-path checks.

The observations in that HTTP test were synthetic. This establishes control-plane
gating, not native process execution or external-proxy reachability. The baseline
also predates the later visual mixed-path authoring changes, whose UI acceptance
is tracked separately.

## Native parsing correction

The parser gate initially did not select `TestNativeMixedConnectorChain`. Commit
`e890852810086d6464b262399edf06d2ebac90e0` added the selector and required pass
result. Its [fixed run](https://github.com/isning/RouteWeaver/actions/runs/42496501980)
then exposed an invalid parser fixture: current Xray rejected a public plaintext
VLESS upstream. Both sing-box versions and historical Xray parsed the chain.

Commit `1c970c297615e68a291d97748fc7a3201d345c07` changes only the successful native
fixture's destinations to loopback and adds an explicit current-Xray rejection
check for public plaintext VLESS. No core security control is disabled. A public
VLESS upstream must satisfy the selected core's encryption requirements.

## Isolated traffic acceptance

Commit: `1c970c297615e68a291d97748fc7a3201d345c07`.
[Fixed quality run](https://github.com/isning/RouteWeaver/actions/runs/42496974809).
The [native job](https://github.com/isning/RouteWeaver/actions/runs/42496974809/job/128781299919)
ran all nine scenarios: seven passed, two failed, none skipped. All six stock
Xray/sing-box scenarios and the managed one-external scenario passed. The two
managed multi-external scenarios failed native configuration validation before
the handshake. The runtime validator rejects all nonempty `sockopt`, including
the renderer's `dialerProxy` field. Managed multi-external traffic is therefore
not yet accepted at this checkpoint. The tests are retained unchanged while
outbound-only detour support and accounting/security boundaries are reviewed.

That follow-up must validate the full outbound reference graph and reject
unsupported alternate `proxySettings`, not just remove the socket-option check.
The unchanged pinned upstream detour does not re-enter the managed dispatcher,
so admission and user-payload metering must still occur exactly once. Because
inner dialer context cancellation differs from the ingress context, continuous
two-detour flows must also prove revocation, lease-expiry and budget enforcement,
including final usage, before managed multi-external support is accepted.

Commit `91cada604be7d16336a83210597701613f178598` adds strict outbound-only
detour validation. Its [focused runtime job](https://github.com/isning/RouteWeaver/actions/runs/42498466785/job/128785833297)
passed the race-enabled graph/socket validation tests. This is not yet proof of
continuous-flow cutoff or once-only payload accounting. Those runtime tests
must run separately.

The [91cada native rerun](https://github.com/isning/RouteWeaver/actions/runs/42498466765/job/128785833517)
then ran and passed all nine original external-peer scenarios, with zero failures
and zero skips. The two previously blocked managed multi-external paths completed
real handshakes, payload transfer, and the retained wrong-credential/removed-hop
negative checks. Each successful scenario recorded the required next hop and
actual bidirectional bytes for the initial and restored-authentication requests.
This completes that bounded traffic matrix, not the separate sustained-flow
accounting and cutoff acceptance.

`TestNativeMixedConnectorChainLoopback` selects pinned stock Xray and sing-box.
`TestManagedMixedConnectorChainLoopback` selects the built managed-Xray runtime
as ingress, with a stock transit when required. Each runs these path shapes:

- Native entry → one authenticated external SOCKS5 proxy → TCP echo target.
- Native entry → two authenticated external SOCKS5 proxies → TCP echo target.
- Native entry → two authenticated external SOCKS5 proxies → stock VLESS
  listener with one service credential → TCP echo target.

Each external proxy is an independent RFC 1928/1929 wire peer. It accepts only its
specified literal loopback successor and records authentication, successful
onward connections, destination and byte counts. Successful requests require
every hop's counters to advance and the final target to receive and return the
exact opaque payload. Connector IDs and declaration order differ from traffic
order, preventing accidental array-position or lexical sorting from satisfying
all assertions.

Each scenario also checks an unknown ingress credential, a revoked synthetic
external password, restored authentication, and physical removal of a required
external listener. Failures require both a client error and zero new target
connections/bytes during the request and a further 200 ms observation window.
This is bounded evidence, not a proof about arbitrary future delayed activity.

The supervisor validates and launches the actual generated native configuration.
Managed ingress uses a local synthetic admission broker to isolate routing; this
test does not establish production quota, subscription or billing behavior.
Native port reservations, owned process shutdown and failure evidence retention
are part of the harness. No external host or DNS name is contacted.

## Gate integrity and limits

Parser/process selectors and required-result checks include the new tests.
Missing, failed or unexpectedly skipped selected tests cannot satisfy the gates.
Twenty-seven offline shell-gate/bootstrap tests passed locally; these synthetic event tests
verify the gate behavior and are not native-runtime evidence.

The traffic matrix covers TCP SOCKS5 external connectors and VLESS listeners.
Other external protocols, UDP, production network conditions, managed-Xray
transit, arbitrary conditional graphs and tenant subscription import are not
established by this matrix. Structural mixed-protocol rendering has separate
tests. Current capability and accounting restrictions remain authoritative.

The complete repository quality aggregate must be checked independently of any
focused or individual job result. CI, not the authoring environment, supplies
the exact-source Go compilation, formatting and native execution results.
