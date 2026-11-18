# RouteWeaver engineering rules

> REVIEW DRAFT. User approved the engineering-quality direction and setup defaults. Review this proposed content before making it the active AGENTS.md.

## Product and workflow

- RouteWeaver is a multi-core system. Never encode a permanent Xray/sing-box pair, boolean core selection, or duplicated two-way dispatch as the extensibility model.
- Follow the configured issue tracker and the pinned Matt Pocock Wayfinder workflow. Wayfinder decision tickets are not implementation tickets. Do not self-resolve human decisions or treat provisional architecture as accepted.
- Implement only an approved, unblocked ticket. Each implementation ticket is a demoable end-to-end slice with acceptance criteria and evidence. Read relevant glossary terms, accepted ADRs and the issue before changing code.
- Keep research and prototypes explicitly throwaway. Do not promote a prototype directly into production. No remote publication or deployment is implied by local progress.

## Module and file boundaries

- Organize by cohesive responsibility and stable domain boundaries, not by a growing generic helpers directory. A file or module should have an explainable reason to change.
- Keep business intent independent of core-native configuration, transport, UI and persistence details. Use narrow contracts at boundaries; do not leak an adapter's native types into product-facing contracts.
- A renderer translates supported intent into a core-specific artifact. It does not decide policy or silently weaken unsupported requirements. The agent's execution boundary must not become a second control plane.
- Centralize adapter registration, capability discovery and version compatibility. Adding a third adapter should not require editing every caller. These are acceptance goals, not approval of a particular implementation mechanism.
- Declare allowed dependency directions in a machine-readable architecture policy once module names are accepted. CI rejects forbidden imports, dependency cycles and undeclared boundary changes.
- Avoid arbitrary file-length limits and speculative frameworks. Split on responsibility, reduce public surface area, and justify new dependencies by their maintenance cost.

## Verification and harness

- The first implemented vertical slice includes runnable local checks and CI. Keep local and CI commands aligned through one documented entry point.
- CI runs formatting, lint/static checks, unit tests, architecture-boundary checks and relevant contract/integration tests. Use a clean checkout; do not rely on developer-only state or production credentials.
- Define supported core versions and contract fixtures explicitly. Test every advertised adapter capability with the same contract suite. An unsupported combination must be visible and rejected, not silently downgraded.
- Test retries, duplicate delivery, restarts, stale desired state, partial apply and disconnected nodes. Prefer deterministic clocks, controlled fault injection and reproducible seeds.
- Validate changed UI flows for keyboard use, focus, interrupted and repeated actions, cancellation and stale state. Keep relevant status and controls close; separate unrelated or destructive actions.
- Every ticket reports checks passed, failed and not run, with reasons. A local pass is not a remote CI pass. A mocked adapter test is not proof against a real core.

## Formal-method boundaries

- Use formal models where they reduce risk: deployment/rollback safety, authorization isolation and quota accounting. State assumptions and the exact property checked.
- Do not claim a whole system is proven from model checking, bounded exploration, property tests or a proof of one component. Tie model transitions to implementation tests and document the remaining gap.
- Choose the smallest sustainable toolchain after comparing alternatives. No formal tool or proof claim is mandated merely for appearances.

## Change discipline

- Record meaningful irreversible trade-offs in short ADRs. Review contract and dependency changes explicitly; do not bypass failing architecture tests by weakening their policy without a documented decision.
- Never put credentials or live subscriptions in fixtures, logs, snapshots or issues. Use synthetic data and redact exports.
- Keep migration and rollback consequences explicit. Do not make VPS, user-access, authentication or network changes as a side effect of local testing.
- Draft PRs and publication follow the user's authorization. Never claim remote state without verifying it.

## Agent skills

### Issue tracker

GitHub Issues is the selected tracker. The private repository target must be verified before any remote operation. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five approved default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context glossary and ADR layout. See `docs/agents/domain.md`.
