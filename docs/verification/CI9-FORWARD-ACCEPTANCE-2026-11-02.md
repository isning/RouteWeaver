# CI9 finite forward acceptance — 2026-11-02

**The current software candidate is not finished:** one original literal clause
remains unmet, RW-07.3 stale profile-editor writes. This is distinct from the
unclassified NET-03 historical timeout and actual deployment inputs.

## Verified execution and complete finite review

[CI9 run41406226333](https://github.com/isning/RouteWeaver/actions/runs/41406226333)
completed with **all 18 jobs successful**, exact remote
`30906420acc235d4285be27857fd416383914483`, tree
`9a848d8631aa3c0bd2f355311040483a93db9428`, equal to tested local
`7a101032f55c1bde5ff308ffa1ddfcdd97b8d79e`.

- Ordinary browser: **202 unique cases / 56 files**, zero skips/flakes/retries.
  Six actual trusted-clipboard/rendered-QR sequences passed across1440/390px.
  Diagnostic320 passed twice Escape/exact opener/no writes and readable pixels.
- Separate same-instance browser/native bridge: one pass,4,566ms; all nine
  identity fields/binary match, strict409, stop/restriction and owned cleanup.
- Web:2,115/2,115 in197files,630.18s in CI; types/build passed. Local equivalent
  full gate passed851.86s. Historical stalls are not causally explained by that pass.
- New external native shared-entry rate case: once PASS8.58s, strict managed gate
  passed; two entries each262,144B up+down, approximately7.939s; exact stopped
  journal1,048,576B+8B warmup, owned absence and checked closes.
- Final local static/secret checks and independent four-file production delta
  Standards/Spec reviews passed their recorded scopes (zero concrete findings).
  That four-file review did not detect or certify the pre-existing profile-write
  contract. This later literal audit is a distinct review, not contradictory proof.

Three independent read-only clause reviews inspected source/assertions and public
seams, joined to those executed receipts. **All 98 original clauses were assessed:
95 supported, 1 unresolved (RW-07.3), 2 conditional (RW-24.1 and RW-24.4).** Original wording,
35-story coverage and dependency edges are unchanged. Both conditional clauses
are consequences of the same RW-07.3 finding, not two additional defects. No additional confirmed
software gap was found. Composed model/API/UI evidence is accepted where the
original clause does not require one single journey; no new all-hop/permutation
matrix or product feature is demanded.

## One concrete software blocker

RW-07.3: “Draft and published revision are separate and stale writes fail without
losing the submitted draft.” Draft/frozen-publication separation is supported,
but a stale **profile draft save** has no opened-editor revision precondition:

- `internal/httpapi/tenant.go:54–68,382–416`: Profile contains no opened revision
  token; saveProfile does not compare request If-Match or a submitted baseline.
- `internal/httpapi/template_inputs.go:79–94`: expectRecord snapshots latest state
  at request start. It fences in-request races, not editor B opened before A saves.
- `web/src/api.ts:194–210` guards server-deployments/published-routes only;
  `web/src/Profiles.tsx:514–552` submits me/profiles without that baseline.

A stale B submission after A's completed save can therefore replace A. Existing
publication-review digest409 and synthetic UI409 are different seams. This is
confirmed source-level evidence; no new reproducer was executed by this audit.
Minimal remaining verification: genuine two-editor HTTP failing-before-fix case,
opened-revision rejection preserving server state and B's draft, then affected
UI/API/current-source aggregate verification. Implementation is assigned separately;
this documentation does not change code or authorize another CI run.

## Forward ticket disposition

Only fully supported tickets whose direct prerequisites are already accepted are
verified. **13 verified, RW-07 in_progress,10 dependency-blocked.** RW-24 is not
allowed to close those dependencies just because CI is green.

| Layer | Ticket and disposition |
|---|---|
| 1 | RW-01: verified; RW-02: verified |
| 2 | RW-03: verified; RW-04: verified; RW-15: verified |
| 3 | RW-05: verified; RW-13: verified; RW-16: verified |
| 4 | RW-06: verified; RW-14: verified; RW-17: verified; RW-19: verified |
| 5 | RW-07: in_progress; RW-18: verified |
| 6 | RW-08: blocked; RW-09: blocked |
| 7 | RW-10: blocked |
| 8 | RW-11: blocked |
| 9 | RW-12: blocked; RW-20: blocked |
| 10 | RW-21: blocked; RW-22: blocked; RW-23: blocked |
| 11 | RW-24: blocked |

## Risk and actual deployment stay separate

The final674 qualified reference retains14/14 operations and the complete1,800s
window. Runtime production is unchanged through7a10103. The original sample410
read/cleanup failure remains **UNKNOWN**, with missing original telemetry not
recoverable; later passes neither explain nor erase it. No demonstrated current
causal defect was found by the bounded forensic review. **NET-03 is not closed**;
owner acceptance of that explicit residual risk is pending. No arbitrary extra
soak duration or retry count is introduced.

Actual host/client/network/workload/custody/TLS/channel/recovery objectives remain
unchosen or unverified for one CP/Linux/private invitations. Merge/main/deployment
authority is absent. Local software/reference evidence is not target acceptance.

## Evidence and documentation boundary

[Machine-readable review](CI9-FORWARD-ACCEPTANCE-2026-11-02.json) retains every
literal clause, exact supplemental selectors, scope, forward decisions and receipt
hashes. [Full ledger](TICKET-CLAUSE-ACCEPTANCE-LEDGER-2026-11-02.json) preserves the
82 existing evidence groups and historical bindings. Catalog/generated ticket
changes are documentation **after** the tested7a10103 source, not a new all-green
execution of this documentation commit. No product files, tests, CI, main, real
target or external permissions were changed by this adjudication.

## Existing checklist Pages reconciled

The [main checklist](https://chatgpt.com/space/page_3061f8987e588191b79a495a69a5995b)
is now **22/32** at sequence13. Only PRD-03, UI-02, UI-04, ENG-04 and NET-02 were
newly closed, within their explicit tested scope. PRD-01/04 and NET-03 stay open.
The [35-story evidence index](https://chatgpt.com/space/page_cf4eab5740c08191aab5caf2895263b8)
is sequence9. Both were read back; all130/161 blocks and IDs remain, exact changed
text matches, and untouched hashes are unchanged. No title, instruction, sharing
or schedule changes. These are the CI9 snapshot, not acceptance of a later fix.

## Independent documentation review

**Standards:** 0 concrete findings. **Spec:** 0 concrete findings. Separate
read-only reviewers checked this documentation delta against tested7a10103,
original clauses/dependencies, truthful scope and retained receipt hashes.
`python3 scripts/tickets.py check` and `git diff --check` passed; frontier is
exactly RW-07. No application tests were run by this documentation reconciliation.
