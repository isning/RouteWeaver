# Live product review — 2026-10-20

## Scope and environment
Actual Chrome rendering and UI interaction against the cloud computer's local control plane at loopback port 8187. Synthetic demonstration records only: documentation-range server address 198.51.100.10, no live VPS, external subscription, or user credentials. Backend process predates the newly integrated ownership guard; backend guard evidence is separately recorded in instance-ownership-2026-10-20. Static UI refreshed between test batches. This is ongoing exploration, not full acceptance of all stories.

## Observed journeys and fixes
- Server → add core: original host drawer obscured the core editor. After 626f5ab, visually verified an unobstructed modal, saving a managed-Xray core returned to the same server, and its direct Add endpoint action retained exact server/core selection.
- Managed core → new endpoint: observed generic SOCKS5/1080 and shared-UUID defaults incompatible with the intended platform entry. Context-aware preset implemented in b4f015f; browser recheck pending.
- Endpoint TLS: actual editor exposes client connection fields. Source audit confirms these are subscription/transit metadata, while private server material is separately configured on the route. Contextual guidance and adapter restrictions are being refined; do not remove legitimate client metadata globally.
- Public routes with no transfer path: observed a full form whose required deployment dropdown has no options, with disabled check/save and no prerequisite action. Empty-state continuation fix pending.
- Existing browser session after static rebuild: navigating an unloaded page produced a blank app. Console confirmed failed dynamic import of the removed old hashed PublishedRoutes asset at 05:16:30 UTC. Manual reload recovered. Page error boundary/recovery fix pending; no automatic refresh permitted to discard drafts.
- Transfer path: server-first endpoint selection worked; selecting the sole endpoint generated an explicit direct-exit hop. Further save/check/publication journey still in progress.

## Integration verification
At 0199051, central serialized web suite passed 171 tests in 20 files (102.96 seconds); production typecheck/build passed. This does not cover subsequent commits until rerun. Browser overlay evidence and native/backend evidence are distinct from DOM tests.

## Independent UI review
Standards and Spec reviews of 10d0ab4...0199051 found a principal-success close null dereference, stale review/status across deployment detail identity changes, destructive discard autofocus, and misleading Flow help. Remediation is tracked in following commits; no full project-complete claim.

## Integrated follow-up through 5e20d43

- Complete quick gate at 6f9456e passed: architecture/private-file/ticket guards, Go formatting/vet/build, all main Go race tests, managed runtime vet/race/build, 212 web tests and production build. Backup 645.325s, HTTP 223.171s, store 141.438s, managed runtime 12.669s. This is not the separate full browser/native deployment gate.
- Subsequent UI-only polish through 5e20d43 passed the centralized 216-test / 24-file suite (148.16s), typecheck and build. No backend change followed the quick gate.
- Actual browser verified managed-listener defaults (VLESS, per-user credentials, required explicit port, no shared UUID), supported transport presentation, invalid route repair action, zero-start presentation, service-plan grouping, and the widened full editor with on-demand generated configuration drawer.
- Completed real local UI journey: synthetic VLESS URI import → default/ChatGPT selection → saved review → publication → subscription dialog → configuration download. Parsed downloaded JSON contained one correctly named node, two intended groups, five preset rules and the original synthetic credential. No connection to the documentation-range endpoint was attempted; no traffic/health claim follows.
- The personal overview incorrectly called merely authorized but undeployed routes available. Now labeled authorized; actual eligible-entry selection stays authoritative.
- A synthetic public certificate file was loaded after a tool approval/timeout interval; the browser showed the certificate in the unsaved form. Its private-key upload was not attempted, and that incomplete synthetic draft was discarded. This does not verify the complete TLS credential-upload flow.
- The demo control-plane process has deliberately not been restarted: its state is ephemeral and the user can inspect the shared window. New backend guards are verified in code/tests, not active in this older demo binary. No user-entered data was intentionally deleted.

### New server continuation

Observed while creating the synthetic UK inventory: saving a host returned to the list, requiring the operator to locate and reopen the just-created host to add its first core. Saving a new host now opens its detail directly, with the existing Add core action. Editing existing inventory retains its previous navigation behavior. Uses the successful API response, not an optimistic unsaved record. DOM journey was red for absent New London detail, then passed through host creation, scoped core creation, and matching host ID. Focused infrastructure tests: 20/20; typecheck and production build passed. Real-browser verification pending at this checkpoint.

Actual cloud Chrome confirmation at 260718f: created synthetic 体验 · LAX at documentation IP 198.51.100.40. Save opened its detail with Add core immediately; that action opened core creation with LAX selected. This confirms the continuation without having to find the new host in the grid. No host enrollment or real machine change occurred.

### Converter result-first preview and naming help

Real browser review created a collection from the synthetic text source, applied `{source} · {name}`, and previewed it. The default stage displayed Original input, making a successful rename look ineffective until Final result was explicitly selected. Final result did show `体验 · 文本节点 · Demo UK`. The stage tabs now lead with Final result and select it initially, retaining original/intermediate inspection. A red/green user-task test verifies both the default converted row and switching back to original input.

The add-step select also retained the previous selection instead of looking ready to add another step. It now uses an explicitly cleared controlled value. A red/green DOM test verifies its placeholder returns and the same rename action can be added twice. Naming help now includes the already-supported source-name and stable-ID placeholders, alongside name and region. Existing backend source-name tests and the actual browser result establish that source means its human label, not an opaque identifier. Focused workspace/task-experience tests and production build passed; new-build browser confirmation follows.

### Meaningful helper text and workspace context

The actual graph and converter screenshots still exposed tiny pale helper text after earlier readability fixes. Extended the bounded static contrast checks to the six observed helper/graph/path selectors: all six were red, then passed against the tested light surfaces using the existing muted-text token; meaningful 10–11 px labels now use 12 px. This is not a full accessibility audit. Removed the static green-dot “私人工作空间” badge, which appeared even in platform administration and duplicated existing navigation context. A red/green workspace test confirms management navigation remains while the misleading badge is absent. Focused checks passed 26/26 and production build passed.

## Consolidated checkpoint

Full scripts/verify.sh quick at 48d6259 passed: static/ticket/architecture guards, Go formatting/vet/build and all race tests (backup 652.551s; HTTP 221.607s; store 137.649s), managed-runtime vet/race/build (12.550s), web typecheck, 263 tests across 29 files (160.37s), and production build. This is not the full native/browser gate or live VPS acceptance. The later scoped count no-wrap style at 867d6ff passed 20 focused graph/validation/readability tests and build. The original demo backend remains unchanged; the newly added source-change connection summaries have API and DOM evidence but not completed authenticated new-backend browser acceptance.
