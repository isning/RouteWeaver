# Integrated security and product-contract review, 2026-10-19

## Scope, independence and snapshots

One independent reviewer examined the integrated working tree against checkpoint
`3aa2bd3cee428baa606d43bcc2f502654f567a78`, starting at 19:22 UTC. `HEAD` was that
checkpoint; `git diff 3aa2bd3...HEAD` and its commit list were empty. The actual
review inputs were `git diff 3aa2bd3` **plus untracked implementation files**, not
an asserted nonempty committed PR diff. Standards and specification axes are
separate below; they are not two independent reviewer sign-offs.

Sources: `AGENTS.md`, `docs/product/CAPABILITY-REGISTER.md`, ADR 0003, the two
previous security reports, current control-plane/diagnostics/native-override
notes, and the pinned code-review reference. Previous corrected findings were
not counted again. The reviewer did not edit production source. Implementing
owners made the corrections described below.

Primary scope: managed Xray admission/destination/IPC, CP reservations and
revocation, native client composition/redaction, direct-node diagnostics,
fleet staged execution/rollback, immutable install/transition, and streaming
backup. Review and tests used an isolated copy with an immutable copied managed
binary, synthetic identities, temporary databases, and loopback targets only.
No external target, real credential, VPS, OS trust store or remote account was
used or modified.

- [Initial isolated primary-scope hashes](integrated-review-2026-10-19/snapshot-isolated.sha256).
  This is the actual copied tree, not an assertion that an actively edited root
  tree was captured atomically. The first copy caught the already-known numeric
  native-error-key regression before its concurrently landed correction.
- [Rechecked file hashes](integrated-review-2026-10-19/recheck.sha256) include
  backup, domain/control protocol and later reviewed publication/lease changes.
  The evidence below names the relevant rerun rather than treating all files as
  one immutable commit.
- [Final isolated recheck hashes](integrated-review-2026-10-19/final-recheck.sha256)
  identify the refreshed lifecycle, TLS and backup files reviewed through
  19:40 UTC. The complete native agent run preceded the final policy high-water
  change; the targeted policy/transition race rerun covers that later change.
- New connector-path diagnostics work began after this review's direct-node
  snapshot. It changes the runtime/IPC authorization boundary and is explicitly
  **outside the initial review's acceptance**. The separately scoped follow-up
  below reviews that later boundary; direct-node results are not substituted
  for the extension's own native and authorization evidence.

## Standards axis

No additional hard standards violation was demonstrated in this bounded review.
Domain/entry contracts remain separate from HTTP, SQL and engine SDKs. Native
SDK code stays in the nested runtime module; client-native configuration is
parsed as bounded data, not executed by the CP. Immutable install uses a
build-reviewed catalog, verifies archive and executable bytes, and publishes a
private versioned path rather than overwriting a running binary. Historical
fleet configuration is not treated as historical authorization.

The dedicated read-only backup snapshot correction below preserves the public
Store interface rather than globally widening the writer pool. The shared
output-review preparation and transactional input/token comparison avoid
separate preview and publish render semantics. No baseline code-smell heuristic
is elevated to a P2 without a demonstrated product consequence.

## Specification axis: confirmed findings

### I1. P2, corrected: slow candidate validation postponed the old runtime's lease restriction

- Initial location: `internal/agent/reconciler.go`, synchronous `Submit` call to
  `Adapter.Validate`; `internal/agent/driver.go` serialized mutation loop.
  Current correction: `internal/agent/core_install.go:385–420` and the
  `awaitPreparationLocked` calls in `reconciler.go`.
- Contract: a failed candidate cannot extend the last-valid runtime's bounded
  offline permission. Parser acceptance is not runtime enforcement.
- Independent reproduction: apply generation 1 with a 150 ms lease; block
  generation 2 in a failing validator; invoke `EnforcePolicy` concurrently.
  Direct adapter observation still saw generation 1 live 101 ms after its own
  expiry. Enforcement could not enter the held mutation lane. This used the
  public reconciler/adapter seams and a deterministic local fixture barrier,
  **not** a claimed stock-native traffic exploit. The installer owner separately
  identified the related, potentially multi-minute download path.
