# Independent security and contract review, 2026-10-19

## Scope and method

This reviews the initial, uncommitted implementation against `AGENTS.md`, the
capability register, ADRs and technical contracts. It is not a review of a diff
against a release or a claim that all 35 stories are complete. The code was
changing during review; findings were rechecked against refreshed copies.

Review concentrated on HTTP tenant/auth/feed isolation, durable agent fences
and process ownership, accounting, hostile source import, and resource-fetch
SSRF controls. Synthetic credentials, isolated databases and local fixtures
only were used. The reviewer did not change production code. Implementing
authors corrected the findings below.

Severity: P1 means access/enforcement can remain incorrectly authorized; P2
means a material correctness, privacy or process-ownership defect. Evidence
distinguishes an observed failing-before-passing test from code/interleaving
analysis. Locations name the current remediation seam, not immutable commit
line numbers.

## Spec axis

1. **P1, corrected: accepted revocation reused an older allowed lease.**
   `internal/agent/reconciler.go`, `Submit` / `effectivePolicy` / `restrictLocked`.
   Generation 2 with denied access blocked the candidate but left generation 1
   running under its older allowed policy. An independent fixture failed with
   `decision="allowed" phase="blocked"`; after correction it stops/restricts the
   old runtime. Latest accepted restrictive policy has precedence over the
   last-valid deployment. Repository regression:
   `TestAcceptedRevokedPolicyStopsOldRuntimeInsteadOfReusingLease`.

2. **P1, corrected: first activation with an uncertain acknowledgment escaped
   lease expiry.** `internal/agent/reconciler.go`, `EnforcePolicy`, and
   `internal/agent/driver.go`, lease tick. If activation had actually started
   but acknowledgment failed, `LastValid` was empty and enforcement returned
   without restricting it. An independent lost-acknowledgment fixture observed
   the expired generation still running, then passed after enforcement used
   the current payload when no last-valid payload exists. Repository regression:
   `TestExpiredFirstActivationWithLostAcknowledgementStillRestricts`.

3. **P1, corrected: re-enrollment did not invalidate the previous enrollment.**
   `internal/httpapi/agent.go`, `agentIdentity` and enrollment transaction.
   Code review found old token records still accepted and partial identity
   comparison on observations. Re-enrollment now revokes the old token and
   writes the new enrollment atomically; each request checks active enrollment,
   and reported identities are compared in full. Verification: current-code
   inspection and the HTTP package suite, including
   `TestServerPublicationIsScopedDesiredNotApplied`, not an independently
   scheduled enrollment-race experiment.

4. **P1, corrected: a feed continued delivering platform credentials after
   route access was removed.** `internal/httpapi/outputs.go`, `publish` / `feed`.
   An independent HTTP test removed the user's route assignment after
   publication and still received HTTP 200 containing the synthetic password.
   The corrected output freezes grant/route/version/connection dependencies
   from the materialized compilation; fetch checks their current eligibility.
   The same fixture now denies delivery. Credential changes without a new
   version are rejected by the administration path.

5. **P2, corrected: anniversary cycles inherited the plan's creation anchor.**
   `internal/httpapi/admin.go`, entitlement update. A January plan anchor and
   April user activation incorrectly saved January as the user's anniversary.
   An independent HTTP regression observed this, then passed after the anchor
   was instantiated from user activation. Unchanged renewal retains the prior
   anchor. A plan is a cadence template, not a shared user-cycle anchor.

6. **P2, corrected: REALITY short IDs leaked through redacted previews.**
   `internal/httpapi/redaction.go` and `tenant.go`, preview handlers.
   Independent synthetic tests exposed the exact short ID in profile and
   collection previews. Profile/artifact redaction now uses deep-copy endpoint
   redaction and a centralized compiled-artifact secret traversal, after
   validation. Source/profile summaries are redacted; explicit owner-scoped
   reveal supports editing. Collection preview now uses the same helper; the
   independent source-import-to-collection-preview fixture is green, including
   a fresh race-detector rerun after that final correction.

7. **P2, corrected: public rule delivery was conflated with record ownership.**
   `internal/domain/profile.go`, `RuleResource`; renderer resource checks;
   `internal/httpapi/tenant.go`, resource materialization. A tenant-owned
   resource could not use public remote delivery because any owner made it
   "private." Visibility is now explicit and independent of owner; omission
   remains private. Independent positive HTTP tests passed for both Mihomo and
   sing-box: save a public remote resource, resolve it in a profile, and retain
   the file URL in compiled output. A different tenant cannot reference that
   resource record. This tests compilation, not remote retrieval or client
   enforcement of a digest.

