# Secondary security and recovery review — 2026-10-19

## Scope and fixed point

Independent review of M01/M02 and A05/M04 notification contracts, not a remote pull request or deployment approval. Fixed baseline: empty commit `d4f66d2bf7b5a0e4fe024b79c8f61438eaf77fb8`; implementation checkpoint: `2f670b1a1670e2fd8f7c1f901b5aa374de0ead2b`. Comparison: `git diff d4f66d2...HEAD`, plus relevant working-tree changes. The only commit between those points is the implementation WIP checkpoint. Initial review/test capture was 18:47–18:54 UTC on 2026-10-19. Remediation recheck completed at 19:00 UTC.

Reviewed `internal/reuse`, `internal/backup`, `internal/notifications`, `internal/resources/{outbound,fetch}.go`, relevant store and HTTP adapters, and Backup/Templates/Notifications UI contracts. Active managed-runtime, admission-budget and node-observation work is not a completed-slice finding or a target of this review. No owner production files were changed during the independent finding phase. The later authorized notification clock fix is recorded below. Initial adversarial tests were added only to an isolated `/tmp/routeweaver-secondary-review-20261019` copy; their text and results are retained [beside this report](secondary-review-2026-10-19/).

Exact reviewed production/test hashes are in [snapshot.sha256](secondary-review-2026-10-19/snapshot.sha256). In particular, the reviewed uncommitted `PublicHostname` hardening and SMTP tests are included, not mistaken for checkpoint code. Later edits require revalidation against those hashes.

Sources: `AGENTS.md`; `docs/product/CAPABILITY-REGISTER.md` M01/M02/A05/M04 and Q01–Q05; `docs/design/template-reuse.md`; backup and notification READMEs; pinned `code-review` and `codebase-design` reference texts. `docs/reviews/notifications-local-2026-10-19.md` was treated as implementation evidence, not independent sign-off. Standards and Spec are reported separately. This is one independent reviewer, not two independent axis sign-offs.

## Standards axis

**No additional hard standards breach demonstrated in this bounded scope.** Tenant decisions remain server-side; reusable policy is separate from SQL/HTTP; the age and standard SMTP implementations avoid a new cryptographic/wire framework; external delivery lives behind a transport interface. The repository's multi-record compare-and-put interface meaningfully hides atomic persistence complexity rather than merely forwarding calls.

**Maintainability observation, not a hard violation:** notification history, settings, secrets, read receipts and outbox share one encrypted JSON record. Each dispatch claim/completion decodes, scans and rewrites the entire retained history (`internal/store/notifications.go:21–34`, `internal/notifications/service.go:297–302,376–400`). The small public interface is useful, but an append-only history makes its implementation cost grow. Preserve that interface if storage later needs indexed event/delivery rows; do not introduce a message broker merely for abstraction's sake. No production-load benchmark or capacity claim is established here.

## Spec axis: findings at the initial captured snapshot

All findings below were **P2 and open at the initial snapshot**. The remediation section below supersedes their original status. No P0/P1 exploit or observed cross-tenant secret disclosure was established.

### S1. Preset preview does not bind the resolved private source material

- Location: `internal/httpapi/templates.go:409–410,481–488,528–533`.
- Contract: template design says the digest covers the “resolved candidate” and concurrent edits require a fresh preview (`docs/design/template-reuse.md:83–87`). The implementation comment additionally promises user source material.
- Reproduction: after previewing preset v2, update the owned source endpoint from synthetic `192.0.2.10` to `192.0.2.20`. The second preview's rendered artifact changes, but its digest remains identical; applying the original digest returns **200**, not 409. `TestSecondaryPresetDigestRejectsChangedSource` fails through authenticated HTTP.
- Cause: the collection candidate hashes only the collection object, not its resolved endpoints/snapshots or dependent-profile inputs. Compare-and-put fences only target and relationship. Profile materialization also has a read-to-commit dependency window, although that race was statically identified, not deterministically interleaved in this reproduction.
- Minimal repair: carry the exact materialization/dependent inputs into the preview fingerprint and commit comparisons. Fence dependency-list membership as well as existing records so a newly added dependent cannot escape validation. Keep the resulting change draft-only.