- Impact: stock runtimes rely on agent restriction, so preparation latency
  became extra authorization time. Managed Xray's independent per-flow lease
  timer is a separate protection; this reproduction does not demonstrate a
  managed per-user bypass.
- Smallest correction: retain one reserved generation-mutation lane but run
  non-mutating download/validation work with an in-lane policy ticker; restrict
  the old runtime while preparation remains blocked. The owner implemented
  this, plus a private exact-stage/executable validation receipt to avoid
  repeating a long native parser immediately inside activation.
- Evidence: [reproduction](integrated-review-2026-10-19/validation-repro.go.txt),
  [initial red](integrated-review-2026-10-19/review-initial.log),
  [independent race recheck green](integrated-review-2026-10-19/validation-remediation.log).
  The receipt was source-reviewed and the refreshed complete agent race suite
  passed. Owned stop/start/observation remain synchronous and bounded; this is
  not an instantaneous-revocation guarantee or a test of every scheduler delay.

### I2. P2, corrected: streaming export monopolized the live policy store

- Initial/current location: `internal/store/backup_stream.go`, `ExportBackup`
  (current implementation at lines 120–159).
- Contract: extending recovery beyond the old archive cap must not silently
  turn a whole-history export into a control-plane admission outage.
- Independent reproduction: hold the exported-row callback open, then request
  admission on the same public Store. Admission could not execute within the
  test's 100 ms window and completed only after export was released. The initial
  code held both `s.mu` and the sole writer-pool connection over validation,
  iteration, serialization and output work.
- Impact: normal API reads/writes and admission renewal depended on export
  completion. A long history/disk operation can therefore exhaust bounded
  runtime leases and fail closed. The HTTP endpoint spools locally before
  sending 200, so this is **not** a demonstrated slow-download-client attack.
  No production-size time-to-outage or actual 30-second outage was measured.
- Smallest correction: use a separate read-only WAL snapshot connection for
  the bounded export, preserving one consistent snapshot without occupying the
  shared mutation lock or writer connection. The owner implemented this; no
  global connection-pool or writer-transaction relaxation was introduced.
- Evidence: [reproduction](integrated-review-2026-10-19/backup-concurrency-repro.go.txt),
  [initial red](integrated-review-2026-10-19/review-initial.log),
  [independent race recheck green](integrated-review-2026-10-19/backup-concurrency-remediation.log).
  The owner's separate regression additionally verifies concurrent generation
  advancement while exported record/counter state stays at the original
  snapshot. Long-running read snapshots can retain WAL growth until completion;
  the configured duration and disk budget remain operational constraints.

### I3. P2, corrected: publication accepted provably unusable TLS certificates

- Initial location: `internal/httpapi/published_manifests.go:161–176`,
  `verifyServerTLSArtifacts`; called by server publication and fleet preparation.
  Current correction: `internal/httpapi/server_tls_publication.go:18–136`.
  The pure `internal/render/server.go` still checks certificate/private-key
  pairing without introducing time-dependent rendering.
- Independent reproduction: create matching synthetic PEM/key material with an
  expired leaf, a future-dated leaf, or a leaf for `other.example` while the
  generated client connection uses `expected.example`. Authenticated HTTP
  validation and publication accepted all three; publication returned 200 and
  queued both targets. Actual `x509.Verify` rejected each fixture even when
  explicitly trusting its synthetic root.
- Impact: parser-valid and process-live evidence can promote a configuration
  whose generated TLS client connection is guaranteed to fail. This is a
  usability/readiness defect, not proof of insecure TLS fallback or private-key
  disclosure. Public CA trust was not assumed or tested.
- Smallest correction: at publication/activation-readiness boundaries, parse
  packaged certificate material and check validity time and the actual client
  verification name (explicit TLS server name, or published host fallback).
  Keep temporal checks out of the pure renderer; preserve private/synthetic
  trust configuration without disabling hostname or validity checks. An
  explicit policy for a certificate expiring during a running deployment remains
  an operational follow-on. The implemented gate checks packaged validity,
  supplied-chain consistency/server-auth usage and explicit or fallback names
  at publication and each activating fleet preparation/execution. It does not
  continuously recheck certificate lifetime at feed/readiness boundaries, and
  it does not prove arbitrary clients trust the supplied issuer.
