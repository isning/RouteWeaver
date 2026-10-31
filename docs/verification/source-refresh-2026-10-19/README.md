# Source refresh candidate acceptance

Scope: UI-SPEC §5, C101/C203 and TECHNICAL-CONTRACTS source identity and
refresh/accept contracts. This is focused evidence, not whole RW-04 or release
verification.

## Implemented interface

- POST/PUT source and POST refresh keep an immutable accepted snapshot while
  preparing at most one pending candidate, stored in the encrypted owner record.
- An unchanged connection/name/order result retains its accepted snapshot ID and
  does not ask for review. Harmless additions or proven renames can be accepted
  directly. Removals, connection changes, affected dynamic/manual/nested group
  selections and newly encountered extraction warnings require review.
- Source responses contain `revision`, `refreshStatus`, `checkedAt`, and a
  redacted `candidate` when review is needed. `updatedAt` continues to identify
  accepted content; a failed check does not claim a fresh accepted snapshot.
- GET `/me/sources/{id}/candidate` returns the redacted review. Only explicit,
  owner-scoped `/candidate/reveal` returns candidate connection values. Ordinary
  source reveal includes the saved source input and accepted connection values,
  but never the private dependency manifest or pending connection values.
- POST `/candidate/accept` or `/candidate/reject` requires `candidateId` and
  `sourceRevision`. Acceptance atomically compares the exact current source,
  captured dependency records, and dependent-kind membership. A changed input,
  changed dependency or newly created dependency returns 409 without replacing
  accepted data. Rejection does not require unchanged dependencies, but does
  require the exact current source/candidate pair.
- Edits are saved even if fetch/import fails; their last accepted snapshot stays
  intact. A later failed check, edit, rejection or new candidate discards the old
  candidate. Deleting the source deletes its embedded candidate; stale decisions
  cannot recreate it. No source operation writes a profile or published output.

## Privacy and bounds

Diffs expose labels, identities, counts and changed schema field names, not old
or new connection values. Credentials appearing in imported labels and URL
query/userinfo/fragment values are redacted in source summaries. Candidate
snapshot and dependency manifest use the existing authenticated encrypted store
and remain owner scoped. No credential contributes to a newly introduced ID.

The parser retains its established identity reconciliation. Ambiguous bulk
credential rotations, unsupported protocols and malformed nodes fail closed;
no guessed replacement or partial usable snapshot is accepted. Explicit empty
native arrays create removal candidates; missing/null arrays and HTML/blank
input remain errors. Safe fetch still uses the existing SSRF protections,
2 MiB fetched body limit and 15-second timeout. Review captures at most 2,000
records per dependent kind and at most 16 MiB of encrypted candidate content;
a source stores only one pending candidate. Parser bounds are documented in
`internal/importer/README.md`.

## Test seams and evidence

HTTP owner/session/CSRF APIs, importer Parse, and UI user tasks are the tested
seams. Tests use synthetic in-process data. The safe-fetch rejection fixture
uses a blocked localhost URL and never connects to it; no live subscription
fetch, external credential, VPS or public publishing is involved.

Red-before-green observed:
- Empty native array rejected by Parse before the focused parser change.
- Unchanged refresh created another accepted snapshot before nil/empty warning
  equivalence was corrected.
- Nested affected group absent before transitive dependency propagation.
- Material-refresh review UI and unchanged-result feedback absent before UI work.

Focused tests cover accepted/candidate separation, accept/reject/replay, owner
isolation, field-only credential rotation diff, secret-bearing transport URLs,
explicit reveal, stable rename identity, harmless addition, dynamic and nested
groups, dependency membership CAS, invalid/partial/failed-input preservation,
valid empty removal, deleted/stale decisions, and form retry revision retention.
Published output revision remains unchanged after acceptance.

Independent review and native parser/process/traffic gates are separate evidence.
No claim of remote endpoint reachability or live traffic success follows from
these tests. Ambiguous identity reconciliation intentionally remains an error
with the prior accepted snapshot retained, rather than an automatic guess.

## Recorded outcomes

- `scripts/go.sh test ./internal/httpapi ./internal/importer ./internal/resources -count=1`: passed (see `go.log`). The safe-fetch suite uses its real HTTP transport with controlled resolver/net.Pipe fixtures.
- Five source-refresh DOM user-task tests: passed (`dom.log`). These cover material review/accept, unchanged refresh, failed edit retry, stale review recovery affordance, and correcting a failed first import without a duplicate.
- TypeScript check and production Vite build: passed (`typecheck.log`, `build.log`). The existing large shared bundle warning remains visible; no warning threshold was changed.
- Focused Playwright source-refresh test: **blocked before test execution** (`browser.log`). Normal sandboxed `/usr/bin/chromium` launch failed in the host with `process_singleton_posix.cc` socket `Operation not permitted` and crashpad initialization errors. `chromiumSandbox: true` remains unchanged. No sandbox bypass was attempted, no screenshot was produced, and browser/visual success is not claimed. The committed test is ready to rerun in a supported sandboxed browser host.

The generic task-experience DOM run was also attempted: its source More/delete
coverage passed, but an unrelated subscription fixture still expected the
`本周期用量` heading after subscription-page work changed that layout. That result
was reported to the owning worker, not counted as a full UI pass here.