### S2. Restore validation accepts missing known relational state

- Location: `internal/store/backup.go:295–324`.
- Contract: M02 calls for validation of user/authorization/configuration/history links; backup README promises known bearer-token links and generation state validation. Current validation proves existing feed indexes point to outputs, not the reverse, and checks counters only for shape/uniqueness/nonnegative values.
- Reproduction: remove the feed index from a synthetic snapshot containing a published output; fresh restore succeeds. Separately, create `agent-desired/instance` through generation 3, remove its counter, and restore. The next `GenerateRecord` returns **1**. Both `TestSecondaryBackup...` negative tests fail through exported store interfaces.
- Limits: these fixtures intentionally alter an authenticated logical snapshot. This is **not** evidence normal export loses rows or that unauthenticated ciphertext edits pass age verification. Current export faithfully retains rows that exist.
- Minimal repair: validate both directions for known active output/index links, and require known generation-bearing records to have sufficient matching fences. Preserve legitimate counter tombstones. Reject rather than silently invent missing authorization/history state; retain opaque unknown record kinds.

### S3. Batched notifications reuse an expired batch-start clock

- Location: `internal/notifications/service.go:287–288,314–320,350–352,395`.
- Contract: notification README promises a one-minute in-flight lease and 1/2/4/8-minute retry waits, with current validity checks.
- Reproduction: queue six synthetic webhook test events, use a fake transport that takes 13 seconds for each of the first five, then inspect the sixth claim. It is newly claimed with a lease already **5.03 seconds expired**. `TestSecondaryDispatchLeaseUsesActualClaimTime` fails after 65.03 seconds without an external network action.
- Impact: a concurrent dispatcher can take a still-active claim, consuming attempts and duplicating a send without a crash. Expiry checks and retry deadlines likewise use stale time. This is additional to, not a contradiction of, the documented unavoidable at-least-once crash window.
- Minimal repair: obtain current time per claim/completion, with an internal testable clock or elapsed-time projection. Derive leases, validity and backoff from those times, not the start of a batch of up to 100 sends.

### S4. Template update UI mixes versions and cannot remove obsolete slots

- Location: `web/src/Templates.tsx:140–159,302–313,357–370` and subsequent slot editors; backend exact-slot check at `internal/reuse/spec.go:191–203`.
- Contract: the same bindings and reviewed candidate must be submitted on apply; fixed-version selection must stay fixed, and replacement bindings must be usable when versions change.
- Static evidence: opening a pinned reference sets `updateVersion` to undefined while the form displays `appliedVersion`; `updateSpec` then falls back to the **latest** library spec. Also, `updateBindings` starts with the old maps, and editors only add/replace keys for the next spec's visible slots. A slot removed upstream remains in the submitted map, cannot be removed through the form, and is correctly rejected by the backend as extra.
- Minimal repair: use one effective candidate version throughout; canonicalize both preview and apply bindings to that exact spec. Preserve applicable user choices. **Browser reproduction was not run for this finding**, because the UI was actively changing; do not count static inspection as an end-to-end UI pass.

### S5. Announcement UI promises external delivery that is not queued

- Location: `web/src/Notifications.tsx:388–390`; `internal/notifications/service.go:101–107`.
- Evidence: announcement copy says enabled automatic external channels will execute. `Evaluate` always queues announcement delivery as `[]string{"in-app"}`. Account reminders also intentionally stay in-app; only explicit provider observations use automatic external operator channels, and that source is not integrated yet.
- Minimal repair within current behavior: state that announcements are in-app. Do not silently add external sends or imply the current source is active. Whether broader A05 external reminder coverage is complete remains a product acceptance question, not proven by successful explicit channel tests.

## Verified passes and limits

### Executed passes