- Evidence: [reproduction](integrated-review-2026-10-19/tls-publication-repro.go.txt),
  [HTTP and x509 red results](integrated-review-2026-10-19/tls-review-initial.log),
  [independent red-to-green race recheck](integrated-review-2026-10-19/final-tls-remediation.log).
  The same independent three-case repro now rejects all three with HTTP 422.
  Owner regressions independently rerun also pass public-host and connector
  verification-name fallback, expired supplied issuer, private-issuer acceptance,
  and expiration between fleet review and execution with no generation advance.
  [Latest named-test rerun](integrated-review-2026-10-19/final-policy-tls-race.log).
  No native TLS listener was launched by this particular negative test.

## Additional independent verification and bounded conclusions

1. Initial race suites passed private IPC, diagnostics, store, HTTP API and
   agent. The renderer failed only the known numeric-key diagnostic regression
   captured during concurrent correction. The refreshed full renderer and
   agent race suites subsequently passed. [Initial output](integrated-review-2026-10-19/package-race.log),
   [refreshed output](integrated-review-2026-10-19/final-agent-render-race.log).
2. The nested managed-Xray module's full race suite passed: actual synthetic
   VLESS TCP/TLS, duplex shared rate, mux identity/revocation, independent lease
   expiry, finite combined-payload ceilings, DNS all-answer rejection and pinned
   destination resolution. [Output](integrated-review-2026-10-19/runtime-race.log).
3. Explicit native process opt-ins passed the real CP → managed ingress →
   native transit → loopback target integration, including shared finite quota
   settlement and revocation; the two-target fleet install/configure/stop/start/
   reject/rollback sequence; and broker-EOF shutdown of active payload/process
   with the final 44-byte journal preserved. The EOF fixture observed about
   5.6 ms, not a universal bound. [Output](integrated-review-2026-10-19/native-targeted.log).
4. Pinned Mihomo 1.19.32 and sing-box 1.14.3 accepted the saved, composed native
   override fixtures, whose published bytes matched the parser input. This is
   parser evidence only, not sing-box process/TUN startup or end-user routing.
5. The new existing-output review digest was source-reviewed and its selected
   HTTP/store regressions rerun with the race detector: profile/source/output/
   owned-resource/grant changes invalidate the review, stale failure preserves
   the feed, and captured-input CAS rolls back output plus token-index mutation.
   [Output](integrated-review-2026-10-19/output-review-race.log). A later rerun
   also covers a changed hidden URL secret whose redacted preview is identical
   but whose exact-input digest must differ
   ([output](integrated-review-2026-10-19/final-tls-remediation.log)). This binds exact
   tenant render inputs and final bytes. It does not freeze all changing global
   service/runtime state; feed access still rechecks current authority. Explicit
   no-digest API calls retain update-to-current behavior.
6. Direct-node diagnostics retain exact authorized targets, public-address DNS
   pinning, bounded request count/payload/deadline, scoped single-attempt claims,
   durable unknown-on-interruption and immutable report retry. Upload reader
   counts are not used alone as completed-write proof. Existing crash, early
   response, deadline, node-lane and transport tests passed within the suites;
   no new diagnostic security defect was demonstrated in this snapshot.
7. Fleet plans refresh current enrollment and grants, compare current desired
   baselines and earlier-stage observations, and transactionally fence those
   inputs. Rollback uses historical topology but current eligible principals.
   No reproduced stale-grant resurrection or cross-instance operation was found.

8. The refreshed complete agent race suite with native-process opt-ins passed
   in 48.15 seconds. It covers cached official Xray/sing-box immutable
   installation plus native checking, old-runtime download lease expiry, registry
   isolation, actual Xray traffic, and synthetic two-version process transition.
   Private validation receipts reject changed executable bytes before stopping
   the old runtime. [Output](integrated-review-2026-10-19/final-installer-race.log).
   This is not actual upstream cross-version migration or sing-box runtime/TUN
   evidence. The subsequent policy-issued-time high-water change was separately
   rerun under race, including equal-time and backdated-denial replay rejection
   and stopping the actual old runtime after a failed upgrade
   ([output](integrated-review-2026-10-19/final-policy-tls-race.log)).
