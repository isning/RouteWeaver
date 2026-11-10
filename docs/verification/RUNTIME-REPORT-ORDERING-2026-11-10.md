# Runtime observation ordering, 2026-11-10

## Scope and reproduced defect

Baseline: `aa8c7efd2bf3416d2c87c1d3336b22df461a92f3`.
Synthetic local HTTP/reconciler fixtures only; no production incident or deployment is asserted.

A delayed conformant report for the same desired generation could replace a
newer stopped report. The generation fence did not order facts within that
generation. The operation archive's first-success retention was intentional,
but after success its CAS no longer serialized updates to current runtime facts.

## Safeguard

- The production driver obtains a current snapshot from `ObservationReport`.
  A decimal-string sequence is durably allocated in the private agent journal
  before transport, under the existing exclusive root lock and reconciler mutex.
- Sequence is enrollment-wide, not restarted per desired generation. Restart
  retains it. Failed journal writes produce no sendable snapshot; gaps are safe.
  Overflow fails closed instead of wrapping.
- The control plane rejects older sequences, equal sequences with different
  facts, and unsequenced reports after the first sequenced report in that
  enrollment. Exact retries do not rewrite state/history or refresh receipt time.
- The write CAS includes current observation, desired state, enrollment and
  operation archive. Historic first success remains separate from current state.
- Exit-review semantic fingerprints exclude report sequence, just as they exclude
  observation timestamp/evidence. The commit still compares complete live records.

This orders reported facts; it does not establish fresh native liveness, authorize
an operation, change a quota debit, or make transport acknowledgement deployment
success. Custom transport callers must use `ObservationReport`, not manually
relabel older saved states with newer sequences.

## Compatibility and rollout

Upgrade the control plane before agents: older control planes strictly reject
unknown JSON fields. Existing unsequenced agents remain compatible until a
sequenced report is accepted, so their old ordering limitation remains until
upgraded. That enrollment cannot then silently downgrade to unsequenced reports.
A new enrollment has its own sequence namespace and existing authentication and
desired-identity checks still apply.

Existing agent journals load with a zero sequence. Once the new field is persisted,
older agents' strict journal readers cannot read it. Do not delete the journal or
rewind its counter to downgrade. Journal loss or exhausted sequence requires an
explicit operational recovery/re-enrollment; no such operation was performed here.

## Verification

Failing before passing:

- `TestRuntimeObservationRejectsOutOfOrderReports`: delayed active after stopped.
- `TestDriverReportsRemainOrderedAcrossRestart`: driver previously emitted zero.
- Strengthened `TestManagedRouteRetargetHeartbeatDoesNotInvalidateReviewAndOldPathRemainsObserved`:
  advancing sequence initially invalidated an otherwise unchanged exit review;
  the semantic projection fix restored the reviewed draft change.

Passed locally:

- Three initial new HTTP/driver/journal-failure regressions with `-race -count=5`.
- All five named regressions together on the final runtime source with
  `-race -p=1 -count=1`, including legacy adoption, concurrent writers and
  sequence exhaustion/unchanged runtime facts.
- `TestObservationSequenceDoesNotChangeRuntimeFactsOrWrap` with `-race`.
- Strengthened exit-review test after its semantic projection correction.
- Independent source review found the exit-review integration issue above; no
  other current-observation writer that discards the ordering field was found.
  Existing focused driver/restart/enrollment-history/meter-accounting checks passed.

The subsequent exact-commit CI remains authoritative for aggregate gates. These
focused checks are not full native, browser, deployed or production acceptance.
