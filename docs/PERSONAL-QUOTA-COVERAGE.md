# Personal quota forecast foundation

## Delivered: managed budget receipt evidence (phase 1)

New admission budgets carry versioned coverage receipt metadata inside the same
encrypted record and transaction as the existing reservation. Issuance is recorded,
but is not itself a receipt. A valid cumulative receipt updates its receipt time
even when the byte delta is zero. Final receipt time and provenance distinguish an
agent final from an operator-reviewed final. Closed-budget replays do not move the
original evidence. A backwards receipt clock sets a persistent uncertainty flag.

No extra database record or write is added. Ledger amounts, rounding, sequence,
interval timestamps, reservation expiry, refunds and admission eligibility are
unchanged. Receipt timestamps are controller receipt times, **not packet activity
times or proof of complete calendar-day coverage**. A delayed final may settle an
older budget; its receipt date must not be used as its traffic date.

Old budgets without this metadata remain unknown, including after successful
renewal/finalization. No historical evidence is backfilled. A final received without
an issued budget remains a tombstone, not proof of a covered interval. Existing
backup storage preserves additive fields; absence remains valid legacy data.

This phase intentionally adds no forecast API, estimate or UI. Absence of a hold,
zero ledger rows or a recently active IP does not establish complete account usage.

## Required before a forecast can be exposed

1. Account-level, versioned proof of exclusively managed sources over the window,
   including publication/change history; current bindings alone are insufficient.
2. Bounded sealing with all expected budgets final, including zero-use receipts,
   no uncertain clock and no unresolved legacy/ordinary-counter source. Reviewed
   finals require an explicit policy, not silent promotion to automatic evidence.
3. A defensible allocation for budget intervals spanning calendar boundaries, or
   conservative rejection of such windows. Do not distribute bytes uniformly.
4. Seven complete days, current quota/reset/expiry horizon and explicit unavailable
   reasons. Old/upgraded installations must accumulate evidence instead of filling
   missing history with zeros. Never display an estimate before these steps close.

Tests cover zero-byte receipt versus unchanged ledger interval, immutable final
replay, unknown legacy budgets, reviewed late final provenance, transaction rollback,
invalid receipts and clock reversal. These are receipt-evidence tests, not evidence
that account-level seven-day coverage has already been implemented.

## Account-scoped observation and sealing (phase 2)

`ObserveQuotaCoverageContext` is an internal Store operation, not a public forecast
endpoint. It starts an observation only from a verified current managed-entry
inventory and after all existing budgets for that account are closed. It does not
backfill the preceding week. The first supported window is exactly seven days
from that checkpoint, not a rolling calendar-day estimate.

- Current source proof checks owned grants, entry/meter bindings, exact applied
  manifests, current enrollment and the complete route. Ordinary/unknown counter
  sources remain unavailable; another account's valid unrelated source does not
  disqualify this account.
  Historical managed shadow bindings may retire only when the owned grant
  explicitly revokes them or changes their credential version/route, conditions
  that the admission gate unconditionally rejects. Subject mismatch alone is not
  sufficient. All current grants must still be proven and old budgets closed.
- Canonical source mutations invalidate only checkpoints owning the old/new
  source or depending on that exact record. Add/remove and change/restore ABA
  events therefore invalidate even if the final visible inventory is identical.
- Normal observation report/time updates and a manifest's expiry-only extension
  do not reset coverage. Identity, capability, source ownership, revocation and
  other substantive dependency changes do.
- A small encrypted per-account aggregate tracks budget issuance, finalization,
  raw bytes and the exact weighted numerator in the existing write transaction.
  It adds a checkpoint write for issuance, changed consumption or finalization;
  unchanged zero-byte renewals do not write it. No raw IP or credential is added.
- Sealing requires all budgets in the window to have agent final receipts no
  later than its cutoff. An unclosed, legacy, reviewed-final, clock-uncertain or
  cross-cutoff budget prevents a complete window. No byte interpolation is used.
- The aggregate is not a new billing ledger. It never changes reservations,
  charging, quota decisions or ledger rounding. Its final weighting rounds once,
  like canonical usage. A damaged optional checkpoint remains unknown rather
  than blocking valid budget persistence.
- A durable database coverage epoch survives normal reopen/multiple Store
  handles. Snapshot and streaming/offline imports rotate it, so restored old
  checkpoints cannot count time while the source backup was offline. Canonical
  backup records remain byte-equivalent after logical restore verification.

Explicit bounds: at most 256 tracked account checkpoints; 64 owned sources,
512 dependencies, 4096 entry/meter inventory rows per kind, 16 MiB source proof,
64 KiB checkpoint and a three-second observation transaction. The one-time start
gate must fully inspect the bounded budget inventory (10,000 rows/8 MiB); an
oversized or unresolved inventory is unavailable, never partially accepted.
Subsequent sealing uses the incremental aggregate, not a growing history scan.

This is deliberately not yet a UI feature: the user endpoint does not call this
operation, expose estimates or claim that production observation has started.
The next delivery step must wire authorized account observation, freshness and
current quota/reset/expiry policy, then present only a complete bounded window.
Long-lived connections crossing the cutoff and installations above these bounds
remain unsupported for this first window implementation.
