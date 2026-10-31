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

The owner selected **one control-plane instance, Linux nodes and a private,
invitation-only service** on 2026-10-31. This is the acceptance profile, not
authorization to deploy. Multiple control-plane replicas, public self-registration
and macOS node execution are outside this release's production claim. User and
node counts, target hardware and an availability objective are not yet specified.
Synthetic 5/500-user fixtures are test points, not a supported-capacity promise.

- Storage, key custody, TLS/public origin, access, backup/restore and upgrade/recovery plan for the chosen host. No deployment, real credential creation, VPS/cluster mutation or public sharing is implied by repository work.
- Representative real client and applied-runtime routing/failure/restart/rollback evidence. Native parser success is syntax, not traffic or quota enforcement. Stock and managed adapters have different capability evidence.
- Genuine upgrade to a second reviewed supported upstream core release plus recovery; same-version reinstall/synthetic revision does not satisfy this.
- Deployment-appropriate capacity measurements and operating limits. Local warm-history performance is not a production SLA.
- Platform gates: Linux checks do not prove macOS execution, Developer ID signing or notarization. Known local sing-box netlink and Chromium security denials remain scoped host blockers, not permission to bypass them.

Unchosen or unauthorized deployment does **not** block independent source/CI/UX improvement. Conversely, a mature repository does not authorize deployment or close operational acceptance by itself.

### Single-instance private-service acceptance record

Before calling a deployment production-ready, record the target host, exact
source/package/core hashes, operator approval, date and results for each item:

1. One participating control-plane writer, private durable storage and protected
   encryption-key custody. Confirm a second service/recovery process refuses the
   same database and aliases; do not replace the live database inode.
2. HTTPS origin and trusted-proxy boundaries, invitation-only onboarding,
   administrator MFA/recovery and session revocation. Verify ordinary users
   cannot access other users' private resources or administrator actions.
3. Linux distribution/kernel security status and supported core versions.
   Application-level MPTCP defaults are not a kernel patch or protection for
   unrelated processes. Withdrawn core receipts remain identifiable for safe stop;
   they do not authorize new activation or renewal.
4. Reviewed node enrollment, ordinary client traffic and the intended route,
   failure, restart and revocation behavior. Explicit continuous-service opt-in
   must survive original lease expiry without treating intent as observed health;
   revocation and bounded crash recovery must still work.
5. Encrypted backup and restore to a separate private location, including the
   correct key, accounting obligations and notification state. Measure restore
   time and test the documented upgrade/recovery path; do not assume in-place
   downgrade is safe after schema or notification migration.
6. Representative measured load and a stated observation window covering normal
   usage, renewal, restart and backup activity. Record CPU, memory, disk growth,
   latency, errors, notification progress and accounting/lease behavior. Define
   acceptable thresholds and recovery objectives for the actual service before
   the test; an arbitrary short green run is not a soak result.

Until those deployment results exist, report repository verification and
operational readiness separately. Never convert unrun checks into a pass.