9. An additional hypothesized stop-mediated permission replay was disproved:
   public desired validation rejects a stop command carrying an allowed lease
   before it can replace accepted denial state.
   [Probe](integrated-review-2026-10-19/stop-policy-repro.go.txt),
   [result](integrated-review-2026-10-19/stop-policy-initial.log).
10. The refreshed backup Store race tests passed after physical-schema and
    constant-memory duplicate/order hardening. This includes the independent
    blocked-emitter admission probe and the owner's simultaneous mutation/snapshot
    isolation regression. [Output](integrated-review-2026-10-19/final-backup-store-race.log).

## Limits and current disposition

No live deployment, external traffic/provider billing, browser acceptance,
OS-level memory-erasure proof, exhaustive filesystem crash injection, full
1 GiB backup load, or unbounded formal proof is claimed. Native-process evidence,
parser evidence and rendered-output evidence remain distinct. The existing
Chromium sandbox and sing-box netlink restrictions were neither retried nor
bypassed. Shared-executor and upstream CI readiness are separate release gates.

Initial independent outcome (through 19:40 UTC): Standards: **0 demonstrated hard violations**.
Specification: **3 reproduced P2 categories, all 3 corrected with independent
red-to-green checks**. No remaining demonstrated P1/P2 in the reviewed snapshot.
This was not approval of subsequently changed files. The connector-path
diagnostic extension is covered only by the separately scoped addendum below.


## Follow-up addendum, 19:57 UTC

### Scope and source identity

The same independent reviewer reviewed the now-stable managed-connector diagnostic
extension, explicit `PublicOrigin` handling, private external-feed eligibility
separation, and final immutable-installer cleanup/result-state changes. No second
independent reviewer is claimed. Production files remained read-only.

[Follow-up scoped hashes](integrated-review-2026-10-19/followup.sha256) identify
these reviewed inputs. [Supporting compilation-tree hashes](integrated-review-2026-10-19/followup-supporting-tree.sha256)
identify the isolated dependencies, not a review or approval of every listed file.
Group/concurrent-connection policy, subscription-domain settings, source refresh
candidates and owned rule-file bundles were still changing and are **excluded**
from this addendum's acceptance. At the final byte comparison, the runtime
dispatcher had subsequently gained mux-safe admission-denial handling from the
concurrent-cap workstream. This addendum identifies the earlier dispatcher bytes;
the final group/runtime gate must rejoin diagnostic and ordinary-admission tests
against that newer dispatcher.

The first nested-module run hit a missing YAML dependency introduced by concurrent
rule-file work. An offline, isolated module update allowed testing to continue;
the resulting `runtimes/xray/go.mod` and `go.sum` were subsequently byte-equal to
the owner's repaired production files. The first HTTP attempt captured Source DTO
and source-refresh files mid-change and failed compilation. Refreshing the
owner-confirmed compile-consistent source group allowed the targeted HTTP rerun.
These setup failures are not silently counted as passing test runs.

### Standards axis

No additional hard standards violation was demonstrated. The shared bounded HTTP
executor is separate from job intent, storage claims, runtime connector selection
and presentation. The new administrative runtime context is private Go state, not
a network-client field. Public-origin trust is explicit operator configuration,
not inferred from forwarding headers. Artifact installation evidence remains
separate from permission to run a process.

### Specification axis and adversarial checks

No new P1/P2 was reproduced in this bounded follow-up.

- Managed-route jobs pin the exact entry identity and all-hop immutable manifests
  within the CP transaction at request/claim/poll/result boundaries. The agent
  independently requires its current effective policy, verified live observation,
  exact staged bytes and private-pipe session identity before issuing RPC. A
  later inactive install candidate does not masquerade as the running identity.
