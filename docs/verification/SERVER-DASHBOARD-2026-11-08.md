# Server overview checkpoint — 2026-11-08

## Task and design

Replace the persistent four-card setup checklist with one contextual, actionable tip. After configuration exists, the overview prioritizes actual resource observations and recorded core phases. Read-only overview controls do not enroll agents, apply configurations or change live servers.

References consulted: [Cloudscape static dashboard](https://cloudscape.design/patterns/general/service-dashboard/static-dashboard/) for task-prioritized overview, resource context and mobile ordering; [Cloudscape feedback mechanisms](https://cloudscape.design/patterns/general/user-feedback/) for brief contextual messages with a specific next action. These are design references, not a claim of vendor certification or a copied dashboard.

- The setup tip shows only the next configuration step, retaining exact host/listener identity and explicit choice when several cores or listeners exist.
- CPU, available memory, selected billed-NIC traffic and provider balance come from existing observability responses. No invented usage history, uptime or online percentage.
- Core phases are explicitly platform records, not heartbeats. A pending generation does not become the previous nested failure.
- Resource sample and quota have independent timestamps and freshness. Failed refreshes retain prior readings and show failure. Missing and malformed readings remain distinct from zero.
- Provider admission restrictions name the new-connection/renewal consequence and link to resource/quota review.
- Saving the first listener may replace its tip. Focus returns to the stable server heading when the editor closes.

## Evidence status at first push

- Oxc syntax transform passed the changed TS/TSX source and test files.
- Focused test attempt before implementation failed at the then-missing ServerOverview module. This is an import-stage red result, not executed assertion evidence.
- The local workspace lacks the current shadcn dependency set and complete runnable checkout. Typecheck, DOM and browser results are pending asynchronous CI; no local runtime pass is claimed.
- Added DOM cases for zero/null measurements, independent stale quota, cached refresh failure, missing samples, quota restrictions and generation precedence. Existing server task regressions retain navigation, ownership and focus behavior.
- Added a browser pixel fixture at 1440, 390 and 320 px using explicit synthetic GET responses. It verifies the actual UI and scoped core navigation, not live-node telemetry. Existing isolated-backend setup journeys remain separate and do not replace responses.
- Full Repository quality remains authoritative. Focused workflow is supplemental only.
