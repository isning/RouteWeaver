# Find RouteWeaver's first usable release

> UNPUBLISHED DRAFT. Destination and frontier require live user discussion. No ticket is resolved and no linked issue is implied.

## Destination

Agree on a product specification and acceptance-ready implementation plan for RouteWeaver's first usable release: personal route management, users, node budgets and owned external subscriptions across extensible proxy-core adapters, with a reviewed primary UI flow. Stop at an agreed plan, not deployed software.

## Notes

- Follow the pinned Matt Pocock setup, wayfinder, grilling, domain-modeling, prototype and to-tickets workflows.
- Multi-core architecture, not a fixed dual-core architecture. Xray and sing-box are initial adapter candidates, not an exhaustive core enum.
- User-facing layout should follow tasks and proximity: related status, controls and explanations belong together; unrelated operations stay apart. 3x-ui is a visual reference, not a requirement to copy its information architecture.
- Prefer Go or Rust for control-plane and thin-node-agent candidates; final technical boundaries remain open.
- Known planning inputs to verify before budget enforcement: UK 2 TB/month, FRA 800 GB counted IN+OUT, LAX reported unlimited. Provider units, cycle anchors, scope, counters and actual constraints are not yet verified.
- No billing. Owned external airport subscriptions are in the intended product scope; ingestion, credential handling and trust boundaries remain to be resolved.

## Decisions so far

<!-- Empty until a real decision ticket is resolved. Existing requirements are context, not invented completed tickets. -->

## Not yet specified

- Release scope and primary user journey, followed by exact success and failure criteria.
- Route topology, application matching and what FRA-entry to UK-exit means for inbound and onward traffic.
- Whether product routes can be rendered equivalently across initial supported core versions, and how unsupported capabilities appear before apply.
- Quota ownership, provider counter reconciliation, reset cycles and offline enforcement.
- External subscription lifecycle, refresh failures, provenance and handling of imported credentials.
- Preview, apply, rollback and recovery expectations for partial multi-node failure.
- UI information architecture, three competing layouts and user feedback, then accessibility and interaction acceptance criteria.
- Deployment, authentication, recovery and initial installation expectations.

## Out of scope

- Billing, payment collection and subscription sales.
- Production implementation or VPS changes during this planning map.
- Treating Xray and sing-box as a permanent two-core limit.