- Runtime route selection requires a unique generated principal-rule prefix and
  existing exact connector. The administrative context bypasses tenant admission
  only for the bounded operator probe, while destination-policy enforcement still
  runs first. The network user cannot provide that private context.
- Independently rerun real native tests pass RPC → managed dispatcher → native
  VLESS transit → loopback target. Stopping transit prevents another target hit
  despite a direct default outbound. Replay returns prior evidence; cancellation
  and private EOF close the actual target tunnel. Denied ordinary VLESS users and
  denied destinations remain denied. [Native race output](integrated-review-2026-10-19/diagnostics-runtime-review.log).
- An additional independent public-RPC probe changes the payload limit or pinned
  fingerprint after a completed job while retaining job/attempt identity. Both
  return `not_run` and the actual target request count remains exactly one.
  [Probe](integrated-review-2026-10-19/diagnostic-replay-probe.go.txt),
  [race result](integrated-review-2026-10-19/diagnostic-replay-probe.log).
- CP stale-hop/observation/enrollment tests, agent live-process fences, interruption
  recovery and unknown-outcome physical-node lane retention passed under race.
  Unknown is not promoted to a known stop, and path invalidation does not change
  unknown/not-run evidence into invented successful execution.
  [Scoped output, including the initial HTTP compile failure](integrated-review-2026-10-19/diagnostics-http-review.log).
  The full private-IPC package was separately rerun because the first targeted
  selector matched no tests in that package.
  [Private IPC output](integrated-review-2026-10-19/privateipc-followup-review.log).
- The joined HTTP authoring/publication → diagnostic selector → admin request →
  scoped agent claim test passed. It rejects secret/override DTO fields and
  missing runtime bindings. This and the native transit test are **compositional**
  evidence, not a new full CP/supervised CLI/native-target end-to-end test.
- Explicit HTTPS public origin works behind a Host-preserving HTTP loopback
  proxy, sets Secure/HttpOnly cookies, and rejects wrong host/origin, malformed or
  duplicated Origin. An independent negative handler probe confirms forged
  `Forwarded`, `X-Forwarded-Proto` and `X-Forwarded-Host` cannot authorize an
  otherwise rejected mutation. [Probe](integrated-review-2026-10-19/origin-forwarded-probe.go.txt).
  No actual reverse proxy or OS networking configuration was changed.
- Pure external outputs remain deliverable after platform quota exhaustion or
  entitlement expiry and omit platform `Subscription-Userinfo`. Current account
  existence/identity, account-disabled status and user-enabled status are still
  mandatory. Mixed/platform-dependent outputs retain live platform eligibility
  and exact frozen grant checks. Disabled-account/user negatives passed.
  [Joined HTTP/origin/feed race output](integrated-review-2026-10-19/followup-http-review.log).
- Final lifecycle source review and race regressions pass: failed download before
  candidate staging permits cleanup of exactly the prior owned runtime; a missing
  adapter after staging remains unknown rather than assumed absent. A completed
  installation retains artifact-success evidence after confirmed restriction,
  while access remains denied and no process is observed. Equal-time and
  backdated permission replay fences still pass.
  [Lifecycle race output](integrated-review-2026-10-19/lifecycle-followup-review.log).

### Follow-up disposition and limits

Standards: **0 demonstrated hard violations**. Specification: **0 newly reproduced
P1/P2** in this addendum; the three earlier categories remain independently fixed.
Managed connector probing proves configured operational forwarding, not public
entry TLS, end-user admission, subscription correctness or provider billing. No
arbitrary public diagnostic target, live server, real credential or sandbox bypass
was used. No browser or full-project CI acceptance is claimed. The active workstreams
explicitly excluded above still require their own stable-byte gates and review.

## Addendum: effective policy, subscription origin, owned files and source review (20:07 UTC)

### Stable-byte scope and independence

