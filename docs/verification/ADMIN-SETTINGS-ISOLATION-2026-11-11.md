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
