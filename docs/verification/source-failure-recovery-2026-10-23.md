# Source import failure recovery — bounded verification

## Contract and rationale

Source failures now carry an optional server-owned `lastErrorCode`, classified
from typed errors and projected through a known-code/current-failure whitelist.
Client input cannot set the authoritative code; retries, pause and success clear
it. Existing HTTP422, safe diagnostic detail, ownership and accepted snapshots
remain unchanged. Resource fetching and SSRF policy are unchanged.

A source-specific formatter supplies Chinese cause/recovery without matching
English diagnostics or interpolating arbitrary details. Unknown codes and legacy
failures use safe generic copy. Unknown nonempty statuses remain neutral rather
than green imported; stale error fields do not override known nonfailed status.
Legacy correlated422 retains the submitted source identity even when older error
metadata is missing. No automatic retry, accept, save or publication was added.

Reopening the editor pairs the ordinary authenticated public source read with its
private reveal, matching requested ID and revision before updating the form and
Cancel summary. Only the public response is returned to the parent. Both missing
revisions remain supported legacy behavior without a claimed version fence;
one missing revision, mismatch or read failure uses the existing retry path.

This follows AGENTS' public-seam testing, preserved failure input, tenant-private
source and truthful status requirements, plus CONTENT-DESIGN-RULES' concrete
cause/consequence/recovery and one relevant warning rather than redundant panels.
The established Refactoring UI review informs grouping; no styling framework or
security-policy change was introduced.

## Evidence and limitations

Evidence bundle: `source-failure-code-candidate-20261023/evidence/` (relative
artifact location; no dependency on a private executor absolute path).

- Backend RED then 11 focused HTTP/classifier/projection/regression tests passed.
- DOM RED then 52 core tests passed for typed mapping, retained input, paired
  reads, legacy correction, source detail/review and safe fallback.
- Seven source-focused workspace/recovery tests passed; unrelated cases were
  filtered out, not claimed passed.
- Built real URL-denial browser RED then GREEN: one test, 7.8s (11.8s suite),
  sandboxed Chromium, one worker, zero retries, original45s budget. Actual422,
  typed code, masked retained URL, exact identity/revision, unchanged rich parent
  draft, public/reveal readback, privacy disclosure and one journey write passed.
- Both390px screenshots were inspected: localized recovery visible in editor and
  parent. Exact fixture deletion and graceful fresh-demo cleanup succeeded.
- Application typecheck/build and browser-spec typecheck passed. Frozen source and
  build hashes were rechecked unchanged after the browser run.

Retained non-green batches are not rewritten as passes: the first DOM batch was
58pass/4fail (three10s timing failures and one genuine legacy422 identity regression,
subsequently fixed). A later reader batch was32pass/1timeout and parent batch
19pass/1timeout. Earlier parent timing cases passed unchanged on rerun. The final
two timed cases passed in isolation on unchanged candidate/original budgets;
the unchanged baseline selection-focus test also passed. These are bounded
regression results, not a clean aggregate suite or full-gate clearance.

Independent frontend production review found stale Cancel-summary and misleading
unknown-review consequence issues; both were corrected and re-reviewed. The
reviewer authored backend code and four paired-read fixture updates, not frontend
production code. Backend was separately reviewed by the frontend coordinator.

No successful external URL-fetch integration, deployment or publication is
claimed. The browser proves real safe-fetch denial/recovery; existing text-import
acceptance and offline transport tests remain complementary evidence only.

## Reproducibility

See bundle `RESULT.md`, `candidate-manifest.json`, `frontend-review.md`,
`backend-green.log`, `frontend-core-2.log`, `frontend-readers.log`,
`frontend-reader-regressions.log`, `frontend-parent-regressions.log`,
`isolated-timing-rechecks.log` and `browser-green/browser.log`.

Source manifest SHA256:
`f551bc5fe9a3f25c72e3a1b1468d5ba7566d8d1d6114289d07034930f9a9ce34`

Build manifest SHA256:
`c4493dcb5d93b977bdce69335c66dad91a346b624c1cef97a745fa02228f1701`
