# Backend risks: source verification and design gates

Date: 2026-11-06. Source baseline: `a1fbbc301378e47489660791e68f8c50fcf2b93f`.
Branch: `reconstruction/backend-risk-plan-20261106`.

This is a new documentation-only reconstruction from the available baseline, not a recovery of earlier working changes. No product or test code is changed. Neither risk is fixed by this document. Source inspection establishes the mechanisms below; no Go tests, runtime experiments, browser checks, server runs, installations, network operations, publication or deployment were performed. Proposed tests and designs are unrun and unapproved unless explicitly described otherwise. Historical evidence files in the repository are not evidence of a new test pass.

## 1. Active entitlement with a future quota anchor

### Verified source facts

- Entitlement activity depends on account enablement, pause, `StartsAt`, and `ExpiresAt`, not cycle anchor (`internal/service/effective.go:148-156`). Cycle validation does not compare anchor with activation or current time; `none` even returns before the nonzero-anchor check (`internal/service/cycle.go:61-83`).
- `Window(now)` initializes Start to Anchor. Before a future anchor, resetting modes return NextReset equal to Anchor, giving the empty interval `[anchor, anchor)`. Mode `none` returns a future Start and no end (`internal/service/cycle.go:93-107`). Its interval is not mathematically empty, but excludes all earlier observations.
- Usage contribution uses the half-open observation-time interval (`internal/store/usage_projection.go:130-138`). Admission and service-policy eligibility read that window and compare weighted usage to finite quota (`internal/store/service_policy_fence.go:82-126`). An active start date therefore does not imply a usable accounting window.
- Budget policy takes Start/End directly from that window, with expiry and future rate boundaries (`internal/store/admission_budget.go:48-98`). Settlement writes actual admitted deltas at now, capped immediately before budget expiry, using the issued rate; it increases SettledRaw (`:100-131`). Grant computes available quota as quota minus usage minus outstanding reservations, and tops up remaining raw capacity (`:133-213`). Reservation accounting excludes closed budgets and fully settled finite budgets, and otherwise weights outstanding bytes (`:244-280`; the normal path is `admissionLiveReservedTx`, called at `:160`).
- The existing write guard compares cycle policies for accounts with unresolved issued budgets (`internal/store/policy_updates.go:52-118`). It skips closed and fully settled finite budgets. This is useful protection, but not a general rejection of future anchors: an account with no initial budget has no entry in that guard's prior-budget map.
- Admission leases already take the minimum of maximum duration, enrollment expiry, and eligibility expiry (`internal/store/admission.go:332-354`). Budgets additionally cap by current and original policy ends (`internal/store/admission_budget.go:151-159`). Service leases inspect every principal's expiry/reset (`internal/httpapi/service_intent.go:300-317`). Keep these limits; they do not repair excluded usage before the boundary.

### Risk hypothesis, not a reproduced exploit

With active StartsAt, future Anchor, positive finite quota, a chargeable route, valid authorization and all other gates satisfied, new admission may reserve quota. A settlement before Anchor is outside the calculated window. Outstanding reservation then falls, while included usage does not rise, so a later grant can replenish capacity. Repeated settlement/top-up is a plausible regrant path across monthly, anniversary, fixed-days and none. No traffic run, public-seam reproduction, or proof that every surrounding gate permits the example has been performed here. Existing expired-budget holds still matter; this claim does not require expiration, and must be tested with live renewals and no initial budget.

Unlimited quota and zero-weight routes are semantic controls, not examples of finite chargeable quota bypass. A blanket rule forbidding service until Anchor would also change their access, including `none`, even when StartsAt explicitly permits access. That rule is **not approved** and must not be silently adopted.

### Product decision required before implementation

Choose and document the relationship between activation and accounting anchor. Options needing evaluation include an explicitly defined pre-anchor accounting period with continuing access, validation/review of inconsistent schedules with an operator correction flow, or no early access. None is selected here. Decide finite/unlimited and zero-rate behavior separately; define `none` as a non-resetting mode rather than accidentally treating its anchor as a reset. Define how pre-anchor consumption carries into the first normal period, including manual resets and existing ledger history. Rejecting only new writes does not migrate existing data.

### Migration and operator recovery requirements

