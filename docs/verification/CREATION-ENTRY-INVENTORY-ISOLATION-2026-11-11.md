# Creation-entry inventory isolation

## Failure and cause

Native CI for `829a567` failed the creation-entry journey at both 1280px and
390px on the recovered `暂无订阅` assertion (then line 133). Both error-context
snapshots show two revoked subscriptions under missing-profile groups:
`consequence-mwcfps99` and `consequence-mwcfpv4u`. These are populated inventory,
not an unresolved read error.

`output-review-consequence.ui.spec.ts` creates `consequence-*` profiles and outputs.
Its cleanup revokes each output and deletes its profile; it does not delete the
output. The output listing in `internal/httpapi/outputs.go` includes every stored
output, including revoked outputs. `ui-session.ts` establishes the same synthetic
demo actor for domain journeys, while browser contexts remain separate. The
creation-entry route intercepted pending and failed GETs but passed recovered
GETs to that shared backend. Its empty-state assumption therefore depended on
which journeys had already run on the shard.

## Focused change

Keep both successful inventory GET responses synthetic as well: HTTP 200 with
JSON `[]`. Only the existing exact `/api/me/profiles` and `/api/me/outputs` routes
are affected. Non-GET requests still continue and the no-writes assertions remain.
Pending barriers, independent visible retry actions, draft preservation/discard,
stable creation button, focus, touch targets, empty state and overflow assertions
are unchanged. No backend records are deleted or hidden in production code.

## Verification and limits

- Official pinned TDD, tests and mocking references read via GitHub at
  `mattpocock/skills@49dd158d1076134a641b33efb035946536778336` (the documented local
  reference directory was absent).
- Focused TypeScript check passed: from `web`,
  `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --types node tests/creation-entry.ui.spec.ts`.
- Playwright discovery passed: `node node_modules/@playwright/test/cli.js test --project=chromium tests/creation-entry.ui.spec.ts --list` found both viewport journeys.
- Source diagnosis independently cross-checked against both retained CI error
  contexts, producer cleanup, session setup and the output-list HTTP handler.
- Native execution was not retried locally because of the existing browser
  sandbox denial. Discovery/typechecking are not a browser pass. Both viewport
  journeys still require native CI confirmation on the amended commit.
- No parallel full suite, publication or deployment was performed by this change.
