# Control-plane integration notes

These are implemented local contracts, not a production-readiness statement. The command is `cmd/control-plane`; `scripts/go.sh` selects the pinned toolchain.

## Authentication and private content

- `/api/auth/login` and `/api/auth/accept-invite` create local cookie sessions. Cookie mutations require `X-CSRF-Token`; mutation origins must match the actual request origin. A separately configured long operator bearer token is admin-only.
- Invite redemption, MFA enablement, session issuance and TOTP replay fencing are durable transactions. Admin MFA enrollment revokes prior sessions and issues a replacement.
- `/api/me/sources` and `/api/me/profiles` return redacted summaries. Owner-only `/{id}/reveal` is an explicit edit/export boundary. Collection and rendered profile previews redact nested REALITY short IDs as well as passwords and UUIDs.
- Private namespaces derive from the authenticated account, never an owner ID supplied by the browser. HTTPS source/resource fetches use the bounded public-address fetcher.
- Admin server deployment and managed endpoint list/get/save responses omit listener, connector, principal and TLS private-key material. `/api/server-deployments/{id}/reveal` and `/api/managed-endpoints/{id}/reveal` are explicit, audited, no-store admin edit boundaries. Summaries are not writable drafts; validation fingerprints are always computed from the full persisted IR.

## Published feeds and platform entry grants

- Output publication freezes artifacts, dependencies and renderer name allocations. Draft changes, source refreshes and template updates do not republish an existing feed.
- Rotate/revoke/publish use transactional expected-record comparison. A stale rotation cannot resurrect a revoked output.
- Feed retrieval rechecks the frozen grant/version/route dependency against current account eligibility, not the current mutable profile draft.
- Admin `/api/users/{id}/entries`: `GET` summaries and `POST` create/edit. `GET /{entryId}/reveal` returns credentials explicitly; `DELETE /{entryId}` revokes the grant. Reactivation needs a fresh credential version; retired versions cannot be reused.
- Legacy route/client-chain inventory is not itself an observed server deployment. Published managed routes bind immutable deployment manifests, exact principal credentials and all-hop observed identity. Native validation, quiescent known state, live policy lease and current enrollment are required; saved drafts and queued artifacts are not reported as applied.

## Meter ingestion and unresolved intervals

- Enrolled agents post immutable, digest-checked batches to `/api/agent/instances/{instanceId}/meter-batches`. Scope, stream epoch, sequence and digest are replay fences.
- Cumulative counters become ledger deltas in the same transaction as cursors, receipt and inbox persistence. User raw payload, route-weighted quota and provider IN+OUT are distinct. Weighted fractional terms are aggregated before final byte rounding.
- A new epoch needs an actually observed zero baseline before its first positive interval can be charged. A fabricated zero after traffic starts is not acceptable.
- Declared policy/rate/cycle transitions and actual UTC+8 calendar/manual-reset boundaries require exact boundary evidence. Unresolved intervals persist encrypted pending history and place the account on a restrictive accounting hold; no proportional or end-time split is invented.
- Proven cumulative intervals are `[previous observation, current observation)`. An observation exactly at reset closes the prior cycle.
- Admin `GET /api/agent/instances/{instanceId}/accounting-pending` exposes measured identities and counters for investigation.
- Admin `POST /api/agent/instances/{instanceId}/meter-baseline` takes `{receiptId, expectedDigest, reason}`. For a previously unseen epoch only, it explicitly starts measurement at the reviewed observation without retroactive charging. The audit and unattributed byte amount remain. The hold clears only after the agent's original batch is replayed and accepted.
- Existing-cursor ambiguous intervals cannot use this command to silently discard consumption; they require boundary evidence.

## Account-wide IP admission

The shared credential-free wire is `internal/entrypolicy`. The managed runtime uses a private agent broker; it does not receive the control-plane token.