This is the same independent reviewer, not another reviewer. The isolated tree
was captured at 19:59 UTC and refreshed only after the relevant owner froze the
final cap/calendar, source-candidate and rule-file changes. `HEAD` remained
`3aa2bd3cee428baa606d43bcc2f502654f567a78`; these are working-tree findings.
[Critical source/test/binary hashes](integrated-review-2026-10-19/policy-source-rule.sha256)
and [scope list](integrated-review-2026-10-19/policy-source-rule-scope.txt) identify
reviewed bytes. [Supporting-tree hashes](integrated-review-2026-10-19/policy-source-rule-supporting.sha256)
identify dependencies, not a claim to have reviewed every listed file. Final
critical production-source comparison matched the shared tree. The copied managed
binary was immutable throughout these tests; a subsequent shared binary rebuild
has a different hash, and is not silently substituted for the tested executable.
The nested runtime/entrypolicy/private-IPC source comparison still matched.

### Standards axis

No new hard standards violation was demonstrated. The effective-policy evaluator
is pure service code; the shared store transaction supplies preview/apply,
admission and provisioning authority. Subscription-origin verification is a
bounded explicit network operation separate from browser-origin trust. Owned
file ingestion, immutable version resolution and ZIP delivery are separate from
rendering. Source updates preserve draft input, accepted snapshot and pending
review as distinct states. This bounded security review does not constitute UI,
full-CI, performance-at-maximum-size or formal-proof acceptance.

### Specification axis: P2 cap reductions could remain ineffective indefinitely (fixed)

- **Location:** `internal/store/admission.go:365-370` exempts an existing IP or
  presence from a full cap, which is correct for renewal *at* the cap. The prior
  `guardBudgetPolicyUpdateAt` in `internal/store/policy_updates.go` did not fence
  reductions against those already admitted presences.
- **Public-seam reproduction:** admit two streams under connection/IP limits of
  two, then call `PutServicePlan` to reduce either limit to one. The write
  succeeded. Both presences renewed at +10, +20 and +40 seconds, including beyond
  the original 30-second lease. The effective limit was one with two active
  streams, or two distinct online IPs. This was not merely bounded old-lease grace.
  [Unchanged independent probe](integrated-review-2026-10-19/cap-reduction-probe.go.txt),
  [red race output](integrated-review-2026-10-19/cap-reduction-initial.log),
  [red snapshot hashes](integrated-review-2026-10-19/cap-reduction-red.sha256).
- **Impact:** a successful administrative reduction did not establish the stated
  concurrent-stream/IP ceiling while existing users kept renewing. The owner
  confirmed indefinite grandfathering was not intended.
- **Smallest correction, implemented by the owner:** in the same writer
  transaction, capture current unexpired presences and effective policy, then
  reject a reduced positive cap below the current stream or canonical-IP count.
  `internal/store/active_policy_limits.go:49-60` supplies the common guard for
  compatibility writes and reviewed group/service/individual changes. Preview
  explains that enough streams must close before retrying; no arbitrary stream
  is selected for eviction.
- **Verification:** both unchanged independent cases now pass under race, together
  with reduction preview/apply, cross-Store atomic admission, exact individual
  overrides and effective-policy provisioning CAS. [Green output](integrated-review-2026-10-19/cap-reduction-final.log).
  The owner's final first-group calendar corrections were also independently
  rerun: settled legacy usage is not discarded, active prior budgets are retained,
  and intervening history invalidates a reviewed first-calendar initialization.

### Other independently verified behavior

- Full nested managed-runtime race suite passed with the newer mux-safe denial
  dispatcher, joining ordinary admission, destination policy and managed-route
  diagnostics. [Runtime output](integrated-review-2026-10-19/policy-runtime-review.log).
  The real CP/native integration separately passed two independent TCP/mux
  streams from one IP, denial of excess logical streams without killing an
  existing carrier, renewal at the cap and final-close slot release.
  [Native entry output](integrated-review-2026-10-19/policy-native-entry-review.log).
- Group selection resolves one winning service rather than adding quota across
  groups. Equal-priority conflicting services fail closed; nullable exact
  individual overrides preserve the distinction between inheritance, zero and
  an explicitly empty route set. Current account-disabled state participates in
  effective authority and reviewed policy snapshots. Owner-scoped admin preview/
  apply and ambiguity/reference negatives passed. [Final policy/source output](integrated-review-2026-10-19/source-policy-final-review.log).
