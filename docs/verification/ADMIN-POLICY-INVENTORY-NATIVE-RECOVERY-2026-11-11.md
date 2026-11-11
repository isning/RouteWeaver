# Policy inventory native recovery sampler

Source-only follow-up to `ADMIN-POLICY-INVENTORY-RECOVERY-2026-11-11.md`.
The public seam is the real App, Services/UserGroups tables, refresh actions and
revision-guarded editors. HTTP alone supplies synthetic reads. No production
code, backend enforcement, saved policy or deployment is changed by this sampler.

## Bounded journeys

`web/tests/admin-policy-inventory-recovery.ui.spec.ts` defines eight cases:
services/groups × 1440×900/390×560 × refresh-focus/newer-editor ownership.
Each starts from 25 synthetic records, moves to page two and retains service
search where present. A failed refresh uses the real App automatic retry. The
cached row remains available. Direction-aware Tab/Shift+Tab finds refresh without
wrapping through browser chrome; Enter activates failure and Space activates the
held retry. Further Enter/Space during the held pending read must not duplicate
requests. Failure is armed only after the refresh control genuinely owns focus.
Numeric authentication-read counters and sanitized traversal evidence distinguish
preparation from the intentional reads, without logging credentials or auth data.

The refresh-focus path settles successfully without losing focus or page two,
then opens the correct row. The newer-editor path opens row 10 while the inventory
is still pending and requires its independently fetched authoritative name,
not the cached row name. A typed unsaved draft and its focus survive inventory
recovery. Neither path invokes preview, Save, apply or publish.

The edit-context fixture is restricted to exactly the row-10 target for that
case and includes existence and opening revision. This observes frontend use
of guarded context, not backend revision rejection or concurrency enforcement.

## Safety and evidence

Loopback only; every API request must be a query-free GET to an explicit fixture
path. All state APIs are fulfilled synthetically. Only verified static-path
patterns with bounded Vite query metadata can continue to the local server.
Unexpected reads, writes and external requests are blocked and recorded as
categories, never URLs, bodies, headers or credentials. Page errors are counted
without recording potentially sensitive text. Browser trace/video/automatic
screenshots and service workers are disabled for these cases.

Captures preserve the original viewport before geometry checks. Pending
captures intentionally do not ask the globally busy page to settle. Settled
checks retain the existing task-surface helper unchanged. Refresh focus is checked
for visible keyboard focus, viewport containment and center-point obstruction.
Privacy-masked PNGs and focus/viewport JSON are retained only under explicit
`policy-inventory-*` phase filenames, plus the synthetic request ledger. Final
original-position evidence and ledger are attempted even after a journey fails.
The workflow contract tests include actual truncated output directory names and
negative private/arbitrary-file checks; these are not observed browser artifacts.

## Initial source verification and limits

- Focused workflow contracts: 5/5 passed; final rerun 10.438 seconds after updating the
  supplemental lane label to its actual 24-spec count.
- Strict standalone TypeScript check of the new spec, its helpers and recovery
  configuration passed. The first two command attempts needed TypeScript 7's
  explicit `--ignoreConfig` and `--types node`; no source weakening was needed.
- Supplemental and required Playwright discovery each found all eight cases.
- `git diff --check` passed.
- Independent source review accepted the bounded sampler. Its lane-count metadata
  correction was applied and the focused contracts rerun. Setup uses pointer
  pagination/search fill; recovery and editor entry use keyboard. Row attachment
  demonstrates retention, not visibility in the current viewport. A fixture-only
  follow-up supplies the matching synthetic group plan through the existing
  allowlisted services response, avoiding an unrelated missing-plan state.
  Follow-up verification repeated strict TypeScript, both eight-case discovery
  commands, 5/5 focused contracts (10.321 seconds) and the whitespace check.
  This still does not exercise edit completion or backend policy enforcement.
  Focus-ring contrast and actual native stale-editor behavior remain unverified.
- Pinned TDD, tests, mocking and review references were read from the exact
  upstream commit in AGENTS.md because its local reference directory was absent.

Initial source verification did not launch a browser or produce screenshots.
Initial service creation availability is a separate DOM-covered task and is not
sampled here.

## Native failure diagnosis and correction

The first published native run at `5b65a446f339fd39da0fd1d05fda71cb5f9d3413`
failed all eight policy sampler cases before recovery/editor stages. Source:
https://github.com/isning/RouteWeaver/actions/runs/43103831166/job/130801860654
Recovery artifact `13893322650` preserves the HTML report's original attachments.
The report records exactly one initial read per case, 6–27 failed reads and
17–73 preparatory Tabs, with no recovery/editor reads, rejected requests or page
errors. Final focus captures show Refresh visibly focused. Original desktop
service pixels show retained search and page-two rows; mobile group pixels do
not establish row visibility below the viewport. A separate shard3 attempt
exhausted 80 Tabs before reaching Refresh.

Source identifies a missing real-App boundary in the original sampler:
SessionBoundary revalidates on window focus/visibility return, and its private
workspace invalidates queries on reactivation. Forward-only Tab from the later
pagination control toward the earlier Refresh wrapped through browser chrome.
The recorded steps and request counts corroborate this mechanism, but the old
ledger did not record authentication reads or each focus transition, so it cannot
attribute every request to an individual session event. This is not evidence
that a held retry's duplicate prevention failed; that stage was never reached.

The corrected sampler uses natural directional traversal, arms failure after
Refresh owns focus, retains exact two-failure/one-held-recovery assertions and
adds unchanged-auth-read assertions plus numeric read counters and sanitized
traversal direction/path evidence. No focus scripting, session bypass, sleeps,
retry tolerances or timeout extensions are added. Product code is unchanged.

The previously unexecuted offline activation segment was invalid for real App:
SessionBoundary intentionally conceals and makes the private workspace inert
when offline. It is removed, not bypassed. Query-level offline refresh behavior
remains covered by the existing DOM tests; private-workspace offline concealment
belongs to the separate existing session recovery tests. These eight native
cases now claim only online failure/pending recovery and editor focus ownership.

Actual Playwright output names truncate the filename to
`admin-policy-inventory-rec-<hash>-...`. The original full-filename artifact globs
missed these directories; report attachments retained the evidence. Corrected
named-file globs use the observed truncated prefix. Contract positives use all
eight real shard3 directory names; negative private/arbitrary-file checks remain,
and the removed offline phase is explicitly excluded.

Correction verification: strict standalone TypeScript and both eight-case
Playwright discovery commands pass. Focused workflow contracts pass 5/5
(10.534 seconds), and the whitespace check passes. Independent source review
found no blocking issue in the four-file correction; strict count/auth assertions
remain intentionally capable of surfacing unexpected native activity. No corrected native run,
full-suite acceptance, local browser bypass or deployment is claimed here.