- Admin `POST /api/agent/instances/{instanceId}/entry-bindings` defines the immutable mapping `{id, entryId, subjectId, userId, routeId, grantId, credentialVersion}`. It must refer to that instance's managed entry and a current owned public grant.
- Enrolled `POST /api/agent/instances/{instanceId}/admission-leases` takes `{entryId, subjectId, credentialVersion, clientIp, presenceId, admittedBytes, final}` (`admittedBytes` is a decimal string). The account and route are resolved by the server. The caller cannot choose them.
- The response is `entrypolicy.Lease`: `{allowed, leaseId, accountId, routeId, expiresAt, reason, entryRateBps, byteBudget?}` (`byteBudget` is an absolute cumulative raw-byte ceiling encoded as a decimal string; absent means unlimited). An explicit denial is HTTP 200 with `allowed:false`; malformed/scope/auth failures are errors.
- Each live connection needs a unique stable `presenceId`, or a correctly refcounted entry/IP presence maintained by the runtime. Renew the same presence every 10 seconds. Release with enrolled `DELETE /api/agent/instances/{instanceId}/admission-leases/{leaseId}`.
- A lease lasts at most 30 seconds and no longer than enrollment or service expiry. Network uncertainty cannot extend the last grant.
- SQLite's write reservation serializes eligibility and IP-slot claiming across separate store handles. Active normalized client IPs form one union per account across nodes/entries; mapped IPv4 and canonical IPv4 are one IP. Releasing one connection does not drop another presence at that IP.
- A new IP is denied at the cap. Existing admitted IPs may renew at the cap, but disabled, expired, exhausted, unentitled, revoked-credential, superseded-enrollment and accounting-held principals are denied.
- The control-plane admission tests do not by themselves prove native peer attribution, process shutdown, deployment or distributed bandwidth enforcement. Those need managed runtime/agent integration evidence.

## Hard quota reservations and recovery

- Account-wide finite quota is reserved atomically before native payload handoff. Each presence receives at most 1 MiB of outstanding raw allowance, weighted by an immutable route rate; simultaneous entries and separate store connections cannot reserve the same remaining pool. This reservation is not measured consumption.
- `admittedBytes` monotonically reports combined admitted uplink plus downlink payload for one presence. Settlement debits the canonical raw/weighted ledger exactly once. Existing own allowance can renew even when no unreserved quota remains.
- A final report is accepted after account disable or credential revocation, for an authenticated current enrollment with its existing immutable binding. It closes the presence permanently and returns only the proven unused remainder. A final-zero arriving before the initial request also creates a terminal tombstone.
- Releasing an IP presence does not refund its byte reservation. Expiry, network uncertainty and crashes never imply zero consumption. Expired unresolved budgets cause a restrictive accounting hold until final evidence arrives.
- Rate/cycle boundary leases end before the boundary. Final bytes arriving late retain the old frozen rate/cycle rather than being arbitrarily charged to the new policy. Rate changes cannot overlap issued budgets. Lowering quota, changing cycle or manual reset requires active budgets to be settled; increases and disable/revoke remain possible.
- Managed snapshots whose immutable meter binding declares `ledgerMode: admission-budget` are diagnostic cumulative observations only. They never debit again or guess an initial baseline. Normal cumulative meters retain the strict boundary/baseline rules above.
- Inconsistent over-ceiling or unknown-positive reports are retained in `admission-anomalies` with an accounting hold, not silently discarded or given invented exact attribution. Admin `GET /api/agent/instances/{instanceId}/admission-anomalies` exposes that evidence.
- Admin `GET /api/agent/instances/{instanceId}/admission-budgets` provides secret-free reservation state and an exact review digest. `POST .../admission-budgets/finalize` takes `{leaseId, expectedDigest, admittedBytes, runtimeStopped:true, reason, evidence}`. This is an explicit operator attestation based on final measurement after stopping the runtime, not an automatic refund. It is CAS-fenced and preserves audit/evidence. It supports recovery when the old enrollment has already been revoked. Never substitute the granted ceiling for measured bytes.
- Native finite-quota activation is released only after the managed runtime plus real HTTP/control-plane integration proof; isolated reservation tests do not establish deployment readiness.

## Verification evidence

Public-seam tests cover tenant isolation and explicit reveal; feed rotation/revocation; retired grant versions; exact deployment review fingerprints; scoped desired/observation identity; real loopback agent transport and durable meter spool through unresolved-baseline recovery; calendar/manual boundaries; normalized global IP union; simultaneous last-slot claims through two SQLite store handles; revocation on renewal.

`go test -race` on the control-plane/store policy suites and `go vet` passed during implementation. Backup KDF tests and native managed runtime tests are separate gates. No live VPS was enrolled or configured.

### Reservation serialization regression

