# Node-agent command

Default mode is a local filesystem fixture. It starts no proxy and contacts no control plane.

```sh
scripts/go.sh run ./cmd/node-agent \
  --state-dir /tmp/routeweaver-agent-demo-new \
  --max-policy-lease 5m --demo
```

Use a new private directory for each generated demo: its generation is deliberately fixed at 1, and a later changed payload cannot reuse that generation. Returned JSON says `local_fixture_only` and `nativeChecked:false`.

`--desired FILE` consumes a strict local `agent.Desired` envelope. Native validation requires `--mode check --binary /absolute/trusted/core`, matching an exact registered adapter/version. This stages and checks bytes but leaves activation blocked, with no observed application.

A bounded native session requires all of `--mode supervise --allow-local-process --run-for 30s --binary /absolute/trusted/core`. Only use reviewed local fixtures. The command stops its owned process on normal exit, interrupt and error, and reports an unknown cleanup outcome rather than claiming success if ownership cannot be verified. It never installs a service or changes another process.

Outbound mode additionally requires:

- `--control-plane https://verified-origin` and an existing private `--token-file`; credentials are never generated or saved by this command.
- Explicit `--node-id`, `--instance-id`, `--enrollment-epoch`, `--adapter` and `--core-version`.
- Either `--run-for` in `(0,1h]` for bounded testing, or explicit `--service` for a continuous foreground process; never both. Explicit `--max-policy-lease` remains required.
- No `--demo` or `--desired` file: desired revisions come from the enrolled CP.
- Optional `--meter-stream-epoch` opens a durable outbox. No native meter collector is invented.

`--allow-loopback-http` is only for literal loopback test origins; TLS verification cannot be disabled. No outbound mode was run against a real control plane in this development pass.

The full tested/blocked/unrun matrix, wire contract and production gates are in [`internal/agent/README.md`](../../internal/agent/README.md).

## First installation without a preinstalled core

`--mode catalog --core-store /private/path/cores` starts an explicitly enrolled,
outbound management session without `--binary` or a preexisting core.
Use the existing `--control-plane`, private `--token-file`, node/instance/epoch,
`--max-policy-lease` and either `--run-for` or `--service` arguments. These inputs are operator supplied;
this mode neither enrolls a node nor issues credentials.

The agent can receive a catalog `install` request, verify and prepare the exact
release, run native version/configuration checks and report installation metadata
without starting it. Add `--allow-local-process` only when that same session is
also authorized to start/upgrade owned runtimes. Already prepared official
releases are verified and registered when reopening the store; installed files
are never overwritten. A separate managed RouteWeaver runtime must still use its
reviewed local package and managed admission/meter setup, not a stock catalog
binary masquerading as managed.

## Continuous service operation and recovery

`--service` is an explicit outbound-only foreground lifecycle, not a larger
session timeout, daemon fork, enrollment flow or service installer. Keep the
same reviewed scope, private state directory, token file, immutable executable
(or catalog store), and durable meter-stream epoch across restarts. A managed
runtime additionally requires its existing admission and meter setup. Never
reset/delete journals to work around unknown ownership or accounting backlog.

- Use an operator-managed process supervisor appropriate to the host; this
  command does not install or change one. Only one agent may own a state root.
- SIGINT/SIGTERM cancel polling and diagnostic work, then use fresh bounded
  contexts to stop the verified owned runtime, retain/drain meter evidence, and
  report the final local observation. A failed remote report is not an ACK.
  Allow at least 20 seconds for orderly exit before an external stop deadline;
  unresponsive integrations or OS/storage faults can still prevent completion.
- Restart first reopens and observes durable state. **It does not replay an old
  activation.** Manual/default deployments need a newer reviewed control-plane
  desired generation after clean stop or proven death. Explicitly reviewed Fleet
  `continuousService: true` on start/configure instead allows the CP to issue a
  fresh generation after current authorization checks and proven absence; it
  never replays the old activation. Unknown completion,
  pending launch ownership, unobserved descendants, or an unclean managed epoch
  require investigation; do not remove fences or send blind process-group kills.
- During operation, observations run serially with reconciliation, before each
  report and on the lease timer, with a one-second observation context. Cached
  conformity is not evidence that the process is still alive. Lease enforcement
  continues independently of network requests. No automatic native mutation
  retry is introduced. Adapters must honor cancellation; observation is not an
  end-to-end traffic/readiness probe.
- Bounded `--run-for` remains the default lifecycle requirement when `--service`
  is absent. Local `--desired` supervision remains bounded-only.

### Standing authorization and maintenance

`--service` only selects the agent lifecycle: it does not extend a temporary
grant. Continuous authorization additionally requires the administrator-reviewed
Fleet `continuousService` option. False/omitted keeps bounded/manual authority.
The CP revalidates unchanged permissions and inputs before issuing identity-bound,
journaled lease refreshes; offline operation still stops at the last granted
deadline. Refresh preserves native identity and immutable Desired. Published
manifest expiry advances only after the agent acknowledges the applied grant.
Individual flow and accounting-budget deadlines are not extended by this refresh.

For maintenance, queue a CP stop or non-opt-in replacement **before** stopping
the agent. Stopping only the agent does not revoke a standing running intent.
Automatic recovery is limited to three attempts per reviewed intent, with
5/10/20-second backoff. Success and renewal do not reset the budget.
`crash_loop_blocked` or `review_required` needs a fresh reviewed administrator
execution, not journal deletion. Unknown ownership never qualifies for recovery.
See [paired CP acceptance](../../docs/verification/CONTINUOUS-SERVICE-CP-2026-10-31.md)
for authority fences, status meanings and required native traffic tests.

Verified locally: foreground cancellation, actual SIGINT/SIGTERM, bounded mode,
lease restriction during a slow poll, real benign child death, and startup
leader-exit/cancellation with a live descendant. This is not a live deployment,
OS service installation, reboot/crash certification, or long-duration soak.
The Linux sing-box netlink restriction and production-host acceptance remain
separate gates; do not bypass them.
