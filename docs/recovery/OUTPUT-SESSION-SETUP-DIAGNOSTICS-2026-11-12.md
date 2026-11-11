# Output recovery setup diagnostics

## Evidence and scope

For commit da66409, browser shard 4/4 (job 130680919903) failed both output-recovery journeys during explicit session recovery, before their Output fixtures or feature assertions. The failures took 890ms and 952ms, not the 18-second setup timeout. The supplied job 130680920593 was shard 3/4 instead.

Shard 4 was canceled before HTML reporter completion. Artifact 13875759308 retained error-context files but no HTML report or inline setup HTTP attachments. Therefore neither the HTTP status nor the failing normal-login versus cold-workspace phase can be established from that artifact. Accumulated login rate limiting remains a hypothesis, not a diagnosed product defect.

## Change

The test helpers now write named session-setup-*.json files before attaching them. Repeated phases receive distinct per-test sequence numbers. Both the normal-login page and the cold-workspace page record only auth operation, normalized GET/POST/other method, numeric status (null for a transport failure), phase and event count. Existing safe worker/setup and confirmation outcome/timing fields remain available. Listeners are removed before persistence. No request or response object, URL, headers, body, cookie, credential, error text or user data is serialized.

The existing browser-diagnostics artifact already includes web/test-results/, so this change does not broaden CI uploads. Files survive failure to complete the reporter after the diagnostic write finishes; abrupt termination before that write is not covered.

Session recovery stays terminal. No login retry, extra request, timeout extension, authentication mock, production authentication change or rate-limit change is introduced. Diagnostic write/attachment failures still fail setup, as attachment failures did before; successful file persistence does not convert setup failure into success.

## Verification

- Five focused unit contracts passed with one worker: allowlisted auth events and listener cleanup; persistence before attachment; repeated-stage file uniqueness; dropping extra input fields; persistence despite attachment failure; normal-login and cold-workspace terminal failure without retry.
- Strict standalone TypeScript checking passed for the three helpers and two dedicated contract files.
- Playwright discovery found both output-recovery tests and all six ui-setup-contract tests (eight total), without launching a browser.
- Browser execution and broad suites were deliberately not run while the coordinator's full suite remained active. This diagnostic-only change does not establish that either original journey now passes.
- Parent reviewed the helper diff before the scoped commit. The next native run must supply phase/status evidence before choosing a substantive fix.
