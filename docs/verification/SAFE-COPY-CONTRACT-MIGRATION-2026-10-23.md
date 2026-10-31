# Safe-copy contract migration — 2026-10-23

## Scope

Test-only migration in `web/src/task-experience.dom.test.tsx` and `web/src/source-import-task.dom.test.tsx`. No production code changed. User-task behavior, focus, gesture ownership, snapshot retention, exact request-count assertions, cached URL hiding, and retry presence were preserved.

The complete Vitest run on 2026-10-23 reported 1060 passed / 17 failed / 1077 tests (87 passed / 14 failed files). Actual failure stacks identified three obsolete raw-error-copy expectations: cached subscription access rejection and two source-import read-back gesture cases. This migration does not close the remaining 14 failures and does not establish an aggregate pass.

## Contract evidence

- Access unavailability uses HTTP 409 with a generic `detail` body in `internal/httpapi/outputs.go`; absent/disabled owners are unavailable under `output_eligibility.go`. The fixture now matches that contract instead of inventing a raw paused-service 403/error message. The UI displays its safe localized generic notice. The test explicitly rejects the raw backend detail and continues to require no cached URL, copy action, or download action, plus a retry action.
- `source-failure.ts` provides a safe fallback for failed imports without a recognized error code and intentionally does not interpolate raw `lastError`. Both read-back gesture cases now expect that fallback and explicitly reject raw error text. Double-click/held-Enter ownership, focus, accepted snapshot, and request counts are unchanged.

## Verification

The isolated current-source candidate changed exactly the two test files. One-worker Vitest, default retry zero, and original configuration budgets:

```sh
npm --prefix web run test -- src/task-experience.dom.test.tsx src/source-import-task.dom.test.tsx --maxWorkers=1 -t 'does not offer a cached subscription link when the current access check rejects it|requires a new use gesture after read-back by'
npm --prefix web run typecheck
```

Result: **3 selected tests passed; 15 filtered/skipped tests are not passes**. Typecheck exited 0. No full-suite rerun. The candidate and then-canonical source manifests were unchanged through verification. QA lock was held 23:40:12–23:40:38 UTC. Integration subsequently validates exact preimages/postimages and preserves unrelated concurrent changes under the same QA lock.

Verified postimage SHA-256:

- `web/src/task-experience.dom.test.tsx`: `eb4c0ad21b3a617706fb09f07bfae2b146e64a22334b095c11d354c6fd057d13`
- `web/src/source-import-task.dom.test.tsx`: `5f466b88d632084d48b1e362afbb8da82b0115b6ffab1532c0fc7929e0b90228`

This is evidence of three test-contract corrections, not proof that the other timeout, readiness, request-count, or placement failures are resolved. No archive, deployment, browser/native gate, or user-file operation was performed.
