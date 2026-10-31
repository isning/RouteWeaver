# Proposed first decision round

Status: awaiting the user's answers. This is not a resolution.

## Destination proposal

Agree on a product specification and acceptance-ready implementation plan for RouteWeaver's first usable release: manage personal routes, users, node budgets and owned external subscriptions across extensible proxy-core adapters, with a reviewed primary UI flow. The map stops at an agreed plan, not deployed software.

## First live question

Should the first release be a private tool for you as the administrator, whose main job is to publish and maintain usable routes for yourself and a small set of invited users, rather than a public airport-service platform?

Recommended answer: yes. Put routes first: create or select a route, see its egress and health, publish its subscription to an authorized user, and diagnose quota or deployment trouble in the same context. Keep nodes and cores as supporting administration, with no billing, sales or public registration.

This decides whose tasks the UI optimizes and what constitutes a successful first release. It does not settle core protocol support, topology, frontend framework or control-plane language.

## Subsequent questions, only once this answer is settled

- What is the smallest complete success scenario: for example, one invited user obtains a subscription for a FRA-entry to UK-exit ChatGPT route and can see why it is healthy or blocked?
- What should happen when a user budget or a node's provider allowance is exhausted: block, degrade, ask the administrator, or move to an explicitly permitted alternative?
- What decisions should users be allowed to make themselves, versus the administrator alone?

Do not ask these as already-resolved acceptance criteria. Recompute the frontier from the actual answer.
