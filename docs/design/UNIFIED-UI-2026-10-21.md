# Unified RouteWeaver workspace

> Current status (2026-10-22): the old private Site has been deleted. The product-model iteration has passed 11 real local-backend browser tasks plus 2 subsequent mobile style checks, full Web tests, root-module Go tests, and the canonical build; preview build, containment, and browser smoke checks also passed. This iteration is ready for user acceptance without a deployed Site; durable archive receipts are recorded separately and must be verified from actual submission receipts. See the [latest verification record](../verification/UNIFIED-UI-2026-10-22.md). No automatic redeployment or attachment delivery is planned.

Scope: one complete interface, not parallel simple/advanced products. Preserve React/Ant Design, complete configuration capability and real API permission boundaries. This iteration changes frontend interaction, not server/runtime enforcement.

## Implemented direction

- One workspace navigation with resource scopes and stable breadcrumbs. Administrator areas are permission-filtered, not a second navigation mode. Existing deep links remain valid.
- Subscription creation/editing uses the same ProfileEditor. Draft save remains in context; initial publication binds the resulting output identity so later updates target that subscription. Unsaved drafts remain reachable from subscriptions.
- Source import remains within configuration context, with nested draft/pending-operation dismissal protection. Sources versus processed collection is explicit rather than silent mutual clearing. Source reorder retains processing steps.
- Public routes summarize inherited topology; existing constrained custom public-scope editing remains available inline. Route-local bulk actions preserve selected deployment context; the task list is for tracking.
- Batch execution offers explicit together/sequential/canary/custom strategy and enforces the existing maximum of 20 stages without silently changing selections.
- Effective authorization is visible; inheritance, explicit selection and denial have distinct controls while retaining the API's null/empty-list/IDs semantics.
- Denser neutral surfaces, quieter account-usage panel, scope-based sidebar, consistent heading/field rhythm and retained responsive layout.

## Reference interpretation

The user supplied a saved subscription-converter page. Reuse task continuity, familiar grouping and local controls as design principles. Do not copy private data, subscription links, assets, or scripts. Its simple/advanced split is deliberately not adopted because it conflicts with the user's explicit direction. No original reference HTML is part of the Site source or deployment.

## Boundaries

The owner-private Site remains a read-only UI demonstration with fake data and blocked API writes. It is not a live VPS control plane. Source/DOM checks do not constitute visual acceptance. Pending verification must remain labeled as such.

Not claimed complete in this iteration: a maintained application-rule catalogue, per-step live conversion feedback, a backend aggregate of current runtime versus desired state, or real multi-VPS deployment acceptance. Do not represent unobserved health or capability as confirmed.

## Reusable research and verification records

- [Guideline 来源与适用边界](UX-GUIDELINE-SOURCES.md)
- [可复用 UX 方法与验收标准](UX-METHODOLOGY.md)
- [本轮问题、决定与证据登记](UX-EVIDENCE-REGISTER-2026-10-21.md)

These records separate implementation direction from current-build acceptance; historical test results are not inherited as this iteration's pass.
