# Subscription domain activation recovery candidate

This is a bounded source reconstruction of the v96 historical summary, not recovery of original commit 0000e88d640f8a8566da289f75e0f328ee7d15f2 or its exact bytes. Base: 5b350433fec764acb47a330d750f9da20e0fb096.

## Source contract

Read `internal/httpapi/subscription_origin.go`, `web/src/api.ts`, and the existing public DOM tests. Activation fences the reviewed revision, checks the saved draft's proof, persists the effective origin/configured revision, increments revision, then returns a view. The read endpoint does not activate. Empty effective/draft origins deliberately use the configured default, including relative links when the default is empty. No backend changes were made.

## Candidate behavior

- Validate GET views before rendering/authorizing writes, including safe nonnegative revision integers, revision ordering, required fields, statuses, link examples, optional timestamps, and the unchanged-token assertion.
- Validate activation success against the reviewed draft, configured revision, incremented revision, effective origin, and activation timestamp. Lost responses, 5xx, invalid JSON, and structurally invalid or mismatched 2xx enter uncertain recovery.
- Keep the error and read-only recovery action inside the activation dialog. Dismissal exposes recovery on the page instead; it does not unlock writes. Synchronous write/read locks supplement disabled controls.
- A failed/malformed/regressed recovery read cannot unlock writes. A valid authoritative read clears the old review and checkbox, without replaying the POST or claiming the request committed. Any remaining activation requires opening and confirming a new review. Typed input remains unchanged. Refresh output links after reconciliation.
- Known 409/422 handling remains the existing refresh path, not an invented backend retry contract.

## Public regression source

Added parameterized component tests through DOM actions and the fetch boundary for lost response, HTTP 503, invalid JSON, incomplete JSON, and mismatched target response; failed/malformed recovery reads; a fresh review requirement; and dismissal followed by reading an already-applied result with exactly one activation write. Adjusted the existing successful activation fixture to include the backend's activation timestamp.

## Verification and limitations

All behavioral verification is **UNRUN**. No Node/npm, Go/gofmt, build, browser, server, install, network, push, deploy, or upload was used. Git whitespace checking and manual source review only are not compilation or runtime proof. The repository's referenced `/workspace/shared/routeweaver-skills` files were absent; network fetching was prohibited, so those pinned references were not read. Repository AGENTS.md, content rules, and the available software-engineering skill were read.

This is not a general distributed-operation ledger. Recovery is component-local; remounts reload authoritative state and require the ordinary fresh review. Validation does not prove server freshness, deployment behavior, DNS/TLS availability, or actual client reload. Known rejection refresh behavior and save/verify mutation uncertainty remain outside this activation-specific reconstruction. The public fixtures are not real-backend evidence. Type checking, focused DOM tests, full regression gates, independent runtime/visual review, and real-backend acceptance still need authorized execution.

## Follow-up source review corrections

Independent source review identified inconsistent fixtures and a validation bypass through shared-cache writes. The follow-up adds query `select` validation so consumer views do not trust cache insertion alone. Query errors block write controls even if React Query retains the last valid selected view. Save/verify responses now receive the same structural validation before cache acceptance, draft replacement, or success messages. This is acknowledgment validation only: malformed save/verify results use their ordinary task error path, preserve old valid state/input, and do **not** gain the activation-specific uncertainty lock or reconciliation contract. They may already have committed on the server; callers must read current state before deciding to repeat them. This remaining risk is not fixed or classified as known rejection by this reconstruction.

Activation dispatch receives a frozen snapshot captured at confirmation, rather than reading a mutable review closure later. The mutation checks current review identity and authoritative revision before dispatch; a replaced/unmounted source cannot authorize that delayed request. Late callbacks must still belong to the live review. Activation explicitly disables mutation retries.

Fixture audit corrected the two draft/example inconsistencies in `subscription-origin.dom.test.tsx`; completed backend-view fields in admin-task-lifecycle, settings-tab-continuity, settings-read-first, and navigation-focus DOM fixtures; and aligned route-visual-gaps examples with the backend's literal `{existing-token}` placeholder and configured default. No assertions were removed or schema validation weakened. Public test source additionally covers malformed save/verify acknowledgments, malformed cache insertion, and a paused activation whose source revision changes before dispatch.

All new and existing behavior tests, type checking, rendering, and formatting execution remain **UNRUN**. Fixture consistency was inspected as text only; no runtime pass is claimed.