The first real two-entry native quota test exposed a stale-arrival timestamp bug: an admission request could wait for SQLite, then exclude a newer already-committed settlement from its arrival-time ledger query and reserve the same remaining quota again. The fixed eligibility/reservation transaction counts all committed facts in the current calendar window, not only facts before request arrival. `TestQueuedAdmissionCannotIgnoreLaterCommittedSettlement` reproduces the ordering through separate store handles and was red before the fix. Native multi-entry verification remains a distinct release gate; a unit-test pass alone is not enough.

### Restore relationship validation

Encrypted restore also validates known derived relationships in both directions: every active published output needs its matching feed index, and desired/published-manifest generations need a persisted counter at least as high. Missing or behind counters are rejected before staging, while higher generation tombstones are preserved. Unknown future record kinds remain lossless opaque JSON, not silently discarded.

The rebuilt real HTTP → private agent pipe → two managed native ingress proof subsequently passed five repeated runs: eight competing flows share one 4096-byte combined allowance and settle exactly once to the account's 4200-byte total including prior use. The published-route integration owner is removing the temporary finite-quota activation guard only after this positive proof. This is local synthetic evidence, not a live deployment or production-readiness claim.


## Service policy opening-record review

- Admin `GET /api/access-policy/edit-context/service/{id}` is a no-store coherent read: `{target:{kind:"service",id},record:{service:Plan}|null,precondition:{exists,revision}}`. Presence describes the actual saved row, not a synthesized default. The opening token is opaque transport metadata, not authorization or a field persisted in Plan.
- `POST /api/access-policy/preview` has two explicit contracts. The guarded envelope `{change:{service:Plan},precondition}` requires the opening presence/token; the service UI never falls back to raw replacement. A raw `PolicyChange` remains an intentional full-record replacement for compatibility. The user-group and personal-entitlement editors below use the same guarded contract. Raw full-replacement API clients remain explicitly outside opening-baseline protection; the UI never silently chooses that compatibility path.
- Guarded preview resolves the exact target, then checks its opening baseline under the existing writer transaction before ordinary candidate/reference validation. Missing required precondition is428, malformed/mixed request400, changed baseline409 (`POLICY_EDIT_BASELINE_CHANGED`), and an unsupported saved shape422. Existing authentication/authorization still precedes these checks. A stale opening gets no usable preview ticket.
- `precondition.revision` reuses ReviewToken over target kind/ID, presence and complete canonical logical JSON. Same-content rewriting, re-encryption or recreation is equivalent; it is not an incarnation/write-count fence. Context and `resource.before/after` are complete typed domain snapshots, not raw JSON byte copies. Supported inactive cycle values, timezone aliases, nanoseconds and nil/empty route distinctions are preserved; unknown properties fail closed on the guarded path.
- A successful guarded preview includes `guard:"opened-record"` and `resource:{target,before,after}` from that **same** preview transaction. Resource review is independent of affected-user projection, so a zero-user plan or future default change is not hidden behind unchanged established account cycles.
- `POST /api/access-policy/apply` remains `{change,revision}`: use the exact reviewed change and the **preview ticket**, not the opening token. Existing broad snapshot/exact-change/calendar/time CAS, issued-budget restrictions and usage semantics remain. No calendar rewrite, usage clearing or deployment is added.
- Conflict recovery preserves the draft. Reading latest data does not refresh its baseline; explicit acceptance adopts the latest record/token together and retains a matching historical draft copy. Successful disposal of retained copies is stated in final consent; failed/unknown apply keeps them.
- Personal entitlement uses actual saved-row presence, not the effective-policy default seed, as described below. First group assignment can create that row/calendar between opening and preview; an absence token must not be silently refreshed.

