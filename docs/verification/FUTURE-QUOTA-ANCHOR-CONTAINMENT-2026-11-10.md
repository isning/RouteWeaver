# Future quota-anchor containment, 2026-11-10

## Reproduction and scope

On baseline `aa8c7efd2bf3416d2c87c1d3336b22df461a92f3`, a synthetic
finite-quota entitlement with an already-passed service start and a future cycle
anchor could admit 100 bytes, settle all 100 bytes, then admit another ceiling
before the anchor. The current usage window began in the future, excluding the
settlement; the closed reservation no longer consumed the available budget.
The same condition exists for `none` when its explicit anchor is in the future.
This was reproduced in local storage/admission tests, not observed in production.

## Conservative safeguard

Finite quota issuance now returns the existing `accounting-pending` reason while
the computed cycle start is later than evaluation time. The shared usage
eligibility check also prevents service-policy-fenced writes from granting access
on that empty future window. Byte issuance has a second defensive check.

This is a reversible fail-closed safety hold, not a new definition of quota
periods. It has an availability consequence: an otherwise active finite-quota
entitlement cannot receive a new or increased byte budget until its calendar is
usable. It does not rewrite `StartsAt`, the anchor, service validity or UI quota
history, and does not claim that the quota is exhausted. No unrelated policy,
public endpoint or status vocabulary was added.

Settlement remains before eligibility. Already-issued budgets can report partial
or final usage, including exact retries; a denied renewal commits that settlement
without increasing the ceiling or extending its lease. The canonical ledger is
preserved. At the anchor, this guard releases and existing calendar rules apply.
Unlimited quota and legacy zero-anchor no-reset behavior are unchanged.

## Accounting decisions deliberately left open

No calendar/ledger migration or retroactive debit/refund was performed. Before a
broader repair or rollout, decide:

1. Is pre-anchor service prohibited, governed by an introductory quota window, or
   charged against the first regular cycle?
2. At the anchor, does introductory consumption reset or carry forward?
3. Should existing pre-anchor consumption remain historical-only or receive an
   explicit auditable adjustment? Original measurements must not be rewritten.
4. May policy edits exclude already-settled usage by moving the anchor, or must
   such changes go through a separately reviewed reset/migration operation?

The current code's existing post-anchor usage selection is not redefined by this
containment. Moving a calendar after the fact and old affected accounts still
require review. No live accounts, nodes, enrollment or production data were
inspected or modified for this change.

## Verification

Public storage/admission seams in `admission_future_anchor_test.go` cover:

- future finite anchors for monthly, anniversary, fixed-days and none;
- exact anchor equality, unlimited quotas and legacy zero anchors;
- existing pre-fix budgets, partial/final settlement and idempotent replay;
- no increased ceiling/lease extension, unchanged ledger on admission denial and
  preserved historical pre-anchor usage;
- shared service-policy-fence rejection without partial writes;
- hold-to-anchor resumption without changing the saved policy or inventing usage.

The initial future-anchor admission and service-fence tests failed before the
safeguard and passed afterward. Focused quota/admission/fence regressions and the
new suite with `-race -p=1` passed locally. Independent source review found no
blocking issue. Focused checks do not substitute for the exact-commit aggregate
CI, native runtime or deployed acceptance.
