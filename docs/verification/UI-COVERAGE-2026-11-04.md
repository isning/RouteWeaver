# Additional visual-state evidence

This patch adds screenshot capture points and semantic assertions, not a claim
that these views have passed visual review. The browser tests must run in CI,
then the resulting pixels must be reviewed. Local Chromium was not run.

## Evidence boundaries

- `action-matrix-targets.ui.spec.ts`: initial core-instance inventory at 320,
  390 and 1440px, before the existing action-edge checks. API-boundary synthetic
  inventory; no runtime health or application is claimed.
- `template-follow-backend.ui.spec.ts`: My References list at 390 and 1440px
  before the existing conflict/review/apply journey. Real isolated backend and
  synthetic accounts, retaining existing persistence and publication assertions.
- `session-recovery.ui.spec.ts`: blank invitation registration screen during
  the existing real identity-switch journey. Invitation input masked; capture
  precedes account/password entry. No URL, credential or token attachment.
- `notification-readability.ui.spec.ts`: reminders, expanded disabled external
  channels, failed delivery, and list loading → read error → explicit retry →
  recovered announcements at 390 and 1440px. Strict loopback, read-only API
  fixtures reject unexpected writes/external requests. These captures prove
  rendering and recovery affordances only, not SMTP/Webhook delivery or backend
  persistence. Loading is held by a deterministic request gate, not latency.

This bounded addition does not cover every list's loading/error state, invitation
expiry/failure, all server subpages, or real external notification delivery.

## Local checks

- Application TypeScript check passed.
- Explicit TypeScript check including all four changed browser specs passed.
- Playwright discovery parsed 39 tests in the four files; no browser launched.
- Notification read-state and channel-draft DOM suites: 2 files, 15 tests passed,
  one worker.
- Browser execution and screenshot inspection: pending CI.

## Route-override security regression

The announcement gate matches the exact configured loopback origin and path,
not a host wildcard. A dedicated browser negative case attempts a synthetic
cross-origin request with the same pathname and requires the outer fixture to
abort it before network transmission, record the external request, and leave
the local override's read count unchanged. This case is type-checked and
successfully discovered locally; execution remains pending CI.