1. Inventory affected active and future entitlements, effective group/service selection, historical usage, live and expired unresolved reservations, published routes, and multi-account Core Instances. Preview exact impacted accounts and effective boundaries. Do not rewrite anchors or discard reservations automatically.
2. Agree a per-account migration classification and explicit treatment for ambiguous history. Preserve ledger provenance and issued budget rate/cycle identities; any adjustment must be auditable, not a fabricated usage event or refund. Rebuild/invalidate projections against the chosen windows transactionally. Include accounts with no budgets, closed budgets, missing explicit entitlement rows, and group-initialized cycles.
3. Separate “deny new grants/renewals” from “accept settlement.” Preserve old-version cumulative settlement, final closure, duplicate final/replay idempotence, and late reports under original issued terms. Existing acquisition settles before eligibility and handles final closure before a new grant (`internal/store/admission.go:275-310`; settlement at `admission_budget.go:100-131`). Do not move a new policy rejection in front of valid settlement. Expiry alone must not refund unknown outstanding bytes. Maintain accounting-pending holds and operator evidence recovery.
4. Stage the change with a version/compatibility gate and backup/restore rehearsal. Old writers must not continue producing incompatible anchors or grant decisions after activation. Define rollback compatibility before touching data; code rollback must not erase debits or reopen consumed budgets.
5. Specify admission, provisioning, subscription availability and service-renewal reasons consistently. Distinguish genuinely not-started access, exhausted quota, pending accounting, reconnect at a policy boundary, and operator review. Proposed reasons are not implemented statuses. Explain the action and consequence without displaying this review's uncertainty as product state.
6. A multi-account service can enter `review_required` after preparation/authority failure (`internal/httpapi/service_intent.go:168-182`). Renewal short-circuits that state (`:125-126`); the clock reaching Anchor is not evidence of automatic recovery. Provide a reviewed reprepare/republish/restart path, revalidate all principals, and verify recovery on the exact new deployment. Do not promise unrelated accounts remain available when they share a stopped Core Instance.
7. Preserve shortest lease caps across all affected principals, enrollment, entitlement, reset and rate boundaries. No lease may bridge an unauthorized period merely to avoid reconnects. A denial is not evidence that existing runtime sessions have already stopped.
8. Keep external-only Generated Subscriptions separate from managed entitlement gating. `internal/httpapi/output_eligibility.go:27-54` verifies account/user then returns ready without overview when PlatformDependencies is empty. Cover final feed/bundle authorization too, not just this readiness projection. Do not accidentally disable an enabled user's external-only output by adding a global anchor gate.

### Minimum proposed test matrix (all unrun)

- Public policy/write, overview and admission seams: active StartsAt plus future Anchor in all four modes, at Anchor minus 1 ns, equal, and plus 1 ns. Include monthly clamping, UTC+8, manual reset, finite/unlimited quota, positive/zero rate, and truly future StartsAt.
- No initial budget: grant, partial settlement, repeated renewal/top-up, full settlement, another presence, final, duplicate final/replay. Assert ledger debits plus outstanding reservation never permit unapproved replenishment in the chosen accounting period. Include cross-instance same-account grants under concurrent writer serialization.
- Existing old-version live/expired/closed budgets, lost final, late settlement, missing evidence and rate change: preserve original accounting and holds; prove no expiry refund and no rejection of valid settlement by a new access gate.
- Multi-account rollout: one future-anchor account, another unaffected account; lease cap, blocked review, operator correction, exact deployment recovery, rollback/reopen/projection rebuild. Test output readiness and actual feed/bundle for managed-only, mixed and external-only dependencies.

## 2. Same-generation runtime observation ordering

### Verified source facts and boundaries

`internal/controlprotocol/protocol.go:97-109` has runtime State identity and phase but no capture-order sequence. The runtime observation HTTP endpoint authenticates, validates enrollment scope and exact desired identity/generation, and requires a matching known observation for conformant phase (`internal/httpapi/agent.go:81-111`). Those fences remain intact.

`recordAgentObservation` unconditionally includes a write to current `agent-observations` once its compare succeeds. Its comparison covers desired, enrollment and operation archive, but not the current runtime-state record or an observation sequence (`internal/httpapi/agent_observation_history.go:12-32`). It deliberately retains the first exact successful operation archive. The transaction primitive is atomic (`internal/store/compare_records.go:26-55`), but atomicity alone does not order captures.

A stale handler that reaches this function after a newer state has committed can read the updated archive and write older current state without violating those comparisons. Conversely, two handlers reading different archive states can conflict; not every overlap succeeds. After archived success, the archive may remain unchanged across later state writes, further distinguishing historical success retention from current-state freshness. No generation/authentication bypass is claimed.

