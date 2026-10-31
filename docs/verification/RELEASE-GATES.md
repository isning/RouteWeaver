# Repository and deployment acceptance

These are evidence requirements, not certification, publication permission, ticket closure or a claim that all 35 stories are complete. Historical checkpoint reports remain historical. This recovery began from delivered WIP51 source v60; later unrecovered WIP52/53 notes are design intent, not recovered code or renewed test results.

## Repository delivery (continue without live infrastructure)

- Complete frontend, control-plane and node-agent source; locked dependencies, documented commands and operator boundaries.
- Source contracts, secret content/history scan, backend/race tests, web types/behavior/build, real HTTP API tests, Chromium user-task tests, native parser/process/managed-loopback tests, and deterministic Linux package/smoke. The configured CI aggregate requires every job to report success; missing/skipped/cancelled is failure.
- Exact remote source commit and **actual target-repository CI** evidence. Local success is not a GitHub Actions pass. A source recovery commit is not the historical commit recorded in the delivered archive.
- Authenticated actual-backend subscription journey: obtain, configure, publish, download, rotate and old-link denial; keyboard/narrow/focus/dialog recovery. API-only requests and intercepted browser fixtures do not close this browser requirement. Static migration of selectors is not an executed browser result.
- Source-bound package: full source content manifest, actual commit/dirty state, archive checksum, same-host rebuild equality and successful extracted-package smoke bound to that archive. The receipt is not signing/notarization or deployed acceptance.
- Content/UX review of all relevant pages/dialogs, not only representative screenshots or automated assertions. Report limitations separately, never as invented product states.

These gates can fail independently. Fix authorized code and test defects; do not weaken assertions or convert host denials into successful skips.

## Operator deployment (requires a chosen environment and explicit authorization)

- Storage, key custody, TLS/public origin, access, backup/restore and upgrade/recovery plan for the chosen host. No deployment, real credential creation, VPS/cluster mutation or public sharing is implied by repository work.
- Representative real client and applied-runtime routing/failure/restart/rollback evidence. Native parser success is syntax, not traffic or quota enforcement. Stock and managed adapters have different capability evidence.
- Genuine upgrade to a second reviewed supported upstream core release plus recovery; same-version reinstall/synthetic revision does not satisfy this.
- Deployment-appropriate capacity measurements and operating limits. Local warm-history performance is not a production SLA.
- Platform gates: Linux checks do not prove macOS execution, Developer ID signing or notarization. Known local sing-box netlink and Chromium security denials remain scoped host blockers, not permission to bypass them.

Unchosen or unauthorized deployment does **not** block independent source/CI/UX improvement. Conversely, a mature repository does not authorize deployment or close operational acceptance by itself.
