# E09 — invited-user service-center delivery

Base: local composition `23650ca`. Related stories S01/C602 and RW-23; the
exact-selector story index leaves E09 joined-journey evidence open. Existing
cycle UI cases stop at service usage/countdown, while processing/template feed
cases do not join entitlement, download, rotation and cross-user isolation.

## New joined coverage

- `web/tests/service-center-backend.api.spec.ts`: one executed real public-HTTP
  case, using a fresh normal control-plane CLI/database/key and compiled UI.
- `web/tests/service-center-backend.ui.spec.ts`: two **authored, UNRUN** real UI
  cases at 1440×900 and 390×900, sharing the same provisioned service/entry/feed
  fixture. No intercepted API responses, saved browser sessions or admin-token
  shortcuts. Browser execution remains required before closing E09.
- `web/playwright.service-center.config.ts`: bounded standalone selection using
  the existing isolated harness, without shared demo/Vite servers. Default CI
  discovery also includes the new `.api.spec.ts` / `.ui.spec.ts` files.

The fixture accepts two real invitations as ordinary users, grants service
quota/expiry/monthly UTC+8 cycle and one entitled route, provisions separate
per-user configured platform entries, and publishes two owner feeds plus a
second user's feed through public HTTP. Feed retrieval uses a separate anonymous
request context. Both tenants intentionally use the same local profile/output
IDs, so isolation cannot rely on globally distinct IDs.

The API case verifies own service/route/grant resolution, 100 MiB allowance,
owner-specific rendered credentials, refusal of ordinary-user entry
administration, and selected-output rotation: old URL returns 404, new URL
returns identical published bytes, sibling URL/bytes remain usable, and the
other user's URL/bytes/overview remain unchanged.

The browser candidates join normal UI login, service/allowance/cycle/expiry and
route presentation, keyboard-reachable subscription retrieval, an actual file
download compared byte-for-byte in memory, exact opener focus after dismissal,
rotation cancellation preserving delivery, explicit rotation, old-link denial,
other-feed/user preservation, automatic replacement-link presentation and fresh
reopening. Actions use Tab/Enter, menu ArrowDown and Escape; focusable targets
must be in the viewport. Document/dialog horizontal bounds are checked at both
widths. No trace/video/screenshot is captured; downloaded synthetic credentials
are compared in memory and the download is deleted.

## Scope boundary

The grant uses the supported explicitly configured **legacy platform-entry**
seam, not a managed published-route principal. It does not fabricate applied
manifests or agent observations. Configured loopback endpoints are never dialed.
This evidence establishes ordinary control-plane delivery/rotation, not actual
managed forwarding, native validation, billing, physical device identity or
external-provider availability. Service/profile/output provisioning is public
HTTP setup; browser subscription *creation* is covered separately, not claimed
by this retrieval journey. No working UI or production code was changed.

## Local results

- API companion: **1 passed**, including real HTTP old-URL 404 and unchanged
  anonymous sibling/other-user feed bytes. Initial fixture-only failures were
  corrected: legacy route renderer uses `xray` (not client-only `mihomo`), and
  authorization is tested on the real entry-administration route rather than
  nonexistent GET `/api/users`. No server guard was weakened.
- Existing service overview/workspace DOM tests: **53/53 passed**, one worker.
- Strict standalone TypeScript (including Node types) passed for both tests and
  their standalone config. Discovery finds one API and two Chromium cases.
- Corrected browser cases: **pending coordinator CI**, not run locally because
  local Chromium execution is disallowed. No CI, push, native core, host-security
  change or external operation was attempted by this workstream.

Bounded local API command, from `web/` with the project toolchain environment:

    node node_modules/@playwright/test/cli.js test --config playwright.service-center.config.ts --project api

Browser execution must use the authorized coordinator CI path. Ticket/index
status remains unverified pending browser evidence and its existing prerequisites.
