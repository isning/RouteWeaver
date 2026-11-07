# Backend risk characterization scope

Baseline: `9a5a6aaf5ffb4169d82c70b5ffa6ad899ffabcf7`.
Branch: `diagnostics/backend-risk-characterization-20261107`.

This is an isolated diagnostic branch, not a production fix or a decision about
existing accounts. The added tests describe current behavior. A passing result
would establish that the characterized behavior is reachable at the tested seam,
not that the behavior is safe or approved. Do not merge these current-behavior
assertions into the acceptance branch as desired-policy regressions.

No production code, account records, schema, credentials, live node, or deployment
is changed. Local Go execution remains unrun. Executed results must be attributed
to an exact GitHub Actions commit and job, not inferred from this document or an
earlier green build.

## Future accounting anchor

`internal/store/future_anchor_characterization_test.go` uses the real temporary
store and exported policy-change, effective-policy, usage and admission methods.
It does not replace accounting with a mock or claim HTTP/UI/traffic coverage.

The scenario starts an active finite-quota entitlement before its accounting
anchor, before any budget exists. It compares the initial admission ceiling,
settlement, all-time recorded usage, cycle-window usage and the next cumulative
admission ceiling. An ordinary past-anchor control distinguishes future-window
exclusion from normal quota replenishment. Resetting modes and non-resetting
`none` remain distinct policy definitions.

A diagnostic result must not silently select the desired remedy. Decisions still
needed are:

- Whether early access belongs to an explicitly limited pre-anchor period, the
  first regular period, or must wait for an operator-reviewed schedule/anchor.
- How the decision applies to unlimited allowance and zero-weight routes, and
  whether there is any explicit rollover/carry treatment.
- How existing ledger history, live/expired unresolved reservations, old policy
  identities, manual resets and affected shared instances are migrated without
  discarding debits or blocking valid settlement.

Rejecting new settings alone does not migrate existing accounts. Pulling a cycle
start backward or gating all access at the anchor would choose policy implicitly.
External-only outputs and unrelated accounts must not be silently swept into a
managed-admission change.

## Same-generation runtime observation replay

`internal/httpapi/runtime_observation_characterization_test.go` exercises the
actual authenticated runtime observation endpoint and persistent store. It
separately checks current runtime state and retained operation-success history.

The characterization sends conformant state A, same-generation stopped state B,
and then the exact earlier A payload. It checks which current state the public
read returns, while retaining desired-generation and enrollment boundaries. This
is an accepted-replay test, not a demonstration that the normal serialized driver
creates a particular timeout/interleaving. A real decoded-handler delay after
client timeout remains a separate reproduction obligation.

The current wire state has no durable capture-order sequence. Timestamp ordering,
phase ranking and receipt-time ordering cannot define correct current state for
all legitimate conformant-to-stopped transitions. A fix needs capture-time order,
exact retry identity and an atomic server high-water/current/archive transaction.

Compatibility decisions remain necessary: sequenced reporting for new enrollments
with explicitly unchanged legacy scopes, or a reviewed fenced migration of
existing scopes that excludes old writers. Do not silently force reenrollment,
reset sequence on restart, or admit legacy writes after a sequenced cutover.
Physical node metrics use a separate sequence pipeline and are not changed here.

## Sources and next step

See `BACKEND-RISKS-SOURCE-2026-11-06.md`, and the accounting-boundary and stale
observation requirements in `../product/TECHNICAL-CONTRACTS.md`.

Review the exact diagnostic CI evidence first. Present the unresolved accounting
and compatibility choices before implementing policy or migration. After a choice
is approved, replace the characterization with regressions for that explicit
contract and add boundary, replay, concurrency, restart and migration controls.