Normal delivery is serialized: the driver uses one network loop and awaits ReportObservation (`internal/agent/driver.go:110-163`); reconciler storage is root-locked (`internal/agent/reconciler.go:61`, `internal/agent/lock_unix.go:11-22`). Transport bounds requests and retries serialized payloads (`internal/agent/transport.go:71-75,99-149,197-210`). The remaining hypothesis is that an already decoded server handler survives client timeout/cancellation and commits after a newer same-generation report. Client serialization/root locking does not by itself prove all old remote handlers are gone. This interleaving has **not** been demonstrated using the actual HTTP stack or driver.

Physical VPS Node metrics are a distinct pipeline. `internal/store/node_observations.go:107-130` delegates ingestion within its write transaction; `internal/observability/calculation.go:11-40` checks stream/sequence and duplicate payload identity. Do not claim that pipeline has this runtime-State gap, or transplant its stream reset rule without reviewing runtime lifecycle semantics.

### Candidate design, not an approved fix

A durable capture-time sequence is a candidate, subject to these obligations:

- Allocate order when an immutable runtime snapshot is captured in the serialized mutation lane, not when its network send happens. Scope it to a defined authenticated enrollment/instance lifetime. Specify sequence reset across reenrollment, desired generation changes, restored journals and counter exhaustion. Wall-clock timestamps or phase rankings are not sufficient ordering rules; legitimate states can move from conformant to stopped/unknown.
- Persist the allocated sequence and exact payload before enqueue/send. Allocation or journal persistence failure must fail closed for reporting, expose an actionable error, and never send an unsequenced “success.” Do not silently invent a new stream on restart. Preserve independent lease enforcement and meter draining without representing unpersisted observations as acknowledged.
- Atomically compare/update the server high-water mark, current state and relevant archive writes with current desired/enrollment fences. A separate read-then-write check is insufficient. Define stale response handling, identical retry receipt, and rejection of equal sequence with a different canonical payload/digest. Preserve first-success archive semantics without letting stale current data change deployment outcomes.
- Extend wire/journal schemas with explicit compatibility rules. A payload hash Idempotency-Key already sent by transport is not capture order. Lost acknowledgments must retry the same sequence and bytes. Bound durable queue growth; define safe coalescing, if any, and keep exact receipts and observability of failures.
- Define migration draining: stop legacy unsequenced senders, drain or invalidate old in-flight handlers, establish a fenced epoch/cutover, then require sequence on that scope. Mixed legacy and sequenced writes cannot be allowed to overwrite each other indefinitely. An administrative flag alone is not proof that old handlers drained.

**Unresolved migration eligibility:** which existing agents/journals/enrollments can safely adopt the first sequenced state, and what evidence proves no earlier unsequenced report can still commit? This must be decided and tested. Do not assume every existing agent can start at sequence one, and do not force broad reenrollment as a hidden product decision. Recovery must preserve desired intent, enrollment security and existing operation history.

### Minimum proposed test matrix (all unrun)

1. At the public runtime observation endpoint, hold an authenticated, decoded older same-generation report; allow a newer report to commit; release the old report. Test before and after archived success, changed archive conflict, and conformant-to-stopped transitions. Deterministic barriers must observe the real persistence seam rather than replace it with a mock that assumes the bug.
2. Reproduce or refute the same ordering using the real bounded HTTP transport and serialized driver, with client timeout/cancellation and server continuation. A repository concurrency test alone establishes susceptibility, not natural reachability. Preserve exact authentication and enrollment/generation mismatch rejection controls.
3. Candidate protocol: concurrent sequences, out-of-order lower sequence, exact duplicate, equal sequence/different payload, lost acknowledgment/retry, crash before/after durable capture, journal write failure, server commit/receipt loss, restart/restore and sequence overflow. Check current state and retained operation archive independently.
4. Migration: eligible and ineligible journals, pending legacy report during cutover, mixed versions, reenrollment, desired generation change and rollback. Assert no unsafe downgrade from sequenced acceptance to unfenced legacy writes. Verify physical node observation ordering remains unchanged.

## Release gates and review scope

Do not label either risk closed until the product choices are recorded, public-seam failing-before/passing-after evidence exists where feasible, migration and operator recovery are exercised, and independent standards/spec review is complete. Run the repository's required final gates in a later authorized verification session; this document is not a replacement for those gates. No deployment is authorized by this plan.

Documentation checks for this reconstruction: source references inspected against the pinned baseline; terminology checked against AGENTS.md and GLOSSARY.md; planned versus observed behavior separated. The pinned code-review guidance was read. This is not a completed independent two-axis code review: there is no product fix diff to assess, and final documentation review belongs to the receiving reviewer. No ticket is marked verified by this source-only work.
