# Subscription creation: preserve the task, suspend unavailable writes

## Product contract

An opened “新增客户端订阅” task belongs to an explicit opening, not to the latest inventory response. Temporary profile loading, transport error, offline/paused reads, or a successful response that no longer contains the target must not erase its name, client, output mode, reviewed output ID, or uncertain creation attempt. A missing target is distinct from a failed read; neither permits substituting another profile.

Unavailable current profile data blocks fresh inspection, creation and explicit POST replay. Retained display data is not renewed write authority. Ordinary review is not discarded merely because a refetch starts or fails; existing input/session/revision fences and the server's recomputed review digest remain authoritative. There is no new partial client fingerprint.

An uncertain attempt keeps the exact submitted payload, identity and digest. Read-only receipt recovery remains available while the target is unavailable, and a legitimate same-opening response can still complete. Retry is explicit and reuses that exact attempt, including the primary-button replay path. Recovery never automatically replays a write. Leaving opening A and starting B prevents A's late callback from altering B; it does not cancel or undo a server request.

Explicit cancel/new opening resets normally. Same-account session recovery preserves the task; changing accounts discards private state through the existing session boundary. Completion preserves the access view after the creation dialog closes. Receipt/retry actions retain their accessible names while exposing busy state.

## Implementation and reusable tests

Only production file: `web/src/Subscriptions.tsx` (`SubscriptionsPage`, `PublishOutput`). Existing server digest/409 behavior, permissions, API, and account boundary are unchanged. Related authority paths remain `web/src/SessionBoundary.tsx` and `internal/httpapi/outputs.go`.

New public-page regressions:
- `web/src/subscription-creation-session.dom.test.tsx`: customized uncertain attempt across profiles503/refetch, exact receipt/access identity.
- `web/src/subscription-creation-ownership.dom.test.tsx`: held POST success/failure/409 and receipt results after actual page-scope navigation from A to B.
- `web/src/subscription-creation-readiness.dom.test.tsx`: pending/error/paused/missing reads, unchanged review recovery, receipt recovery during unavailability, cancel/reopen, full-App same-account/account-change boundary, and held receipt/replay accessible-name/busy assertions.

These fixtures use public user actions and HTTP seams, not private child setters. The DOM fixture's development environment avoids the installed dialog library's test-only duplicate ID behavior; cleanup restores it. This is a fixture limitation, not a production environment change. DOM tests do not establish pixels or native client validity.

## Results and limits

Evidence was collected incrementally; this is **not a full-suite green claim**.

| Stage | Actual result and interpretation |
|---|---|
| Initial tracer | Immediate post-refetch replay-disabled assertion failed; intended modal-loss failure not yet observed. |
| Settled baseline tracer | Visible profile-read failure followed by missing creation dialog; intended task-loss failure established. |
| Initial five new cases | Final access-name assertions failed. Observation confirmed actual access and exact-ID GET, but test-only duplicate dialog title IDs; fixture environment corrected. |
| Corrected five cases | 5/5 plus typecheck passed on the initial ownership-fenced implementation. |
| Broader contract run | 60/68 passed; seven unchanged canonical assertions exposed an introduced primary replay incompatibility, and one ownership case hit its original10s deadline. Four selected session tests:3 passed,1 initial-entry lookup failed,30 filtered. Typecheck passed. |
| Replay correction | Restored exact frozen-payload primary replay.40/40 targeted cases and typecheck passed; canonical regression assertions were not rewritten. |
| First built browser | 1/6 passed. Unique project fixture names and cancel spacing needed correction; an actual loading-prefix accessible-name inconsistency was addressed with four aria attributes. Timeout cleanup also obscured one primary failure; subsequent fixture preserves it and records incomplete audits. |
| Busy-name checks | Two held-response cases passed; first typecheck failed on three unsupported RTL options. Removing only those options retained exact string-name matching. Corrected run:2 passed,7 deliberately filtered, typecheck passed. |
| Corrected built browser | 6/6 passed at1440×1000 and390×844, using production-built JS/CSS and Go server. Bounded pixel review accepted task preservation, keyboard GET recovery and disabled writes. Not universal content/accessibility certification. |

The40-case pass preceded the four aria attributes. Current attributes have focused two-case/typecheck and six-case built-browser evidence; no new aggregate regression result is implied.

Two earlier broader failures remain unresolved:
1. `subscription-creation-ownership.dom.test.tsx`: departed `post-conflict` case exceeded10s in the broader run. Later desktop/mobile browser ownership passes do not erase that DOM result.
2. `session-recovery.dom.test.tsx`, “retains a concealed draft after expiry and retries only after same-account login and another Save”: failed at its initial `新建集合` lookup, before the recovery task. Do not classify this as a demonstrated publication defect or a pass.

The final browser used real demo login/profile setup and unmodified backend publication guards, but controlled same-origin preview/create/receipt/access responses. Output POSTs were never forwarded; unplanned API mutations were recorded and aborted. All six real backend-output before/after comparisons completed unchanged. Exact uncertain receipt/access recovery required only GET after its initial synthetic POST. All request ledgers had no unexpected mutations or foreign requests. Native core validation, genuine output persistence, client delivery, traffic and deployment were not tested by these fixtures.

All final source/dependency/build boundaries were unchanged; the owned server stopped and its temporary demo database was removed. Twelve settled captures include ordinary error/recovered views and uncertain top/lower notice/footer/access views. Full-page narrow captures extend below the actual844px viewport; below-viewport content is not evidence of modal mask behavior. Browser scripts, raw captures and intermediate logs remain private verification evidence, not repository regression fixtures.

## Reproducible repository checks

From the repository root, with its declared dependencies installed:

```sh
# All three reusable files (14 cases in the current files); not claimed as an
# already-executed aggregate on this final revision.
npm --prefix web run test -- \
  src/subscription-creation-session.dom.test.tsx \
  src/subscription-creation-ownership.dom.test.tsx \
  src/subscription-creation-readiness.dom.test.tsx \
  --maxWorkers=1 --retry=0

# Exact focused current-revision checks: two selected, seven filtered.
npm --prefix web run test -- src/subscription-creation-readiness.dom.test.tsx \
  -t '^keeps the uncertain (receipt|retry) action name stable and exposes busy state while its response is held$' \
  --maxWorkers=1 --retry=0
npm --prefix web run typecheck
```

Existing regression companions are `output-creation.dom.test.tsx`, `publish-input-lifecycle.dom.test.tsx`, `first-subscription.dom.test.tsx`, `publication-reconciliation.dom.test.tsx`, and the scoped `session-recovery.dom.test.tsx` cases. Preserve their original budgets and assertions. Testing Library role queries accept an exact string `name` but not Playwright's `exact:true` option; do not copy options between these APIs.

## Separate next presentation improvement

An unknown publication result currently coexists with a generic red “操作未完成”/raw503 message and footer “新建独立链接”. This is misleading or redundant hierarchy: it can suggest definitive failure or a fresh creation while the safe task is to establish the prior attempt's outcome. The current six browser passes do **not** fix or certify that content hierarchy. A separate narrow presentation change should clarify it without altering exact-attempt recovery, write readiness, owner fences or replay semantics.

## Design references

Public references verified2026-10-24.

- [React: preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state) explains state ownership by render-tree position. This informs separating a persistent user task from transient inventory availability.
- [W3C: Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html) requires the visible label words to be included in the accessible name. Keeping that name stable across loading is this project's additional consistency rule, not an extra requirement of that success criterion. These bounded checks are not a WCAG conformance audit.
- Repository `docs/design/CONTENT-DESIGN-RULES.md` governs task-specific states and recovery hierarchy.
