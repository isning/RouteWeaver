# Local delivery graph

Full implementation of the 35 confirmed stories was authorized after product review on 2026-10-19. This supersedes the former seven-item exploratory plan and historical pause. Routine engineering/breakdown decisions are delegated; significant product changes still require review.

GitHub remains the intended tracker, but authentication was declined. These are local tickets, not published GitHub issues. Do not retry authentication or publish without new authorization.

## Maintenance

- catalog.json is the editable source: stable ticket ID, stories, true blocking edges, public seams, acceptance, status and evidence.
- RW-01.md through RW-24.md are generated one file per ticket. Run python3 scripts/tickets.py render after catalog edits.
- python3 scripts/tickets.py check rejects cycles, unknown blockers, missing story coverage, deferred-story inclusion, stale generated files and evidence-free completion.
- python3 scripts/tickets.py frontier prints unverified tickets with verified prerequisites. IDs are stable identifiers, not mandatory numerical execution order.
- All 35 stories have feature-ticket coverage independently of the final integration ticket. K06 server automatic failover stays deferred. Q01–Q05 apply across every slice.

## Status and evidence

planned means no acceptance claim. in_progress means implementation/integration is active but prerequisites may still gate final acceptance. blocked means a specific reported blocker prevents remaining acceptance. verified requires all acceptance behavior, positive evidence and verified prerequisites.

Checklists are reviewed acceptance criteria, not automatically checked by green unit tests. A type, document, disabled button, unsupported diagnostic, syntax-only core check or fixture-only UI test cannot close a story. Evidence records commands, exact behavior/target/version and a test/report. Preserve distinctions among parser, process, traffic, privileged enforcement and real-VPS evidence.

## Slice index

- RW-01: Create and validate direct or multi-hop routes.
- RW-02: Invite and manage local accounts securely.
- RW-03: Grant services and inspect effective access.
- RW-04: Import private sources without unsafe fetching.
- RW-05: Preview ordered source processing stages.
- RW-06: Compose reusable ordered collections.
- RW-07: Save independent full client profiles.
- RW-08: Configure nested client strategy groups.
- RW-09: Edit ordered rules and resource references.
- RW-10: Manage runtime settings and native overrides.
- RW-11: Render and verify actual client outputs.
- RW-12: Publish and rotate multiple subscriptions.
- RW-13: Account route usage and reset periods.
- RW-14: Enforce online-IP and entry limits.
- RW-15: Apply and recover staged local revisions.
- RW-16: Operate scoped fleet batches.
- RW-17: Track provider resources separately.
- RW-18: Diagnose connectivity and notify operators.
- RW-19: Publish announcements and audit reminders.
- RW-20: Reuse versioned templates and presets.
- RW-21: Restore encrypted backups safely.
- RW-22: Configure and maintain the platform.
- RW-23: Use the complete service subscription center.
- RW-24: Verify complete integration and recovery.

Each feature slice spans user behavior, persistence/API, UI and tests as applicable. Shared foundations are part of useful slices, not an indefinite horizontal infrastructure phase. The current shared integration checkout uses disjoint ownership; combined checks must rerun after worker changes.
