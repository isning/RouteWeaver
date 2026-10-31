# Local node-agent command

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
- `--run-for` in `(0,1h]` and explicit `--max-policy-lease`.
- No `--demo` or `--desired` file: desired revisions come from the enrolled CP.
- Optional `--meter-stream-epoch` opens a durable outbox. No native meter collector is invented.

`--allow-loopback-http` is only for literal loopback test origins; TLS verification cannot be disabled. No outbound mode was run against a real control plane in this development pass.

The full tested/blocked/unrun matrix, wire contract and production gates are in [`internal/agent/README.md`](../../internal/agent/README.md).

## First installation without a preinstalled core

`--mode catalog --core-store /private/path/cores` starts an explicitly enrolled,
bounded outbound management session without `--binary` or a preexisting core.
Use the existing `--control-plane`, private `--token-file`, node/instance/epoch,
`--max-policy-lease` and `--run-for` arguments. These inputs are operator supplied;
this mode neither enrolls a node nor issues credentials.

The agent can receive a catalog `install` request, verify and prepare the exact
release, run native version/configuration checks and report installation metadata
without starting it. Add `--allow-local-process` only when that same session is
also authorized to start/upgrade owned runtimes. Already prepared official
releases are verified and registered when reopening the store; installed files
are never overwritten. A separate managed RouteWeaver runtime must still use its
reviewed local package and managed admission/meter setup, not a stock catalog
binary masquerading as managed.
