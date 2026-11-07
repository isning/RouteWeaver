# First managed public-line setup: joined browser regression source

Status: **implemented test source; browser execution and pixel acceptance unrun**.
Authored against `2dad5e22678716b12c28fcdf2fba45fc3b386c12`, with unrelated resource
and overlay work left untouched. No production behavior or diagnostic copy changes.

## Agreed public seam

`web/tests/forwarding-setup-backend.ui.spec.ts` adds one bounded scenario at
1440×900 and 390×900 using `isolated-control-plane-fixture.ts`. Each case uses the
built UI, a fresh normal-CLI database/key, ordinary administrator login, real
HTTP persistence and public reads. None of the server, core, listener, forwarding
path or public-line objects under test is created through setup API writes.

The scenario joins:

1. Empty inventory → UI server registration → the same server's setup detail.
2. Scoped core creation → managed Xray 26.3.27-rw1 → its scoped VLESS-principals
   listener. Blank port rejects without saving; Cancel/Continue retains input.
   An explicitly entered port saves with the exact host/core identity and no
   invented shared credential or TLS. The credential assertion uses the existing
   explicit administrator reveal read, not the intentionally redacted list.
3. Keyboard-operated server/endpoint selectors → sequence/graph/sequence
   continuity → forwarding draft save. Public reads verify the exact identities.
   The missing-principals renderer diagnostic remains real and is captured.
4. Public-line configuration → genuine backend refusal of an unencrypted VLESS
   public hostname → retained input → correction to loopback → successful check.
   The reserved `.example.test` hostname is metadata, never fetched or resolved
   by this task. No TLS requirement or network restriction is bypassed.
5. Editing the public port invalidates the check → explicit recheck → explicit
   save → reload with the same line/path/listener and draft/unconfirmed status.

The final public-state checks require an unregistered instance with no desired
configuration or observed state, unchanged forwarding draft and empty fleet
history. An exact eight-request mutation ledger excludes enrollment, user
provisioning, grants, server validation/publication, fleet execution and duplicate
blank-port saves. Public GETs, including explicit endpoint reveal, are separate
from that mutation ledger and are not represented as side-effect-free auditing.

## Existing evidence this does not duplicate

- `infrastructure-creation.dom.test.tsx` proves scoped continuation/defaults with
  controlled HTTP data, not this real-backend browser chain.
- `public-routes-notifications.api.spec.ts` creates the chain through HTTP and
  proves private-principal/unregistered-state contracts, not setup controls.
- `product-model.ui.spec.ts`'s operator-continuity case starts with seeded
  infrastructure and follows line/user context through a non-executing plan.
- `route-exit-backend.ui.spec.ts` checks an existing route's exit replacement.
- `publication-native.native.spec.ts` and the accepted native-recovery journey
  start with API-seeded infrastructure. Their owned-process observation evidence
  is unchanged and is not a prerequisite for this no-application setup task.

## Requested captures, not completed visual findings

The test requests six naturally settled viewport captures per width: same-host
continuation, managed listener's explicit-port error, saved path awaiting
principals, retained public-host/TLS refusal, rechecked line decision and saved
line without application. It reuses `ui-settled-task.ts`; it does not disable
motion or add arbitrary sleeps. Selected horizontal geometry and decision-footer
visibility assertions do not replace independent review of the generated pixels.

The current first-path guidance needs review: `server_deployments.go` deliberately
saves the incomplete managed draft, `internal/render/principals.go` reports
`MANAGED_PRINCIPALS_REQUIRED`, and `ServerRoutes.tsx` presents generic path-repair
advice. The current source suggests that completing public-line/user-entry setup
may be a more useful next step than editing the path. **No new runtime or pixel
finding is claimed, and this patch does not change that guidance.** Inspect the
actual captured state before proposing a production correction.

## Verification and limits

- Installed Node's TypeScript-stripping syntax check passes for the new spec.
  It parses syntax only; it does not resolve imports or type-check Playwright.
- Repository ticket consistency and whitespace checks pass for this source slice.
- `web/node_modules` is absent in this checkout. Browser execution, dependency-
  resolved TypeScript checking, builds and independent pixel review remain
  **unrun**, not skipped passes. No packages or alternate cached runtime were used.
- No test or CI-shard timeout was extended. Existing isolated-build fixture
  budgets and the ordinary 45-second browser-case budget remain unchanged.

When the normal project dependencies are available, the coordinator should run
the new spec with the existing Chromium project and one worker, then independently
inspect its twelve state captures and exact-source aggregate CI. Any selector,
layout, timeout or product failure must be reported and corrected rather than
hidden by weakening assertions or extending the shard budget.

Scope excludes complete keyboard traversal, assistive-technology testing,
multi-hop forwarding, graph editing, alternate protocols/TLS, duplicate names,
listener refresh, user grants, principal creation, native startup, proxy traffic,
live-node operations and unresolved accounting/observation policy decisions.
The test uses focused keyboard selection; it is not a whole keyboard-accessibility
claim. No staging, publication or deployment was performed by this worker.
