# Continuous-service writer policy fence — 2026-10-31

The continuous-service compiler can read a current policy and still lose a race
with group membership, entitlement expiry, ledger ingestion or accounting holds
before it writes a grant. This patch adds a narrow transaction guard, not another
quota evaluator or an unbounded standing authorization.

`CompareServicePolicyAndPutRecords` and `CompareServicePolicyAndGenerateRecord`
share the existing SQLite writer reservation, record/set CAS, associated writes
and generation counters. Their `ServicePolicyFence` contains at most 1,000 unique
current-target users with reviewed canonical policies/routes and a mandatory
server deadline. It checks actual active `effectivePolicyTx`, exact policy equality,
route permission, accounting holds, canonical cycle/reset/usage quota and expired
unsettled budget holds. Deadline and policy checks run before writes and again
before commit; a failure rolls back the intent/grant, associated audit and generation.
Entitlement expiry also constrains the deadline. Empty checks are allowed only as
a caller contract for legitimate no-principal runtimes; the deadline is still mandatory.

The quota/reset/accounting-hold tail is extracted verbatim from the existing
admission eligibility function into a shared transaction helper. Expired-budget
hold evaluation likewise shares its existing implementation. Admission budget
reservation, settlement, final evidence and per-flow expiry are unchanged; a
service renewal neither refunds reservations nor extends a flow lease.

The CP caller must derive checks from reviewed current-target principals, fence
all authority/configuration/ownership inputs and use the earliest receipt,
enrollment and applicable current-lease deadline. The guard is not a replacement
for scoped authentication, explicit administrator opt-in, stable intent identity,
monotonic refresh sequence, native observation or the recovery attempt budget.
Legacy CAS/generation APIs retain their previous behavior through the same helpers.

Evidence: public store-seam regression initially failed for missing guarded APIs;
then passed. Tests cover authority revocation with no generation consumption,
normal below-quota consumption, ledger exhaustion from another Store handle,
accounting holds, expired unresolved budget, group policy change, unauthorized
route, expiry during generation construction, and deadline expiry while waiting
for another SQLite writer. Failed writes leave no grant/audit side effects.
Focused repeated race tests, adjacent admission/budget/policy/CAS/generation race
tests and vet were run. These are bounded isolated transaction tests, not device
power-loss, production throughput, distributed database or deployment evidence.
