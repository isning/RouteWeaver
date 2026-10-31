# Remaining UI assertion migrations — 2026-10-23

## Scope and rationale
Two test-only migrations, no production edits. The unified subscription review intentionally has no Ant modal footer. The link consequence and named confirmation are asserted together inside accessible group `更新确认`, preserving the consequence at the decision point.

The Android repair flow retains the explicitly selected output. Explicitly resuming review automatically checks it again: initial Android preview → explicit profile save → resumed Android preview. Manual retry remains covered and adds request four (preview three). Every preview body checks Android output ID, target and mode; incomplete-rule focus/no-write behavior, absent MacBook review, blocked confirmation and no publication remain asserted.

## Bounded verification
All runs used the unchanged Vitest configuration, one worker and zero retries: jsdom test-body budget 10 seconds, unchanged RTL step limits.

| Run | Result | Meaning |
| --- | --- | --- |
| Initial two-file candidate | 12/13 passed, 1 failed | Retained failure: new postrepair wait wrongly expected the initial named repair alert. |
| Corrected complete two-file candidate | 13/13 passed, none filtered | Exact request ledger and manual retry reached; consequence grouping preserved. |
| TypeScript `tsc -b` | Passed | Includes candidate test files. |
| Runtime source hashes | Unchanged | Source invariant before/after verification. |
| Unchanged readiness cases | 2 passed, 30 filtered | Only the two original initial-readiness failures were selected. |

The fixture deliberately keeps returning `defaultAction: endpoint reference missing` after the IR is repaired. When that old issue no longer matches the current IR, the existing validation component falls back to a generic alert. Corrected postrepair waits assert that scoped alert contains the exact fixture error. The initial named repair alert is unchanged. The initial 12/13 failure is a candidate harness expectation error, not a demonstrated production regression; its original log remains retained in the task evidence.

The profile count and public onboarding readiness assertions were not changed. Their isolated passes do not establish why the aggregate failed and do not close aggregate reliability. There is no production-fix or full-suite-pass claim.

## Integrated files
- `web/src/explicit-rule-destination.dom.test.tsx`
- `web/src/publish-review-copy.dom.test.tsx`

Integration is restricted to these exact reviewed test postimages plus this document, with canonical preimage checks, preserved modes and unrelated-tree invariance. Existing concurrent integrations are preserved. No deployment, archive or external publication.
