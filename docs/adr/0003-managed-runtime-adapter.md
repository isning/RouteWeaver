# ADR 0003: Managed runtime adapters are separate from configuration renderers

Status: accepted for local implementation, 2026-10-19.

## Context

A native configuration checker proves syntax, not account-level access control.
Whole-process shutdown is not a substitute for per-user revocation on shared
listeners. Stock runtime counters and a subscription URL alone cannot enforce
aggregate online-IP or hard finite byte allowances between control-plane polls.

## Decision

- Keep the control plane and agent in the root Go module. Engine SDKs belong in
  separately buildable `runtimes/<engine>` modules, not in render/domain/HTTP.
- The first managed adapter embeds the pinned, unchanged upstream Xray SDK. It
  has its own capability identity/version, distinct from stock Xray. This is an
  extensible adapter contract, not a two-engine enum or a promise that every
  engine implements identical effects.
- `internal/entrypolicy` owns engine-independent authenticated principal,
  admission and budget contracts. `internal/privateipc` implements the bounded,
  typed private process channel. Runtime modules import these policy/IPC root
  contracts. The route-diagnostic extension additionally permits the pure
  `diagnostics` contract and bounded `diagnosticexec` HTTP measurement adapter,
  shared with the node agent. No runtime may import the store, HTTP API or
  control-plane orchestration. The architecture guard checks both directions.
- Render a separate validated policy descriptor next to native configuration.
  Bind server-authenticated protocol identity and listener identity to immutable
  account, route, credential, policy and cycle references. A client cannot claim
  those identities in admission requests.
- Anonymous inherited pipes are the default private child-process transport.
  They do not create a listener, bearer credential or stdout control protocol.
  Optional Unix-domain transport remains separately tested where supported.
- Admission is a bounded lease with a cumulative raw-byte ceiling, reserved
  atomically against the account's weighted allowance. Both directions debit
  before payload handoff. Unreported reservation is held until exact evidence
  reconciles it; timeout is not evidence for refund.
- Default destination policy denies private/special ultimate targets. Explicit
  administrator CIDR exceptions are distinct from transit connector addresses.
  Hostname resolution validates every answer and pins the chosen address.
- Native counter baselines are real pre-listener durable zero snapshots. An
  unclean previous epoch blocks quiet reset. Durable delivery/reconciliation is
  separate from aggregate observation; do not double-charge both streams.

## Consequences and evidence boundaries

Each managed adapter needs independent native positive/negative tests and an
exact capability matrix. Stock sing-box remains useful for rendering/checking;
this decision does not claim managed account effects exist there. Unsupported
Vision/REALITY/UDP entry effects stay rejected until demonstrated.

The nested module is part of formatting, vet, race, build and full integration
CI gates. `scripts/managed-runtime.sh` requires actual loopback native process
and CP tests, and fails on skipped required cases. Real VPS rollout and public
network acceptance remain separate operator work.

Pinned upstream source and license notices ship with the managed binary. Core
upgrade paths must use immutable versioned executable paths; an in-use binary
must not be overwritten and then treated as the previously observed process.
