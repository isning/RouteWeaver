# RouteWeaver engineering contract

## Product
Route-oriented, multi-core control plane and thin node agent. Xray and sing-box are the initial adapters, not a closed engine enum. Preserve stable identity separately from display names. Never silently change an exit, omit unsupported policy, or mark rendered configuration as applied.

## Agent skills
Pinned reference: mattpocock/skills at 49dd158d1076134a641b33efb035946536778336. Recovered reference texts for this workspace are in `/workspace/shared/routeweaver-skills/` (tdd.md, codebase-design.md, implement-spec.md, to-tickets.md, code-review.md, tests.md, mocking.md). If absent in a different environment, read the pinned official repository paths `skills/engineering/<name>/SKILL.md`; do not guess root paths or claim an absent skill was executed. Read relevant skills before work. Wayfinder decisions and implementation tickets are separate. GitHub Issues is intended; the user created the private isning/RouteWeaver repository on 2026-10-31 and authorized source/CI delivery. Local ticket drafts remain staging evidence, not published GitHub issues. Use the authorized connector; do not create credentials, expand grants, or revive the earlier login attempt.

## Boundaries
- Domain owns intent and invariants; it must not import HTTP, SQL, or engine SDKs.
- Renderers compile intent using declared capabilities. Runtime adapters own validation/application/observations.
- API and persistence adapt domain contracts. UI never guesses deployment success.
- External subscriptions are untrusted input and tenant-private.
- Do not add a framework, public endpoint, protocol, or bypass just to make a test green.

## Verification
Use public seams: route validation, renderer contracts, repository persistence/usage/revisions, HTTP authorization, and UI user tasks. Record failing-before-passing tests where feasible. Never describe bounded exploration as a full formal proof. Separate tested, unsupported and unrun behavior. Independent review is preferred; disclose when unavailable.

## UI
Group related information and actions; one primary action per context. Preserve form values on failure. Distinguish empty/loading/error/offline/unknown states. Dangerous actions name consequences. Graph editing has a keyboard/form alternative. Include semantic labels, visible focus, responsive layout and reduced motion.

## Product copy and information hierarchy
- Default pages serve ordinary tasks: get a subscription, choose routing, manage a route. Separate viewing from editing, and editing from diagnostics.
- Do not turn agent uncertainty, test limitations, proof obligations or prototype disclaimers into product statuses. Put review limitations in delivery notes/README, not repetitive application banners.
- Show real task-specific failures with consequence and next action. Never invent health or hide a genuine failure just to make the interface cleaner.
- Keep core versions, IDs, generation fences, resource digests and meter policy revisions in contextual technical details. Surface rate, quota and effective user-facing consequences where a choice is made.
- Privacy disclosure belongs at the relevant source-import decision. Removing redundant caveats does not remove meaningful consent or security information.

## Content-design review contract
- Apply `docs/design/CONTENT-DESIGN-RULES.md`. Every visible text block needs a task role: object/action/choice/input/state/consequence/recovery. Do not automatically fill every optional subtitle or helper slot.
- Operational pages use concrete objects and actions, not slogans. Fix unclear labels or interaction before adding explanatory prose; do not replace one metaphor with another.
- Avoid repeating a fact across title, field, paragraph and empty state. Necessary target confirmation and accessibility feedback may repeat for a reason; this is not a blanket word-count limit.
- Put material consequences at the actual decision. Never hide privacy, destructive effects, unknown states or comparison limitations in tooltip-only help.
- Review actual rendered content independently of functionality and overflow tests. Fewer words and passing tests do not establish comprehension. Keep source guidance distinct from this project's synthesized rules.

## Safety
Development in the cloud workspace only. No live VPS changes, credential creation for external services, public publication, or retry of the unresolved browser login. Private source/CI publication to the user-authorized isning/RouteWeaver repository is in scope; it is not deployment permission. Never commit credentials. Server-side authentication and validation must not depend on frontend checks.

## Active delivery harness
Use scripts/verify.sh static|quick|native|full; CI invokes the same full gate. scripts/go.sh selects a real compiler and writable caches. Requested missing/skipped tests are not passes. Native parser, process liveness, traffic and deployed enforcement are different evidence; never bypass the restricted host's sing-box netlink startup denial.

Maintain docs/tickets/catalog.json and regenerate with python3 scripts/tickets.py render. All 35 stories need positive feature-ticket evidence and verified prerequisites before verified status. K06 stays deferred; Q01–Q05 are cross-cutting. The later full implementation authorization supersedes historical staging/pause language, not product constraints or external-operation permissions.

scripts/architecture-policy.json classifies production imports. New modules need deliberate classification and negative fixtures. Pure service/auth policy may support persistence; neither imports it. Preserve truthful verification scope and blockers in delivery evidence; do not weaken guards to hide an architectural mistake.

## Resource-safe verification
Keep full integration suites serialized while a live preview is running. Contributors run focused web tests with one worker; the coordinator owns the final full suite. `verify.sh` defaults web behavior tests to one worker (override with `ROUTEWEAVER_WEB_TEST_WORKERS` on a suitably provisioned host). Resource-related termination is not a passing test and is not a reason to skip assertions or extend interaction timeouts.

## User-selected visual review reference
For UI refinement, consult https://github.com/edisonmbli/refactoring-ui-skill as a design reference (requested 2026-10-20). Historical reference: this review originally preserved React/Ant Design. On 2026-10-29 the user explicitly requested migration to official shadcn/ui components and design, minimal bespoke CSS, and reasonable motion. That newer instruction supersedes the former Ant Design/no-Tailwind restriction. Preserve product contracts while using official shadcn components and semantic Tailwind tokens; honor reduced motion. Do not install scripts merely to follow the older visual reference. Audit hierarchy and grouping before cosmetic changes, distinguish rendered findings from source-only hypotheses, and record actual desktop/narrow viewport evidence. Current review: docs/design/REFACTORING-UI-AUDIT-2026-10-20.md. Existing product, safety and verification constraints remain authoritative.

## Current implementation scope (2026-10-29)

The user requested richer connection-endpoint configuration informed by 3x-ui/s-ui and a complete shadcn/ui migration with UI/UX refinement. Every exposed endpoint parameter must have explicit validation and supported rendering; never silently drop unsupported options. Keep client credentials, listener settings, published addresses and server-private TLS material separated. Managed Xray accounting capability restrictions remain authoritative. Test-site deployment is authorized to the existing owner-private Site using sample data only; this does not authorize changes to real nodes, subscriptions, credentials, or public sharing. Notify the user after completion, except for decisions that truly block progress.
