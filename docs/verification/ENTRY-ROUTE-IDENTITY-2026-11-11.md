# Authorized entry route identity

## Finding and change

The platform-entry editor offered permitted routes using their display names alone. Two authorized routes named alike were indistinguishable in the option list and collapsed selection despite different raw route IDs. The editor now shows secondary route-ID metadata for duplicated names and literal identity-caption lookalikes. Authorization filtering happens before metadata construction, so a forbidden sibling neither appears nor changes an otherwise unique authorized label. Submitted route IDs, credential fields, reveal behavior and stale-policy guards are unchanged.

## Verification

- Public UI regression failed before implementation, then passed with the fix.
- All 33 related user-entry tests passed, including permission error/deny-all/stale-selection cases, duplicate and literal-caption labels, stable-ID search, selected identity, forbidden-option exclusion and raw-ID submission through synthetic transport.
- App TypeScript/Vite build and native-spec strict TypeScript passed. Independent source review found no blocking authorization, identity, credential or test-seam issue.
- The new native fixture uses the real App at 390 and 1440 pixels with exact synthetic loopback GETs. It checks three permitted options, excludes the fourth forbidden route, searches by ID, selects the intended route, and attaches original option/selected-state screenshots plus a sanitized ledger. No API mutation is allowed. Independent source review accepted fixture and supplemental wiring; runtime/pixels remain pending.
- Supplemental recovery discovery is 38 cases across 13 files. Five workflow contract tests pass; required discovery, sandbox provenance, workers, retries, timeouts and report retention are unchanged.

## Limits

This change has not yet run natively or received independent pixel review. The browser fixture is read-only and does not establish credential saving/delivery, backend enforcement or full accessibility. The latest 4,027-test whole DOM pass was at source `12d96c4`, before this entry-choice change. Publication remains blocked awaiting authorization; no workaround, deployment or real credential operation occurred.

## Final integrated DOM pass

On 2026-11-11 at approximately 11:55 UTC, the complete serialized web suite at source `f497893` passed all **4,030 tests across 324 files** in 1,072.41 seconds. This includes both the entry-route identity and subsequent route-account literal-caption changes. This supersedes the older 4,027-test scope above; it does not establish native browser or pixel acceptance.
