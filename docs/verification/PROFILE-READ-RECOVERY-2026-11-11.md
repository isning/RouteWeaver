# Cached profile identity during a failed refresh

## Finding and change

A failed profile-list refresh discarded all cached profiles from subscription-list presentation. Unpublished saved profiles disappeared, and existing linked subscriptions were labelled as having unavailable profiles even though the read failure had not established absence. This could occur immediately after saving a profile and returning to the subscription list.

Previously loaded profile identities now remain visible with the existing read-error notice explaining that last-read data is shown. New/update publication entry remains gated on a successful completed profile read. Editing still requires the independent current `/reveal` read and never falls back to cached editable content. Successful authoritative empty results still remove genuinely missing profiles. Frozen output access retains its independent policy.

## Verification

Four public DOM regressions failed before the change and pass afterward. They cover saved-draft return, failed/successful independent reveal, search and both pagination levels, retained scope during failure, and successful authoritative empty recovery. All 92 affected tests across seven files pass, including creation-readiness/session, relational/workspace, return and loading states. Production TypeScript/Vite build passes.

Independent source review accepted the fix after identifying and remediating silent disabled-action states during cached paused/slow refresh. Two additional regressions separately failed before the existing wait/checking feedback was extended to those states, then passed; the recovery file now contains six passing cases. The final related run includes 119 passing tests across ten files (including receipt/module-loading tests), and the production build passes again. This is functional DOM evidence, not native browser or pixel acceptance. No real profile writes, external publication or deployment were performed. Remote publication remains awaiting authorization.

## Native fixture preparation

The real-App loopback fixture covers synthetic save, failed list refresh, return with retained draft/linked identities, keyboard access to retry and frozen output access, and successful explicit reconciliation at 390 and 1440 pixels. The single synthetic PUT is checked against exact JSON, revision and synthetic CSRF values and fulfilled locally. Unexpected/off-origin HTTP requests are blocked; this HTTP interception does not assert WebSocket coverage. Current-viewport masked screenshots and sanitized geometry/request ledgers are attached independently, including on failures.

Strict native TypeScript passes. Supplemental discovery is 44 cases across 16 files and all five workflow contracts pass; required browser launch, sandbox, timeouts and retry settings remain unchanged. Independent source review accepted payload, exact paths, selectors, keyboard traversal and evidence after narrowing the HTTP interception wording. Native execution and pixel acceptance remain unperformed.
