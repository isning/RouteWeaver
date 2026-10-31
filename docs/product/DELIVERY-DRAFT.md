# Candidate first-release delivery graph

LOCAL DRAFT ONLY. These are implementation-ticket candidates for later granularity review, not Wayfinder decision tickets, GitHub issues or ready-for-agent work. The later full-capability review and eight-item bundle authorize engineering refinement, task splitting, CI/tests and development. Rework these narrow historical slices against the complete register before using them; do not await redundant blanket product approval. This does not authorize production deployment, account access or persistent credentials. No GitHub issue/publication is implied.

## Gate

Use the accepted capability register and eight-item defaults as current authority. Refine technical details, ticket granularity and dependencies autonomously within that authorization; ask only for major product trade-offs or separately gated actions. Do not fabricate capability evidence or approval. If/when GitHub exists, create real issues first and native dependencies second; never fabricate IDs.

## Candidate vertical slices

| Named candidate | User-visible outcome | Genuine blockers | Acceptance trace |
| --- | --- | --- | --- |
| Preview an administrator route | Inventory one VPS with multiple core instances and draft FRA → UK through graph/form; stable IDs and truthful capability/resource preview | Product model and compatible first journey reviewed | A01,A02,A12,A15 server portion |
| Deploy and observe a route | Validate selected real-core versions, apply to isolated test instances, observe per-target state and recover from a partial failure | Preview an administrator route; runtime capability evidence | A03,A10 plus real validation evidence |
| Invite users to an offering | Grant a usable published route to an invited user and deny cross-user/admin access; revocation propagation disclosed | Deploy and observe a route; account/security and enforcement contract reviewed | A04,A13 access portion |
| Compose a private client profile | Import synthetic source, accept reviewed refresh diff, combine with entitled route and select manual groups; no server side effects | Invite users to an offering; privacy choice | A05,A06,A07,A14 |
| Publish a rule-file subscription | Choose client target, preserve file-based rule intent, preview provenance and safely publish/export/rotate feed | Compose a private client profile; supported client/resource matrix and private delivery policy | A08,A11,A15 client portion |
| Enforce an observable allowance | Reconcile explicit provider/raw-user/weighted-allowance scopes and versioned route multipliers, expose freshness/cycle and demonstrate chosen exhausted/offline behavior | Invite users to an offering; exhaustion choice and verified counter/cycle facts | A09,A13,A16 |
| Validate invitation-scale usability | Execute complete founder and invited-user journeys, including resource refresh, partial deployment and recovery | Publish a rule-file subscription; Enforce an observable allowance | A01–A16 release checklist, especially A12 |

Each slice includes its relevant persistence/API/UI/errors and meaningful tests rather than handing off disconnected database/backend/frontend phases. Add CI/harness and dependency-boundary checks inside the first slice, not an empty infrastructure project. A nominal rule-resource interface alone does not satisfy A15; supported-file delivery and failure behavior must be exercised.

## Test and review evidence per candidate

- A reproducible local check command and equivalent CI job, synthetic fixtures and locked/versioned validators.
- Failed-before-fixed behavioral tests where practical; negative capability/permission fixtures must actually fail at the public boundary.
- One complete happy path plus meaningful failure/retry/stale-input path, with UI assertions at user-task level.
- Observed, supported, unsupported and untested states listed explicitly. Native validator success alone is not deployment or runtime parity.
- Independent review and limitations recorded. Proportionate state modeling for fencing and accounting is evidence under assumptions, not universal proof.
- No live secrets, VPS access or production changes needed to claim an isolated test result. Actual production rollout would require its own authorized plan.

## Extension seams with present value

Service Offering and Entitlement support current invited-user grants; future plans/billing can attach later. Usage Ledger supports current user/provider visibility; invoices are not modeled now. Server/client renderer contracts and runtime capability negotiation protect current semantics; third adapters plug in without a fixed two-core enum. Versioned RuleSetRefs solve current file-rule delivery and updates; no generic asset marketplace is needed. Ownership and audit scopes protect today's private sources; don't prebuild a multi-tenant SaaS management hierarchy.