These are project contracts, not HTTP If-Match or AIP154 compliance. See [methodology/source boundary](../design/UX-METHODOLOGY.md#打开记录的基线与确认后的票据分别保护) and [scoped implementation evidence](POLICY-EDIT-INTENT-2026-10-25.md).


## User-group opening-record and display-identity review

- Admin `GET /api/access-policy/edit-context/group/{id}` returns a coherent Group/null and the same content-equivalent kind/ID/presence precondition. The group editor requires it for create/update; missing versions never downgrade to raw replacement. Guarded preview checks the opening baseline before candidate member/service validation; apply keeps its existing broad snapshot, exact normalized candidate, calendar and budget guards.
- Group resource before/after is authoritative even when current effective user values do not change. Saved member IDs remain distinct from display names; existing server sort/deduplication is not a newly added membership change. Null/order/duplicate-only representation differences get an explicit cue rather than a false added/removed member.
- Optional transport-only context `references:{users:[{id,name}],services:[{id,name}]}` and preview `resource.references:{before,after}` are sparse exact-reference projections from the corresponding read/preview transaction. These are **names at that read**, not the group's historical save-time names. The existing preview snapshot binds their source records; no later catalog lookup relabels a frozen decision.
- Absent/unusable labels fall back to exact IDs; duplicate names across distinct IDs remain distinguishable. Malformed present metadata is rejected by the guarded UI. Display projection does not validate the whole referenced domain row: an unusable old removed label must not newly block intentional legacy repair; storage/decryption/invalid-JSON errors and authoritative candidate validation remain errors. Baseline comparison still precedes optional display enrichment.
- Reconciliation leads with distinct member counts and one visible added/removed identity list. Complete side-specific members/IDs remain in named details; necessary duplicate-name disambiguation stays visible. Retained copies keep their own opening context/labels, including honest ID fallback for a draft-only reference outside that snapshot. Reading latest does not adopt it; explicit adoption and final copy-disposal consent remain separate.

This user-group extension has its own evidence; the personal-entitlement extension follows below. Neither protects intentional raw full-record API clients from their own stale opening reads. No billing, first-calendar initialization or usage-reset behavior changes. See [Group verification and remaining scope](GROUP-POLICY-EDIT-2026-10-25.md) and [identity/display methodology](../design/UX-METHODOLOGY.md#身份由标识决定名称解释当前审阅).


## Personal-entitlement opening-record and control settlement

- Admin `GET /api/access-policy/edit-context/entitlement/{userId}` returns `{target,record:{entitlement:Entitlement}|null,precondition,effective}` from one transaction and requires a real user. `record:null` means no persisted entitlement; `effective.entitlement` may still provide a form seed. Context reads and previews never create the row or initialize its cycle. A present typed partial record remains the editable source rather than being replaced by projected defaults.
- The personal editor requires `{change:{entitlement},precondition}`. Opening-token comparison precedes ordinary candidate/reference validation; the existing content-equivalence and presence rules apply. Guarded preview alone adds `guard:"opened-record"` and authoritative entitlement `resource.before/after`. Legacy raw entitlement preview and entitlement apply retain their previous response shape; apply still uses the exact preview ticket/change with existing authority, calendar and issued-budget guards.
- Resource review distinguishes inherited/null, explicit zero, empty route overrides, inactive cycle values and precise changed quantities from effective account impact. Creation states absence once and summarizes explicit/operative settings with a remaining-inherited-limits cue; complete saved values stay in accessible details. A nonzero anchor remains visible even with no automatic reset because it still defines the accounting-window start. A mode change shows both sides’ operative cycle parameters. Only actual `resource.before:null` adds the decision consequence: saving adopts the displayed account cycle (including none/zero) and later group assignment will not automatically initialize it from plan defaults. This discloses existing behavior, not a new start/reset rule; later manual cycle changes remain possible.
- Reconciliation keeps complete **Form-owned** settings, including hidden overrides and inactive cycle fields. Reading latest does not adopt it; explicit adoption replaces values/context together and retains a matching unmerged copy. New local input invalidates older reads/reviews/confirmation ownership. Successful update can dispose of retained copies only with explicit final consent; failed/unknown apply keeps them.
- Personal controls opt into a local pending/settled contract. An open date choice must be confirmed/cancelled before a separate preview/adoption gesture; the dismissal gesture cannot also submit. Incomplete numeric input remains a visible unresolved condition across blur or automatic fallback until deliberate repair/discard, and blocks submission/mode changes that could hide it. Retained copies promise complete Form settings, **not private widget buffers or every keystroke**. Service/Group controls do not acquire this opt-in contract implicitly.
- An untouched timestamp is not reserialized, preserving its offset and nanoseconds. A deliberate picker commit uses the installed component’s existing precision: its default 100ms time-unit grid can normalize fractional milliseconds. This does not authorize normalization merely to clear pending state. No billing default, usage reset, schema or token/session infrastructure is added.

See [personal-entitlement verification](ENTITLEMENT-POLICY-EDIT-2026-10-25.md). Backend persistence evidence, public-control characterization, mocked editor behavior and actual built-UI review are separate scopes, not a universal native-input/IME or accessibility certification.
