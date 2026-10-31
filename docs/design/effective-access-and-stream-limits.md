# Effective access and independent stream limits

This implements the approved A02/A04 defaults. User authorization groups are distinct from host inventory groups and tags.

## One effective account policy

`service.ResolvePolicy` is the pure precedence evaluator. `Store.EffectivePolicy` and its transaction-local form load authoritative records for the same evaluation. Overview, platform feed eligibility, entry resolution/provisioning, runtime admission and byte-budget issuance consume that policy. Quota/expiry notifications consume the same overview. Accounting and manual reset retain the account's established cycle, not a newly selected group's calendar.

1. A nonempty individual entitlement `serviceId` selects that service.
2. Otherwise, among groups containing the account, the greatest integer `priority` selects one service. Lower-priority groups contribute no quota, limits or routes. Multiple equal-priority groups selecting the same service are harmless. Equal-priority groups selecting different services are ambiguous: no effective routes, no admission, and preview/apply rejects the conflicting change.
3. The selected service provides quota, route IDs, online-IP limit, concurrent-stream limit and per-logical-entry shared rate. Missing selected services fail closed.
4. Each explicitly present individual numeric override replaces the corresponding value. A present zero means unlimited, not inheritance; null/omitted means inherit.
5. A present `routeIdsOverride` is an exact replacement, including an empty list that grants no routes. Without that override, previous explicit `Route.UserIDs` direct grants remain supported alongside the one selected service. Membership itself never unions multiple services' route sets.
6. Account disabled/user disabled, paused entitlement, not-started and expired states are checked independently. Usage exhaustion and unresolved accounting are additional runtime/feed checks, not group selection rules.

Effective policy exposes field-level provenance, winning group IDs, selected service, effective limits/routes and the established entitlement. It does not claim that a configuration is deployed.

## Stable cycles and review/apply

The four account cycle modes remain monthly, anniversary, fixed-days and none in UTC+8. Existing entitlement starts and cycle anchors are not changed by service/group/membership changes. If the first group assignment reaches an unused account with no entitlement, the selected service's cycle is initialized once at the preview timestamp. Legacy direct accounts with existing ledger, budget or reset history retain their implicit no-reset calendar instead, so membership never discards earlier consumption. A later apply retains that exact timestamp; it does not silently reset usage. Explicit individual cycle edits and manual reset remain separate operations.

`POST /api/access-policy/preview` accepts exactly one complete `service`, `group` or `entitlement` replacement. It reports affected users with before/after effective authorization and blockers. `POST /api/access-policy/apply` takes `{change, revision}`. The opaque AEAD revision binds the normalized change, all policy input records and the original preview timestamp, and expires after 24 hours. A different change or stale snapshot returns conflict. Group edits atomically replace their member list; empty membership removes that group's assignments without deleting account history.

Both preview and apply take SQLite's existing admission writer reservation before evaluating. Apply rechecks outstanding budgets in the same transaction. A quota reduction, entry-rate reduction or cycle/calendar change affecting an issued unsettled budget is rejected until the affected presences are stopped and settled. Initializing the first group calendar is covered by the same guard. Revoking routes, pausing or disabling remains bounded by lease recheck rather than retroactively pretending issued bytes were never granted. Compatibility service/entitlement endpoints use the same budget guard. New UI changes use preview/apply.

Principal provisioning also re-evaluates the expected effective policy under the writer reservation before atomically saving credentials/bindings. Concurrent group removal or override changes cannot publish a grant under a stale authorization snapshot.

## Three independent dimensions

- Online IP limit: account-global union of normalized client IPs across platform public entries. IPv4-mapped addresses normalize to IPv4. The same IP on multiple entries counts once. This is not hardware/device identification.
- Connection limit: account-global count of unexpired admitted logical streams across all platform entries. Each TCP flow or mux logical stream consumes one slot, even when it shares an IP or carrier. Repeated requests for the same scoped presence renew the existing slot. A new stream at the cap is denied with `connection-limit`; already admitted streams can renew at the cap. A configuration change that would put current streams or online IPs above a newly reduced cap is rejected in preview/apply until sufficient presences have closed. Existing streams are not grandfathered indefinitely above a lower accepted cap. Zero disables this configurable cap; the independent 4096-presence resource-safety ceiling still applies.
- Rate: shared upload plus download, all flows for one account × logical entry. Different logical entries have separate rate buckets. No strict global aggregate-rate claim.

IP, stream and byte-budget claims share the same SQLite writer reservation, including across independent Store handles. There is no sampling window that temporarily admits extra streams before counting them. A release or final settlement frees its stream slot; lease expiry also removes it from the active count. Release/expiry alone does not refund uncertain byte reservations. TCP half-close can preserve a valid opposite-direction stream until both sides finish. A mux End closes its specific logical stream.

The managed runtime requests admission for each logical flow. Leases last at most 30 seconds, normally renew every 10 seconds, and expire locally without a CP poll. Denial of one new mux stream returns a closed logical link rather than an upstream dispatcher error, because Xray otherwise closes the entire mux carrier and its already admitted siblings. No outbound is dispatched and no payload is admitted for that denied link.

`GET /api/users/{id}/admission-status` is administrator-only and reports `asOf`, `maxLeaseSeconds`, normalized `onlineIps`, `activeStreams`, and per-entry counts/latest expiry. These are unexpired authoritative admissions, not an independent live-socket/physical-device observation. A lost final report can retain a reservation until the bounded lease expires. Transit connectors and private external-airport direct traffic do not create these platform account admissions.
