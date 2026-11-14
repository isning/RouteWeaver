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
