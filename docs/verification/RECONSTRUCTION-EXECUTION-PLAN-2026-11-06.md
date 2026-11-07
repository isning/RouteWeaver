# Reconstruction execution plan: unrun

Source baseline: a1fbbc301378e47489660791e68f8c50fcf2b93f. Date: 2026-11-06. This is a plan, not an execution receipt or authorization. All product behavior, types, build, browser and backend checks below remain UNRUN.

## Prerequisites and permission boundary

1. Preserve the original v88 bundle and checkout. Verify the saved reconstruction bundle by hash, complete-history bundle verification, empty-repository restore and clean checkout before using it. These storage checks have been performed for saved candidates; they do not test application behavior.
2. Restore the unchanged web/package-lock.json in a dedicated reconstruction checkout only after installation and frontend execution are authorized and the environment permits the source. The lockfile's package sources are registry.npmjs.org. The read-only inventory found 129 matching cached Linux/x64 tarballs and 321 missing; a partial old node_modules is not a valid replacement. The current network allowlist does not include that registry. Do not bypass it, substitute mocks/packages, or retry denied access.
3. The proposed restoration is npm ci --ignore-scripts --no-audit --no-fund with a scoped cache. It is not currently approved or run. Do not run lifecycle scripts to repair an installation without checking the changed action. Preserve lockfile bytes and record exact tool versions from the authorized session. The repository's scripts/node-version specifies 24.22.1, not a currently verified runtime.
4. Go execution, browser/server operation, native cores, public push and deployment remain separately blocked or unapproved. In particular, verify.sh static/quick/full invoke Go or external tooling, and API/browser gates may start real local services. A frontend-only grant does not authorize them.

## Ordered frontend checks after prerequisites are satisfied

Run one suite worker and serialize aggregate runs. Do not increase timeouts or remove assertions to hide resource exhaustion.

1. Record the exact git commit/tree, clean status, lockfile digest, installed dependency integrity and explicit allowed execution scope.
2. On a separate baseline checkout, copy only the public regression test sources needed for each candidate. Preserve production baseline bytes. Run bounded new cases and record which fail for the intended public behavior, which are controls and which are infrastructure failures. Do not retroactively claim red-before-green for source-authoring that was not executed.
3. Run the same focused cases on the composed candidate. Resolve failures as product, test, setup or resource defects with specific evidence. Re-run changed source and related tests; do not generalize a local pass.
4. Run frontend typecheck, then the full serialized frontend tests and production build. The repository web gate is scripts/verify.sh web, which calls npm --prefix web run typecheck, npm --prefix web run test -- --maxWorkers=1 by default, then npm --prefix web run build. No gate was run here.
5. Persist the full logs, command lines, statuses, commit/tree and hashes with the source bundle, then independently read back the files. A count without exact-source evidence is not acceptance.

Focused regression files in web/src:
- account-security.dom.test.tsx and rotation-recovery.dom.test.tsx: lifecycle consequences, cancellation, account actions and uncertainty. Add related session integration coverage before interpreting actor guards.
- admin-task-lifecycle.dom.test.tsx: exact new quota, unsafe full-write block, unchanged bytes and raw-only cancellation.
- profile-content-hierarchy.dom.test.tsx: missing DNS final reference, explicit focus repair, malformed shape recovery and actual failed-save retention.
- rate-factor-precision.dom.test.tsx and rate-edit-continuity.dom.test.tsx: exact micros, spinbutton behavior, invalid-example suppression, raw-only draft and failed-save recovery.
- subscription-rotation-uncertainty.dom.test.tsx and replacement-access.dom.test.tsx: rotation result loss, minimum acknowledgment, explicit GET, sticky warning, remount/account ownership and ordinary success.
- policy-entitlement-edit-intent.dom.test.tsx plus relevant access-policy and control-settlement suites: six edited numeric inputs, exact scaling, explicit discard semantics, unchanged stored values, conflict/latest-context behavior.
- invite-uncertainty.dom.test.tsx, guest-required-password.dom.test.tsx and session-recovery.dom.test.tsx: uncertain creation, explicit fresh login, mode lifetime, no automatic credential replay and authoritative /auth/me.

