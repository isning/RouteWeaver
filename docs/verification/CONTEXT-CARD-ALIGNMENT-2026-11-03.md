# Context-card alignment follow-up

Base: `eddb9bd19c71f1440ba3d93440d0f90a47e0e38c`, tree `a3bd06ee5b4b0dac046593758ba627dbbda2aa4f`.

CI13 run `41582547062`, remote `fb6cd7ab41683ed510e499a08c781a60f273a1e8`, supplied 30 actual context screenshots: settings, backup, account security, subscriptions, expanded usage and profile at 320/390/1024/1280/1440. Source review alone had missed two layout defects:

- At 1440 the subscription-domain card's old outer width cap ended before the platform-information card. Remove that outer cap; retain bounded explanatory paragraphs.
- Administrator MFA was outside the account page's context composition. Its card was narrower at 1440 and wider than the primary column at 1280, and the directory omitted it. Keep the existing lazy import and administrator/not-required-password gate in App, but supply the same task once to the primary column. Give it an instance-specific focus target and directory item. Existing password/code form widths, security mutations and secrets are unchanged.

The MFA slot has a local existing PageBoundary and Suspense so a pending or failed supplementary chunk cannot replace the password task or lose its draft. Directory movement does not remount the MFA form, alter workspace history or submit security writes.

## Verification

- The real App forced-password journey first failed on the absent MFA region, then passed with its actual form reachable by keyboard. It also verifies a retained MFA input/draft across directory movement, unchanged history and no added requests. Ordinary and forced-password accounts have no MFA directory entry.
- Removing only the local MFA loading/error isolation reproduced two failing tests. Restoring it passed both pending-to-loaded and pending-to-failed cases with the original password draft/input intact.
- Final single-worker DOM run: four files, 30 tests passed (`context-navigation`, `guest-required-password`, `account-security`, `subscription-origin`).
- Application and changed browser-spec TypeScript checks passed. The forced-password test's formerly ambiguous recovery text query now addresses the exact heading/region; authorization, rotation and API assertions remain.
- Browser coverage now compares both card edges and captures viewport images after settled focus/current-marker assertions. Full-page captures remain for composition only: their scroll/viewport effects are not interaction evidence.

No local browser was launched. New geometry assertions and post-fix pixels await CI. The CI13 native 502 failure is separately investigated; this change does not certify aggregate CI, hosted speed or user acceptance. Root owns final aggregate tests/build and publication.