8. **P2, corrected: REALITY credential material contributed to public imported
   endpoint identity.** `internal/importer/identity.go`, `locationKey`.
   A fixture with a previous snapshot and only its short ID rotated changed
   endpoint identity. This was independently observed failing, then passing.
   The location key now includes only source/protocol/canonical host/port;
   credential and optional transport fields are excluded. Previous-snapshot
   reconciliation distinguishes same-location accounts and rejects ambiguous
   replacement rather than silently reassociating them. Repository regression:
   `TestRealityCredentialRotationDoesNotAffectIdentity`.

## Standards axis

1. **P2, corrected: ownership-check-to-process-group-signal race.**
   `internal/agent/supervisor_linux.go`, `Stop`. Checking `/proc` identity and
   then signaling `-pid` was not atomic; after exit/reaping the numeric process
   group could be reused. This was code/interleaving analysis, not a claimed
   reproduced PID-reuse attack. Linux stop now acquires a pidfd before the
   final ownership check and signals only that leader. Unobserved descendants
   block action; bounded-command cancellation uses the stable process handle.
   No arbitrary process-group mutation remains in that path.

2. **P2, corrected: atomic writes without compare-and-swap could resurrect a
   revoked output.** `internal/store/token_index.go`,
   `CompareAndPutWithToken`; output publish/rotate/revoke callers. The analyzed
   interleaving was: rotate reads published output; revoke commits; stale
   rotate commits a new published token. Full expected-record comparison is
   now inside the SQLite transaction, alongside record and index changes.
   Repository regression: `TestCASCannotResurrectRevokedRecord`. The independent
   review verified the transaction rather than claiming a forced HTTP race.

3. **P2, corrected: duplicated policy/format knowledge made adapters brittle.**
   Inventory accepted only a hardcoded pair of engine names; HTTP source
   parsing separately guessed formats and disagreed with the importer. The
   current inventory validates extensible adapter IDs, while execution remains
   gated by the adapter registry. HTTP delegates format detection to the
   importer. Shared redaction similarly reduces secret-field omissions; the
   missed collection callsite above illustrates why all callsites matter.

## Independent execution evidence

At approximately 18:10 UTC, a refreshed isolated copy completed:

    scripts/go.sh test -race -count=1 ./internal/httpapi ./internal/store \
      ./internal/service ./internal/resources ./internal/importer ./internal/agent

All six packages passed. Native-process opt-in variables were not set; this
does not count skipped native tests as passed. Additional independent HTTP and
agent probes covered the exact scenarios described above. Later targeted
checks confirmed the public remote-resource path for both targets and the
short-ID identity fix. The developer's closed-writer regression
`TestClosedAgentCannotOverwriteNewWritersFence` also passed independently.

At approximately 18:14 UTC, after another refresh of the current tree, all
independent `TestReview*` probes in HTTP, importer and agent packages passed
with the race detector. This included the collection-preview short-ID fix,
both positive public-remote-rule targets plus cross-tenant rejection, and the
short-ID rotation identity fix. These extra probes were run in an isolated
copy rather than added to production test files; the scenarios and outcomes
above preserve their evidence, while named repository regressions provide
ongoing coverage where stated.

The fetcher review found no additional bypass in the inspected HTTPS-only,
redirect revalidation, mixed-DNS rejection, literal-IP pinned dialing,
proxy-disabled transport, bounded-body and timeout paths. Fixture tests passed;
no external network attack was attempted and this is not a completeness proof.

Legacy unattributed usage was explicitly retired with HTTP 422 directing
callers to scoped meter ingestion; it was not counted as a working second
accounting path. An early stale-copy concern about silently dropped legacy TLS
was withdrawn after the current validator was checked and its probe passed.

## Limits and remaining acceptance

This is scoped independent review, not penetration-test certification, an
unbounded formal proof, or production readiness. No live VPS, external account
credential, public feed, or remote CI environment was changed. Existing
sing-box process startup and Chromium sandbox restrictions were not retried or
bypassed. Native parsing, process observation, route traffic, quota/rate/session
enforcement, and all-story product acceptance remain separate evidence.
Native per-user aggregate rate limiting and session termination are not
established by this review and remain an implementation/acceptance gap, not a
passed capability. These limits belong in verification and delivery records,
not as repetitive product-interface disclaimers.