- user-entry-effective-routes.dom.test.tsx, user-entry-task-ownership.dom.test.tsx, rotation-recovery.dom.test.tsx and workspace.dom.test.tsx: effective route precedence, deny-all, malformed shared cache, retained drafts, inventory omissions and actor ownership.
- policy-service-edit-intent.dom.test.tsx and service-policy-comparison.dom.test.tsx: raw decimal quota intent, unchanged exact bytes, correction feedback, retained copies, latest-context and creation-conflict restrictions.
- mfa-setup-dismissal.dom.test.tsx plus the existing MFA suites when separately authorized: local close/new setup and late response ownership. These two new cases do not cover unknown enable, cross-flow writes, malformed success, actor switches or same-actor rotation.

- policy-partial-audit.dom.test.tsx and the related guarded policy-editor suites: exact structured 500 versus generic uncertainty, consumed review retirement, retained inputs, cache refresh and stale owner focus. Real guarded group/user editor and full conflict/rebase acceptance remain absent.
- source-editor.dom.test.tsx, source-controls.dom.test.tsx, source-saved-failure.dom.test.tsx, source-editor-close.dom.test.tsx and navigation suites: pending/failed file selection, stale submit rejection, explicit cancellation, same-file retry, retained saved-state wording and ownership after removal.

- server-tls-editor.dom.test.tsx and route-exit-editor.dom.test.tsx: paired PEM reads, pending save/preview, same-ID listener replacement, other-listener preservation, same-file retry, cancellation and unchanged frozen uncertain operation. Native file-picker behavior and actual TLS remain unverified.
- policy-calendar.dom.test.tsx and policy-control-settlement.dom.test.tsx: run separately under TZ=UTC, TZ=America/New_York and TZ=Australia/Lord_Howe. Include calendar today/date boundary and exact unchanged timestamp string; explicitly verify locked DayPicker timezone integration.

- resource-numeric-inspection.dom.test.tsx and existing resource inspection/task lifecycle suites: exact raw interval/version intent, dirty/reset, unchanged values, arrows and stale inspection success/error. Current response-schema validation remains a separate gap.
- template-selection-recovery.dom.test.tsx and template-update-review.dom.test.tsx: processed source/collection precedence, grant availability, malformed network/cache shapes, refresh invalidation and retained bindings. Server mutation remains authoritative after these non-atomic observations.

- diagnostic-request-recovery.dom.test.tsx, managed-diagnostics.dom.test.tsx and workspace.dom.test.tsx: pre-send nonsecret persistence, exact-ID/actor/limits checks, 404 unknown, actor/generation switches, storage failure, no automatic POST replay, explicit abandonment and retired-form ownership. Same-tab browser reload, deliberately held validation ordering and real traffic/backend execution remain unverified.

- connection-fields.dom.test.tsx and related infrastructure/user-entry DOM suites: exact form text, reset, numeric correction and unchanged values. Separately authorized browser runs must include connection-port-entry.ui.spec.ts, endpoint-impact.ui.spec.ts and shadcn-endpoint-contract.ui.spec.ts for actual host dirty/discard/review journeys.
- profile-runtime-numeric.dom.test.tsx plus profile-content-hierarchy.dom.test.tsx: invalid raw mixed/DNS ports, tab retention, request/focus repair, explicit JSON replacement, unchanged accepted values and malformed DNS replacement after invalid edits. Group interval and pipeline port work is separate.

- backup-restore-outcomes.dom.test.tsx: inspection errors after file/password/reset, delayed failures, preview retirement before reinspection, failure/retry and fresh restore consent. No encryption/native archive guarantee follows from these fixtures.
- template-task-lifecycle.dom.test.tsx: source/type/position error retirement, late extraction responses, extraction/publication exclusion in both directions, retained structure after failure and fresh review. Publication uncertainty remains separate.

- subscription-origin.dom.test.tsx plus settings/admin/navigation DOM suites and route-visual-gaps.ui.spec.ts when separately authorized: exact response contract, lost/5xx/malformed activation, read failure, fresh review, cached malformed views and paused ownership. Source views do not establish DNS/TLS uptime or historical commitment.
- group-interval-intent.dom.test.tsx: existing and create-and-use groups, collapsed repeated focus, exact numbers, blank/default, manual strategy and JSON replacement. pipeline-port-intent.dom.test.tsx: source/aggregate namespace isolation, collapsed input, disabled steps, explicit discard, actual source-task removal/return and safe save/preview. Preserve existing source import and malformed DNS regression gates.
- notification-channel-draft.dom.test.tsx and related notification settings suites: repeat/SMTP exact raw values, dirty/collapsed state, native sender mismatch, thresholds/count/duplicates/order/empty lists, secret replacement/removal, revisions and retry. Invitation blank/default semantics have a separate regression scope below.