1. Existing focused Go behavior tests passed for reuse, resources, notifications, backup, store and HTTP adapters in the captured tree. This includes identity/tenant isolation, invalid-settings preservation, secret redaction, copy/pinned/follow behavior, personal overrides, last-published fallback, snapshot consistency, authenticated backup rejection, fresh-target restore and explicit restore confirmation.
2. Targeted `-race` tests passed for resources, notifications, backup, store and HTTP adapters; [exact output](secondary-review-2026-10-19/targeted-race.log). The first targeted reuse regex matched no tests; a separate `go test -race ./internal/reuse ./internal/notifications -skip '^TestSecondary' -count=1` passed actual tests (1.045s and 1.329s). A “no tests to run” line is not counted as reuse verification.
3. `TestNativeTemplateFollowedProfileUpdate` passed with pinned Mihomo **1.19.32** and sing-box **1.14.3** binaries, traversing selection, followed update, native parser check and publication. [Exact output](secondary-review-2026-10-19/native-template.log). This is parser acceptance, not process startup, traffic, reachability or deployed enforcement.
4. Local TLS fixture tests passed SMTP TLS/STARTTLS, hostname rejection/no plaintext fallback, DATA acceptance, Webhook HMAC payloads/stable event IDs, rejected responses and shared public-address/DNS-pinned policy tests. No real SMTP provider, recipient or external Webhook was contacted.

### Security conclusions limited to inspected/tested behavior

- Full backup uses authenticated age encryption; untrusted work factor, archive/plaintext size and concurrent HTTP KDF work are bounded. Admin authorization and session CSRF precede handlers.
- Restore uses a private staging directory, one import transaction, durable reopen/snapshot comparison, mode 0600 database and no-replace hard link. Existing targets/symlinks are not overwritten. Live store activation is deliberately separate and reported `activated: false`.
- Structural template schemas exclude connection credentials/source URLs; own-tenant binding checks and redacted preview artifacts remain enforced. Administrator-authored free text is not a DLP guarantee.
- SMTP verifies TLS on the original hostname after checked-IP dialing. Webhook forbids credential-bearing authority/query/fragment forms, private/special addresses, proxies and redirects. Settings/outbox/audit paths inspected do not return SMTP passwords/signing secrets or raw transport errors.
- Notification audience changes and read receipts are checked against current announcement records; status means `available`/remote `accepted`, never asserted end-recipient delivery. S3 qualifies the batch-time guarantee.

### Unknown / not established

No full-repository green gate is claimed; concurrent active work was outside this review. No crash/power-loss fault injection at filesystem durability boundaries, live deployment, OS-level credential memory-erasure proof, production-volume benchmark, real-provider deliverability, or full UI interaction run was performed. The configured restore parent directory is an operator trust assumption: files/staging are restrictive, but existing parent-directory permissions are not independently enforced by the HTTP adapter. The remediation recheck below is bounded to these fixes; concurrent provider/observation integration is not independently accepted here.

## Backup growth: factual capacity limit, not invented load

`MaxSnapshotBytes` is **15 MiB**, `MaxArchiveBytes` **16 MiB**, and total snapshot rows are capped at **100,000**. These are hard rejection limits, not paging thresholds. All metering inbox/receipt/ledger history is retained and included. `counter_ingestion.go:300–305,344–350` adds a ledger row per applicable sample plus inbox/receipt records per accepted batch; this observation does not assume a deployment rate.

A serialized synthetic `store.MeterRecord` wrapped as a backup row was **443 bytes**. Even ignoring every other record, table and JSON framing, the 15 MiB limit fits only approximately **35,424** such rows, below the 100,000-row cap. [Reproducible measurement](secondary-review-2026-10-19/capacity-repro.go.txt). Different identifiers/payloads change the result; no real time-to-limit was measured. Because storage can keep growing while export rejects, operational readiness needs a supported growth/retention or streaming-backup decision before relying on this as the sole production recovery path. Do not silently delete history or merely raise a memory-bound limit during this review.

## Reproduction artifacts and conclusion

The retained `*-repro.go.txt` files are inert evidence, not registered repository tests. Copy each into the matching `internal/<package>/secondary_review_test.go` only in an isolated copy, then run `scripts/go.sh test ./internal/httpapi ./internal/store -run '^TestSecondary(Backup|Preset)' -count=1 -v` and `scripts/go.sh test ./internal/notifications -run '^TestSecondaryDispatchLeaseUsesActualClaimTime$' -count=1 -v`. The latter takes approximately 65 seconds. [Negative output](secondary-review-2026-10-19/template-backup-regressions.log), [lease output](secondary-review-2026-10-19/notification-lease-regression.log).

