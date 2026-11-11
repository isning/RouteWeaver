# Independent user inventory and platform settings recovery

## Finding and bounded change

Admin inventory previously bundled `/state`, `/services`, `/settings` and `/published-routes` in one read. An unrelated settings read failure or delay hid otherwise healthy users and prevented the user-group section from mounting. The settings page likewise depended unnecessarily on inventory.

Platform settings now use their own query, enabled only for the settings page. User inventory no longer requests settings, and settings do not request inventory. Services/routes remain explicit composite prerequisites; they were not replaced with empty successful defaults. Existing settings cached-refresh notices and drafts remain intact. Both accepted-save and reconciliation paths cancel/update the exact settings cache, preserving ownership and late-read fences. Initial null, array or scalar responses produce an explicit read error instead of a blank workspace; this is object-shape validation, not a new field policy.

## Verification

- Public user/group regression failed before implementation and passed afterward.
- Five focused admin/settings files passed all 77 tests with one worker. Coverage includes accepted-write versus older-read ordering, newer dirty edits, reconciliation, cached-refresh draft preservation and initial retry. Four new cases cover user/group browsing without settings reads and malformed settings read/retry without inventory reads.
- App TypeScript and Vite build passed. Diff whitespace check passed.
- Independent source review found no blocking isolation, cache ownership, session or receipt regression.
- New native `admin-settings-isolation.ui.spec.ts` uses real App routing and loopback-only synthetic GET fixtures at 390 and 1440 pixels. It checks user/group availability with zero settings reads, then settings failure/retry with no additional inventory reads. Unexpected API operations and off-origin requests are rejected. Original screenshots and sanitized request-count ledger are attached to the HTML report.
- Native-spec strict TypeScript passed. Supplemental discovery: 36 cases across 12 files. Five workflow contract tests passed; required repository gates, Chrome sandbox/provenance, timeouts, retries and upload safety remain unchanged.

## Limits

Native execution and independent image review are pending publication. The fixture does not accept group editing, settings saving, receipt ordering, full accessibility or real backend/runtime behavior. Whole-suite local DOM evidence of 4,013 cases predates this and the route inventory change. Settings field-level malformed objects retain their previous handling. No deployment, real credential action or alternate publication attempt occurred; remote source writes remain blocked pending authorization.

Final local whole-suite recheck: application/test source `12d96c4` passed all 4,027 DOM tests across 324 files (one worker, 1,054.52 seconds), completed around 2026-11-11 11:25:39 UTC. This includes the route/settings isolation changes, corrected cross-page contracts and group identity fixes, superseding earlier local whole-suite limitations for those changes. Native execution and original-pixel acceptance of unpublished changes remain pending.

## Native locator correction after recovery run `da66409`

The native recovery job `130680919713` reached this test at both 390 and 1440 pixels, but failed at the first user assertion: exact text `协作测试用户` matched both the user-name button and the responsive row-action target span. The reported DOM and `Admin.tsx` identify the user-name button as the public user task control. The assertion now selects its exact button role/name rather than unscoped text. Visibility, request isolation, retry, screenshot and ledger assertions are unchanged; no timeout, retry or production behavior changed.

Validation for this correction: strict standalone TypeScript checking of the spec passed, and supplemental Playwright discovery found both viewport cases. `git diff --check` passed. Native execution was not repeated locally because browser execution is restricted; a new native CI run and independent original-image review remain required. This correction does not establish a native or visual pass, nor supersede the historical DOM evidence above.
