# RouteWeaver product review packet

Status: IMPLEMENTATION AUTHORIZED, 2026-10-19 UTC, under the full capability register and accepted eight-item defaults (user message Sentinel_937013b99c00819183687dc7057530d4). Engineering refinement, task splitting, CI/tests and development may proceed autonomously; major product trade-offs require review. Existing prototype code is not completion evidence. Real VPS deployment, account authorization and persistent credentials remain separately gated. No tracker/publication or production result is implied.

Current review entry point: [能力与 User Story 核对清单](CAPABILITY-REGISTER.md). The user requested an incremental capability review before implementation and confirmed a substantially fuller subscription converter plus the platform’s own subscription center. This register supersedes any narrower scope inferred from v0.3 or prior delivery slices; it does not imply blanket approval of acceptance details. Administrator groups are now confirmed at target-scope level; IP/rate/over-limit and access policies are confirmed in the register; exact timing and execution evidence remain engineering work. The five detailed cluster/route operations groups are also confirmed at target-scope level. Server-side automatic failover is now explicitly deferred by agreement, without removing confirmed client-side fallback strategies. Four reuse/platform-maintenance groups are also confirmed. The register contains 35 target-scope User Stories, plus the deferred failover record and separate engineering quality gates; the specifically accepted business defaults are authoritative, while remaining technical criteria require refinement and verification. Older SPEC/UI/delivery drafts will be reconciled group by group, not treated as the scope ceiling.

[The concise Chinese UX review](REVIEW.md) remains useful for interaction direction, not a complete capability inventory. Detailed references follow:

Read in this order:
1. [Product specification](SPEC.md): audience, scope, journeys, acceptance and test seams.
2. [Domain model](DOMAIN-MODEL.md): object identities, lifecycles and invariants.
3. [Interaction design](INTERACTIONS.md): graph, composition and action states.
4. [Page-level UI specification](UI-SPEC.md): screen structure, action placement and recovery; not a rendered prototype.
5. [Decision map](DECISION-MAP.md): confirmed evidence and open frontier.
6. [Verified rule-format evidence](RULE-COMPATIBILITY.md): official format facts vs proposed contracts.
7. [Technical contracts](TECHNICAL-CONTRACTS.md): proposed IR/API contracts, generation fencing, rules and multiplier accounting; not runtime evidence.
8. [Candidate delivery graph](DELIVERY-DRAFT.md): local implementation-ticket candidates, not ready-for-agent work.

Labels used throughout: **Confirmed** means directly supported by the supplied user conversation; **Proposed** means a reviewable default, not approval; **Open** means a consequential choice or missing fact. All unmarked design details are Proposed.

Method: official Matt Pocock skills at 49dd158d1076134a641b33efb035946536778336, specifically wayfinder, domain-modeling (and glossary format), to-spec and productivity/grilling. This is a synthesis, not a simulated interview. The publication and live seam-review steps cannot be completed by writing local files. No issue IDs, approvals, native dependency relationships or completed decision tickets are fabricated.

Historical staging notes describe an empty repository and no production code. That description is stale: exploratory Go/React code now exists. The initial-stack ADR records an earlier stack choice, but neither that choice nor the prototype settles this product specification. In particular, its Node combines physical server, core and endpoint, its Route embeds user IDs and a single engine, and validation limits paths to two hops. These conflict with the proposed durable model and must not become product requirements by inertia. No implementation was modified in this product task.

Latest design revision: [task-first UX review](UX-REVIEW.md) records the user-requested simplification and supersedes the original editor-first default. See [offline prototype](../design/prototype/README.md) for current design-only artifacts and actual verification limits.
