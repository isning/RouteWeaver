# Engineering baseline decision plan

Status: user approved maintainability, clear module boundaries, CI, harness, agent rules, testing and proportionate formal methods. Concrete architecture and tools below remain proposals. This document is not an implementation ticket.

## Outcome

The first accepted end-to-end route-management slice should already fail safely when contracts drift, show a reviewer how to reproduce its checks, and carry explicit verification limits. Avoid building a large generic foundation with no demonstrable user outcome.

## Decisions to expose in the map

1. What minimum architectural boundaries preserve a route-oriented product while letting independently versioned adapters and node execution evolve? Compare a modular single deployable control plane against prematurely distributed services. Go/Rust is a preference, not a silently finalized stack.
2. What real-core validation and integration tests are feasible in isolated CI for the supported initial versions, and which tests need privileged or networked runners? Research official core validation interfaces before choosing harness commands.
3. Which safety properties justify a formal model, and how is each model tied to implementation behavior? Start with a small model, explicit assumptions and a bounded state space rather than a sprawling framework.

## Candidate boundary map, not approved module names

- Product policy: routes, access and budgets; no core-native configuration.
- Application orchestration: intent validation, planning and lifecycle coordination.
- Renderer registry and adapter contracts: discovery, supported versions and capabilities, diagnostics and deterministic artifacts.
- Node execution: report observed state, validate and apply assigned revisions, recover safely; no policy authoring.
- Infrastructure adapters: persistence, transport, external subscription retrieval and core process integration.
- Presentation: UI and API surfaces exposing the same product semantics.

Freeze allowed dependencies only after the boundary decision. Then derive executable checks from that policy; do not invent an empty architecture test that always passes.

## Harness acceptance goals for the first vertical slice

- One local command performs the same required checks as CI.
- Fast deterministic unit tests plus the minimum genuine adapter-contract and end-to-end test for that slice.
- Synthetic fixtures, no live subscriber credentials, no VPS access, explicit core binary/version provenance.
- Forbidden dependency fixture proves that the architecture checker detects a violation.
- Test matrix reports supported, unsupported and untested combinations separately.
- Fault scenarios include duplicate apply requests, offline nodes and restart after partial progress where relevant to the slice.
- Store reproducible evidence and document how CI failures are diagnosed.

## Candidate properties, requiring semantic decisions first

| Area | Candidate property | Assumptions that must be decided | Evidence, not blanket proof |
| --- | --- | --- | --- |
| Apply/rollback | Observed active revision is a validated revision; stale requests cannot overwrite a newer accepted generation | Single or multiple writers, generation fencing, atomicity provided by the core, crash/restart model | Small state-machine model plus fault-injection traces matched to implementation |
| Access | A user cannot retrieve or use a route or credential outside their grant | Identity source, revocation delay, offline-node policy, subscription bearer-token scope | Policy properties plus negative API/agent integration tests |
| Quota accounting | Each accepted measurement contributes at most once to the relevant ledger; resets do not resurrect spent allowance | Counter reset semantics, epochs, provider IN+OUT versus user accounting, allowed overshoot while offline | Property tests plus bounded model of reset/retry/race cases |
| Extensibility | Unsupported intent cannot become a successful apply through silent omission | Capability definition and version compatibility contract | Shared adapter tests, negative fixtures and real-core validation |

Do not promise strict zero quota overshoot while disconnected without deciding local enforcement, counter precision and bounded reporting delay. Provider allowance and user quota are distinct ledgers until their relationship is defined.

## First implementation-ticket shape, later

After product decisions, propose a narrow user-visible route lifecycle slice with schema, API, UI, real adapter validation and tests together. Its CI/harness and architecture-policy checks belong to its acceptance criteria, not a separate months-long horizontal infrastructure phase. The user reviews granularity and blockers before tickets are published.
