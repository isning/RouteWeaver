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
cached row remains available. Tab and Enter find and activate refresh; Space
activates the offline retry. Further Enter/Space during offline and held pending
reads must not duplicate requests. Reconnection resumes the held read.

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

Captures preserve the original viewport before geometry checks. Pending/offline
captures intentionally do not ask the globally busy page to settle. Settled
checks retain the existing task-surface helper unchanged. Refresh focus is checked
for visible keyboard focus, viewport containment and center-point obstruction.
Privacy-masked PNGs and focus/viewport JSON are retained only under explicit
`policy-inventory-*` phase filenames, plus the synthetic request ledger. Final
original-position evidence and ledger are attempted even after a journey fails.
The workflow contract tests include representative output directory coverage and
negative private/arbitrary-file checks; these are not observed browser artifacts.

## Verification and limits

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

No browser was launched, no screenshots were produced, and no native/pixel pass
or failing-before-passing native result is claimed. Supported native execution
remains deferred during the reported GitHub Actions outage. No local browser
bypass, full suite, publication or deployment was attempted. Initial service
creation availability is a separate DOM-covered task and is not sampled here.
