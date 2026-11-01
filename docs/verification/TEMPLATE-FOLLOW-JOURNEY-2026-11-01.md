# Template follow → selected subscription publication

## Scope

M01 / RW-20 public HTTP and browser task seams, using the existing ephemeral
loopback demo control plane and individually invited synthetic owners. No real
credentials, nodes, deployment, external subscription fetches, or API response
fulfillment. Existing copy/pin/follow semantics are unchanged.

The new fixture publishes a template, selects follow mode for a private profile,
and creates two published outputs of that **same** profile. Personal group-name
and listener-port overrides compete with upstream changes, while upstream adds
a reject rule. Existing conflict precedence preserves the personal overrides.

## Checks

- `web/tests/template-follow-backend.api.spec.ts`: **2/2 passed locally**, one
  each for mihomo 1.19.32 and sing-box 1.14.3. A real edit after inspection makes
  the old review digest fail with HTTP 409, without changing the saved draft or
  either published feed. Fresh inspection/apply preserves personal overrides.
  The actual output renderer/semantic preview is valid; publishing its digest
  changes only the selected output. Sibling feed bytes remain exactly unchanged.
  Selected preview/feed comparison normalizes only terminal whitespace because
  the preview omits the HTTP renderer feed's terminal newline.
- `web/tests/template-follow-backend.ui.spec.ts`: desktop 1440px and mobile 390px
  **implemented and discovered, not executed locally**. Joins visible template
  review, preservation labels, Close without mutation, actual concurrent-edit
  409/error UI, fresh review/apply, output validation, Cancel without publication,
  explicit selected publication and reload. All flow responses use the real
  backend, without fulfilled mocks. Screenshots are requested at output review.
- App `npm run typecheck`: **passed**.
- Explicit strict standalone TypeScript check of the three new test/helper
  files: **passed** (the app tsconfig excludes browser tests).
- Existing `template-update-review.dom.test.tsx`: **10/10 passed**, one worker.
- `git diff --check`: **passed**.

The initial API run failed only at preview/feed trailing-newline equality after
both publications succeeded. Correcting that test expectation yielded 2/2;
this is not a product red/green bug fix. No production source was changed.

## Evidence boundary

The browser/API checks use real product renderer validation, **not a native
parser check**, process startup, traffic, or applied-device claim. Native parser
coverage remains the separate existing
`TestNativeTemplateFollowedProfileUpdate` (both clients when their pinned native
binaries are supplied). That native test was not run in this local work session.
Local Chromium and sing-box execution were explicitly excluded. The coordinator
owns exact-combined-commit CI/browser execution and its budget. These additions
do not by themselves mark RW-20/M01 or production readiness verified.
