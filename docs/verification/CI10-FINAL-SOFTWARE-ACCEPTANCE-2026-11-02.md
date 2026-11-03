# Final bounded software acceptance — CI10, 2026-11-02

**The original finite software checklist is accepted: 98 clauses, 24 tickets and
35 stories. Production readiness remains 24/32, not complete.** The eight remaining
items require actual environment acceptance, the NET-03 residual-risk decision,
and/or explicit rollout authority. No main merge or deployment has occurred.

## Exact tested application source

- Local: `87bfac541c4be43d9b307234a3ac84db1feab207`.
- Remote: `76c82e41c7e83893c6fea040052ce163bd024dcb`.
- Identical tree: `67502bb487043bd53e151ba7cff7cee6dd61781f`.
- [CI10 run41417857984](https://github.com/isning/RouteWeaver/actions/runs/41417857984):
  all **18 jobs succeeded**, including strict repository summary; terminal run
  updated at 2026-11-02 09:25:47 UTC.
- Ordinary browser: **204 cases / 57 files**, zero retry/skip/flaky. Separate owned
  same-instance browser/native bridge: one pass, 4,449ms, nine identity fields,
  binary hash, typed409, stop/restriction and checked owned cleanup.
- CI web: **2,120/2,120**, 197 files, 486.66s; types/build passed. Local equivalent
  web source passed 878.87s and 31 HTTP API cases passed; final87 versus local938
  changes only one Python harness timeout assertion, not application/web/API code.
- Final local static: 64 helper regressions, architecture and actionlint passed.
  Secret/history scan: 2,652 distinct path/content pairs, 6,622 entries, 147 exact
  reviewed line exceptions, zero unreviewed findings; no broad path exemptions.

## Targeted closure, not a new broad audit

The [CI9 finite audit](CI9-FORWARD-ACCEPTANCE-2026-11-02.json) is retained unchanged:
95 clauses supported, one genuine RW-07.3 finding, and RW-24.1/24.4 dependent on it.
Only these three current dispositions change. Original criterion wording, all
story mappings and all dependency edges are unchanged. Existing applicable gates
reran at CI10; no extra all-hop/permutation requirement or feature was invented.

### RW-07.3 — stale writes preserve the submitted draft

The existing private-record HMAC opening token is supplied as If-Match and carried
into atomic CAS. Full/basic editors preserve rejected input, prohibit silent
latest-token overwrite, recover only after explicit discard and advance their
baseline only after an accepted save. Published feed artifacts remain separate.

Real HTTP RED/GREEN and three unconditional source tests cover sequential stale
editors, missing/wildcard/upsert bypass, tenant/CSRF/foreign-token rejection,
legacy stored profiles and exactly one accepted writer across two store handles.
The exact final HTTPAPI package passed **uncached, unfiltered `-race -count=1` in
1,039.765s**. This is nonverbose: no individual RUN/PASS or per-test no-skip events
are emitted. Inclusion is established from source plus executed command/package
result, not fabricated per-case telemetry.

Two real-backend browser journeys at **1280/390px passed once in 4,904/5,205ms**:
competing accepted200 then original-token stale409; retained name/DNS/sniff;
blocked overwrite; accepted server revision and published bytes unchanged;
cancel preserves input and exact focus; explicit discard/reopen; two accepted
saves use consecutive successor tokens. Exactly three UI writes. Original
screenshots were reviewed: warning, retained name and discard/save controls are
visible; below-capture runtime values are proved by assertions, not pixels.

### RW-24.1 and RW-24.4 — prerequisites and final review

The same original 11-layer graph was traversed forward. RW-07 now passes after
RW-06, then its original dependent tickets pass in order; RW-24 closes last.
All 24 tickets and 35 bounded software stories now have accepted prerequisites.
This is not reverse closure inferred merely from a green aggregate.

The repair's delayed-discard finding was also fixed. Separate Standards/Spec
reviews have zero remaining actionable findings; all 20 reviewed production/
context blobs match the final application source. Final affected browser, backend,
web, API and strict CI checks passed. The preserved sample410 risk is not described
as a fixed software finding or erased by these results.

## Eight remaining production checklist items

| Item | Exact remaining input or evidence |
|---|---|
| PRD-02 | First supported actual client/network subscription use; shares NET-01 acceptance. |
| RUN-04 | Selected Linux host/distro/permissions/storage/service startup and restart. |
| NET-01 | Actual client/protocol/network route, DNS, failure and revocation behavior. |
| NET-03 | Owner decision on explicit original sample410 unknown-cause residual risk. |
| NET-04 | Chosen first-user/node/history/disk envelope and measured target limits. |
| OPS-02 | Actual key/backup custody, independent restore destination and RPO/RTO. |
| OPS-03 | Actual host incident handling and configured notification-channel delivery. |
| OPS-04 | Trial target/config/invite bounds, pause/recovery conditions and explicit merge/deploy authority. |

The qualified controlled reference retains 14/14 operational drills and the full
1,800-second window. The original sample410 IO/cleanup failure remains **UNKNOWN**;
no further recoverable causal evidence was identified in the bounded forensic
review, and no current causal defect was demonstrated. Later passes do not explain
or erase it. NET-03 remains open; owner acceptance is pending. No arbitrary extra
soak length or retry count is imposed.

## Existing Pages and candidate artifact

[Main checklist](https://chatgpt.com/space/page_3061f8987e588191b79a495a69a5995b):
**24/32, sequence14**, only PRD-01/04 newly checked.
[Evidence index](https://chatgpt.com/space/page_cf4eab5740c08191aab5caf2895263b8):
**35 software stories, sequence10**. Readback matches all intended text; all130/161
block IDs/order and untouched block hashes remain. No title, instructions, sharing
or schedule changes. Actual rendered Page layout was not separately inspected.

[Private Linux/amd64 candidate package](https://github.com/isning/RouteWeaver/actions/runs/41417857984/artifacts/13127893775)
binds exact76c82, passed reproducible build and 12 smoke checks, expires
2026-11-09 09:09:08 UTC, and requires repository access. It is not a permanent
release URL or installed target. CI10 compute estimate is $0.720; cumulative
$6.552 before tax/storage, not a bill. Authorized total cap remains $10.

## Documentation custody

[Machine-readable final record](CI10-FINAL-SOFTWARE-ACCEPTANCE-2026-11-02.json)
retains all98 decisions, original forward graph, final receipt/log/source hashes,
backend telemetry limits and Page readback. The catalog/generated ticket statuses
are a **documentation-only update after** the tested application source, not a
claim that this later documentation commit itself ran CI. Prior CI9 and failed
historical receipts remain intact. This reconciliation ran only documentation
render/checks; no application test, browser/native run, new CI, remote Git write,
main change, deployment or permissions change.

A separate read-only targeted documentation/Spec consistency check found zero
concrete issues: prior95 unchanged, exactly three intended closure rows changed,
original graph/criteria preserved, receipt/source hashes matched and production
boundaries retained. This was not a new broad acceptance or implementation audit.
