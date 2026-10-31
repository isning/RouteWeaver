# Renderer contract decision evidence to collect

Status: hypotheses, not an ADR or accepted architecture.

## Decision question

Which extensibility contract lets an administrator publish a route with truthful capability previews across more than two proxy core families, without silent semantic weakening or unsafe deployment?

## Candidate design to evaluate

A core-independent product intent plus registered renderer adapters, each declaring supported core versions and capabilities. Rendering produces a versioned artifact, diagnostics and a digest; a node agent validates the artifact for its installed core before an explicit apply. Unsupported mandatory capabilities block apply with an actionable explanation instead of silently dropping them.

## Genuine alternatives

- Store native core configuration as the primary product model. Highest expressiveness, but route workflows and portability become adapter-specific.
- Define only the common subset of the first two cores. Simpler initially, but loses capabilities and risks hard-coding a permanent two-core product.
- Use capability-aware intent with controlled native extensions. More semantic validation work and compatibility testing; potentially preserves product consistency without claiming universal equivalence.

## Evidence needed before choosing

- Official versioned Xray and sing-box configuration validation and runtime-control interfaces.
- Concrete equivalent and non-equivalent route scenarios, including the proposed FRA to UK use case.
- Stats and reset semantics, per-user identity, process restart, and concurrent core instance behavior.
- How validation, apply and rollback behave after agent or control-plane disconnection.
- Secret boundaries and log/artifact redaction behavior.

Do not turn this into an accepted ADR until the trade-off is resolved. The eventual ADR should be short and record the reason for the actual choice, using the pinned domain-modeling format.
