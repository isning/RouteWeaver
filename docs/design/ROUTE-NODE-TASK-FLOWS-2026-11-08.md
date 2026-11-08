# Route and node task flows

## Scope

This bounded RW-01 refinement changes the task presentation of existing inventory and route operations. The baseline is commit `268fe17b87dcbe987186703505e76f1b3f962a3b`. It does not change engines, the route compiler, Agent authentication, apply semantics, accounting policy or report ordering. Saving inventory is not connecting a machine. Saving a route is not applying it.

## Route workspace contract

- The empty ordered workspace explains entry, optional intermediate nodes and final exit before requiring a selection.
- A one-listener path makes its direct final exit visible. A multiple-listener path identifies the last selected node as the direct exit without inventing an independent exit object.
- Names and addresses in an existing route represent its saved snapshot. Inventory changes remain explicit adoption decisions; labels must not silently imply that a draft now uses changed values.
- Ordering uses stable listener identities and retains existing endpoint/core compatibility checks. Graph editing remains an alternative, not the initial question.
- TLS, internal-target exceptions and complete intent stay available through progressive disclosure. Existing policies which cannot safely round-trip through ordered editing remain protected; no rules, principals, connectors, resources or default actions may be dropped.
- Draft save, validation and application remain separate actions and separate evidence.

## Server setup contract

- Keep server, core instance and listener as distinct objects, but connect their setup actions within the selected server context.
- Core creation continues in that server's setup context. Agent setup and the matching instance's report are discoverable next to listener setup rather than hidden behind an unrelated list.
- No report means no observed Agent connection. A previous report is labelled as evidence at its reported time, not asserted as live health.
- Listener creation uses the selected server and core. Do not require choosing them again or select another instance implicitly.
- Route continuation is only offered where the existing route interface can preserve the intended context. Public/client routes are not mandatory for server-only forwarding.
- Enrollment credentials retain their current one-time display, explicit rotation and failure handling. An unknown write result must not be retried automatically.

## Acceptance at existing public seams

Use UI task behavior and authorized API requests, not private component state. Cover empty/direct/multi-hop routes, saved-snapshot labels, complex-policy preservation, scoped first-server/core/listener continuation and honest report states. Exercise desktop and 390px browser journeys, keyboard operation, no horizontal overflow and actual rendered screenshots. New tests supplement rather than weaken existing safety, conflict and navigation regressions.

## Verification status

This document is a specification, not proof of completed acceptance. Record exact changed commits, test results and screenshot review in the follow-up verification record. No production machine, Agent installation, live traffic or deployment is included.