- M04 stores draft and active subscription origins separately. Its random-answer
  challenge uses bounded normal HTTPS with public-DNS pinning, no redirect and
  exact Host/instance matching. Proof is short-lived and settings-revision bound;
  failed replacement leaves the existing origin and token unchanged. Wrong TLS
  trust/name, wrong challenge Host, oversized response, redirect, concurrent edit
  and expired proof tests passed without external networking or trust changes.
  [Origin output](integrated-review-2026-10-19/policy-origin-rules-review.log).
- Owned rule bytes are owner-scoped, content-addressed and frozen into a published
  output. Delivery revalidates file integrity and owner, restricts config names,
  derives rule paths from the hash, caps file/count/aggregate size and extracts no
  user archive. Cross-owner access, forged paths/pins, changed accepted versions,
  tampered bytes, stale preview, rotated/revoked tokens and failed refresh tests
  passed. [Bundle/API output](integrated-review-2026-10-19/owned-rules-review.log).
  An additional independent public-token probe confirms both a newly disabled
  account and a disabled user block an already frozen ZIP.
  [Probe](integrated-review-2026-10-19/bundle-current-account-probe.go.txt),
  [race output](integrated-review-2026-10-19/bundle-current-account-review.log).
- Four real parser fixtures cover HTTP upload → publish → ZIP → temporary local
  files. Mihomo `-t` does **not** reject a corrupted referenced YAML/MRS payload,
  so it proves config/reference parsing only. Separate native converters consume
  the downloaded YAML/MRS, recover the exact expected domain and reject corrupt
  inputs. Sing-box `check` consumes both source/SRS and rejects corrupted payloads.
  [Final sensitivity output](integrated-review-2026-10-19/owned-rules-native-final.log).
  This is parser evidence, not daemon startup, rule-match traffic or universal
  safety of an arbitrary uploaded binary rule file. CP inspection remains
  explicitly bounded envelope/header inspection, not native validation.
- Material source removal/credential changes, valid explicit empty snapshots and
  dynamically selected additions require review. Harmless static additions and
  renames preserve stable identities. Failed edited input remains saved while
  the last accepted snapshot stays usable; ambiguous identity changes fail closed.
  Acceptance binds the exact source revision/candidate plus captured dependency
  records and complete dependent ID sets in one transaction. Cross-owner reveal,
  stale/deleted/changed/new dependencies, invalid partial input and credential/
  transport-query redaction tests passed. Revoked outputs are not represented as
  affected published subscriptions. [Final HTTP output](integrated-review-2026-10-19/source-policy-final-review.log),
  [full importer race output](integrated-review-2026-10-19/importer-review.log).
  URL source behavior was joined compositionally with public-DNS pinning and
  forbidden-address fetcher tests. The source fetcher can follow individually
  validated redirects with sensitive headers removed. The full resources race
  run passed redirect-to-private denial, referrer removal and redirect-loop
  bounds ([output](integrated-review-2026-10-19/resources-full-review.log)); the no-redirect outbound
  client test belongs to origin/diagnostic use, not a claim that source fetching
  disables every redirect. The HTTP source fixture uses a blocked local address,
  not a real external provider.
  [Fetcher/source output](integrated-review-2026-10-19/source-candidate-review.log).

### Disposition and remaining limits

This addendum adds **one independently reproduced P2, fixed and rechecked**.
Together with the initial review, four finding categories have red/green evidence;
no unresolved P1/P2 was demonstrated within the reviewed stable-byte scope.
Initial selectors matching no resource/importer tests were corrected with explicit
resource fixtures and the full importer package; empty selections are not passes.
The source candidate deliberately bounds one pending review, 2,000 records per
scanned dependent kind and 16 MiB of private candidate state; conservative
unrelated-owner-record changes can require rereview. No maximum-scale benchmark
or crash injection for these new paths was performed. Stream counts are logical
admitted streams and normalized IPs, not physical-device counts. Browser workflow
acceptance and the parent's serial full-project gate remain separate evidence.