- rate-pending-boundary.dom.test.tsx plus rate editor suites: successive boundaries, maximum delay, clock setback, render-to-effect crossing, cleanup and no new HTTP polling. Real browser throttling and clock jumps remain separate.
- observation-footer.dom.test.tsx and diagnostic-numeric-intent.dom.test.tsx: exact units/bytes, unlimited mode, min/max, partial input, consent replacement and explicit stepping. Re-run diagnostic request/abandonment/session suites; do not infer native visual-spinner, wheel or locale parity.
- fleet-numeric-intent.dom.test.tsx, publication-lease-intent.dom.test.tsx and published-route-port-intent.dom.test.tsx: default/blank/exact bounds, disabled targets, strategy changes, stale reviews, renewed approval and discard/deployment replacement.
- bundle-access-recovery.dom.test.tsx and existing subscription/session suites: token versus cookie transport, fixed destination, auth/body errors, token revision, direct unmount and nested review return. Browser/native saving and real-client import remain separately unverified.
- inbox-read-state.dom.test.tsx and fleet-continuous-service.dom.test.tsx: per-event concurrent errors, guarded fresh acknowledgement, selected-body updates, continued polling after terminal/error observations and focus retention during refresh/error. Persisted observations must never imply actual online state.

- collection-preview-layout.dom.test.tsx: stable selection through reorder/label change/removal, no selection resurrection, removed-tab-owned focus fallback and nearest reveal without stealing unrelated focus.
- invite-task-lifecycle.dom.test.tsx: exact expiry, initial 72, explicit blank/default omission, bounds, raw dirty/revert/discard, ArrowUp/Down semantics, failed request preservation and pending duplicates.
- rule-import-recovery.dom.test.tsx, rule-files.dom.test.tsx and async-action-accessibility.dom.test.tsx: failed selection/clear/cancel/same-file retry, delayed local reads, synchronous browser read failure, abandoned post-session-wait dispatch and late HTTP feedback. The server opened-revision gap remains separate.
- infrastructure-creation.dom.test.tsx: pending enrollment duplicate/Cancel/Escape, task replacement, warning transitions, explicit rejection/retry control and no mutation-result token caching. Real secret issuance, lost-response recovery and safe unknown-outcome retry are not covered.
- navigation.dom.test.tsx, route-exit-editor.dom.test.tsx and workspace-shell.dom.test.tsx: hidden unresolved save protection, aggregation of multiple consequences plus ordinary drafts, cancellation/confirmed departure and owner cleanup. Browser-native unload uses browser-controlled text and forced departure loses in-memory recovery.
- Native-output optional-review documentation is checked against existing backend/UI source only. Backend creation/review/CAS/receipt tests remain separately unrun and need explicit backend execution permission.

The existing vitest configuration includes all src test files and tests/**/*.test.ts. Use the package's installed test binary through its declared script; do not download another version to obtain a pass. The full frontend count will differ from the historical missing v137 result and cannot restore that result's source identity.

## Page/state acceptance still required

Once browser/server access is separately authorized, review the actual composed application against a real test backend using synthetic accounts/data: desktop and narrow viewport; keyboard-only focus/return focus; loading/empty/failed/offline/unknown states; cancellation without writes; pending duplicate prevention; stale owner departure; draft repair and retry; meaningful consequence copy. Use no live nodes, personal credentials or real subscriptions without their separate scope.

For numeric controls, verify typing, incomplete strings, arrows, clear, blur, units and screen-reader labels. UserPolicy can normalize a valid spelling after exact settlement; explicit raw discard retains the visibly reported current value, not necessarily the opening value.

For unknown operations, inspect the actual wire calls: no automatic replay; current-state reads are not historical receipts. Security MFA unknown-operation recovery remains outside the reconstructed security candidate. Local MFA dismissal cleanup is included separately, but current success payloads remain unvalidated and success feedback can precede authoritative reconciliation. The shared write-owner contract is still absent. Subscription uncertainty is in memory per account epoch; invitation warning is per form mode. Diagnostic request metadata is actor-bound in same-tab sessionStorage; its explicit abandonment loses recovery and may permit duplicate traffic. Test the documented loss of other reminders on reload/logout/mode exit and do not describe them as durable recovery.

A full web pass still does not establish backend enforcement, real-client correctness, deployed operation, all-page acceptance or recovery of all v89–v137 changes. The source-only backend risk plan records future-anchor and observation-ordering hypotheses, product/migration decisions and unrun matrices. Do not mark those risks closed from frontend checks.
