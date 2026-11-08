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


## Verified checkpoints

Server overview and contextual-tip code is unchanged after `7a09e4f12099eaa2cc869dd07d3eb57a39e7ba77`. Test-only checkpoint `01bf9834dad43b8ad26e8b34706ac62356e4f97a` migrates legacy first-core labels, exact scoped state-read fixtures, and the ordered-hop policy-editor labels. No reveal, mutation, ownership, focus or unexpected-request guard was removed.

- [Focused run 42494562843](https://github.com/isning/RouteWeaver/actions/runs/42494562843), exact head `01bf9834`: TypeScript build and all 14 files / 272 tests passed. This includes the newly migrated onboarding, diagnostic cancellation, save-notice and policy-editor regressions.
- [Fixed product browser run 42493901985](https://github.com/isning/RouteWeaver/actions/runs/42493901985), exact head `7a09e4f`: actual 1440 / 390 / 320 px overview screenshots and 1440 / 390 px isolated-backend onboarding screenshots were retrieved and visually reviewed. Contextual tips are compact horizontal bars on desktop, stacked on mobile. No clipping or fabricated empty-state metrics were found. The overview fixtures verify zero writes and exact navigation to a failed core. Onboarding exercises actual UI saves to an isolated loopback control plane and restores focus after the tip changes.
- These are UI evidence, not live-node telemetry. Overview readings are explicit synthetic GET fixtures. Onboarding uses disposable test servers (`127.0.0.1`), without enrollment, native node processes or configuration application. No user's account or server data appears in these images.
- The full fixed checkpoint [42494616019](https://github.com/isning/RouteWeaver/actions/runs/42494616019), exact head `01bf9834`, is still asynchronous at this documentation update. It remains authoritative; no aggregate pass is claimed.
- The earlier `7a09e4f` full run exposed a separate agent lease-renewal test failure (`policy_refresh_test.go:236`, `lease_expired`) and obsolete UI request fixtures. The latter are corrected at `01bf9834`; the former is assigned for independent investigation, not suppressed or counted as a UI pass.

### Screenshot provenance

All images below are from fixed run `42493901985`, head `7a09e4f12099eaa2cc869dd07d3eb57a39e7ba77`. The overview comes from `browser-diagnostics-4-of-4` artifact `13623395135`; setup tips come from `browser-diagnostics-3-of-4` artifact `13622781580`. Images are not committed to this repository. Their hashes allow artifact copies to be checked without publishing any additional user data.

- `server-actionable-setup-1440.png`: SHA-256 `91f154ae1dfc07b21db406524e5bde1cf981f6254c6b10fbecf52042b0f3422e`
- `server-actionable-setup-390.png`: SHA-256 `d926e1b07cc6ec08e99a67dcde0a6750cf490e7057facff0a6be7c60ff2c0d15`
- `server-dashboard-overview-1440.png`: SHA-256 `ea82eabf55d2f17d3064da755ee38f53db4950796d7ecd00e06b7f1da59d94de`
- `server-dashboard-overview-320.png`: SHA-256 `f9534305c3274e89b68ab92523d50b89b3d724fd7696aafa5948f50fe26c6855`
- `server-dashboard-overview-390.png`: SHA-256 `616f30c2391ab07ec6b3e13497e966cb3bd9eaba32b9701b7ab80d44bb6f76d5`
- `server-workspace-overview-1440.png`: SHA-256 `49b22e97c340c14e20d74c76df9d917d84b14404f067c86a55eb6c6ca338a777`
- `server-workspace-overview-390.png`: SHA-256 `d08637d1e47d4c4bc5a20ec0fa0df8fac38a6b5ae01fcd31d5386158153115ab`