Initial summary: **Standards: 0 demonstrated hard violations, 1 maintainability observation. Spec: 5 P2 findings, including three dynamically demonstrated regression categories and two static UI-contract findings.** The existing positive tests and secure defaults are useful evidence, not closure of these findings or completion of every M01/M02/A05/M04 prerequisite.


## Remediation recheck — 19:00 UTC

[Remediation hashes](secondary-review-2026-10-19/remediation.sha256) identify the rechecked files separately from the original snapshot. Findings and original red evidence above are retained, not rewritten as initial passes.

- **S1 fixed within reviewed scope.** Candidate materialization now caches exact tenant source/resource/collection/platform-grant inputs; its digest includes those inputs. Commit compares them and profile-set membership in the same transaction, catching dependent additions/removals. The original HTTP source-change regression now reports `same digest=false` and rejects stale apply; the new-dependent HTTP test passes. Repository related-record and set-membership CAS tests pass with `-race`. [HTTP/store results](secondary-review-2026-10-19/template-backup-fixed.log), [CAS results](secondary-review-2026-10-19/cas-remediation-race.log). The pinned Mihomo/sing-box template native-parser workflow was rerun after this fix and passed ([output](secondary-review-2026-10-19/native-template-fixed.log)). This freezes draft materialization inputs, not every current service-entitlement/managed-runtime condition; publication and live access still perform their own checks. No claim of exhaustive scheduler interleaving coverage is made.
- **S2 fixed for the demonstrated known relationships.** `backup_relationships.go` validates active output-to-feed-index links and sufficient `agent-desired`/published-manifest generation fences. Both original negative tests now pass; the additional test rejects a behind fence while allowing a safe ahead tombstone. Arbitrary opaque future record kinds are still not semantically validated. [Results](secondary-review-2026-10-19/template-backup-fixed.log).
- **S3 fixed and rerun.** The reviewer implemented this narrowly authorized remediation, so its initial finding was independent but its post-fix implementation check is not a second independent code review. Production advances the caller's logical time by monotonic elapsed time and reads it per claim/completion. HTTP calls now supply fresh dispatch timestamps after evaluation/audit. The production public interface is unchanged; a test-only clock seam supports real-repository behavioral tests. The three deterministic regressions fail on a frozen-clock variant and pass on the fix, covering six sequential 13-second-equivalent attempts, a full delay after transport failure, and expiry while queued. The original **65-second real-elapsed reproduction also passes**: the sixth newly claimed lease has **59.9985 seconds remaining**, rather than being expired. [Deterministic red](secondary-review-2026-10-19/clock-deterministic-red.log), [real-time and deterministic green](secondary-review-2026-10-19/notification-lease-fixed.log). All notification tests pass with `-race`; targeted resources/HTTP/store race tests also pass ([output](secondary-review-2026-10-19/remediation-targeted-race.log)). The existing restart test resumes at its persisted retry due time rather than assuming transport completed instantly.
- **S4 fixed at code and DOM/HTTP seam.** The form now uses one effective version, prunes bindings for that version, and applies the exact stored preview input. The UI implementation's executed regressions “shows and previews the exact pinned template version rather than the latest spec” and “drops removed template slots and submits the same exact version and bindings on preview and apply” failed before and passed after. Evidence reviewed: [red](secondary-review-2026-10-19/ui-regressions-red.log), [green](secondary-review-2026-10-19/ui-regressions-green.log). These are React/user-event/jsdom tests with mocked HTTP, not rendered-browser acceptance.
- **S5 fixed.** Announcement copy now explicitly states in-app-only delivery, no email/Webhook send. The matching DOM regression failed before and passed after in the same evidence (37/37 post-fix suite). Separate provider-source integration appeared during remediation and is not used to backdate the initial channel-capability claim or establish real-provider delivery.

**Current scoped outcome:** all five recorded P2 findings have fixes with the bounded evidence above. No outstanding reproduced defect from this review remains. Backup growth limits and whole-state notification-history cost remain operational/design risks, not resolved by these fixes. Broader story completion, a full clean repository gate, real external delivery, runtime enforcement and deployment readiness remain unclaimed.
