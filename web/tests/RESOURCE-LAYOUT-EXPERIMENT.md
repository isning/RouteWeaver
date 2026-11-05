# Isolated resource failure layout comparison

Baseline product commit: `0a1280661bd4548d7b711e86e9e9f3defe163791`.
Corresponding CI61 publication: `9fa3ffa283ab30d29a433ab101b4793ec73db87c`,
tree `004f87b2f5d2d5002b5b67cef99ae70c4f56f500`.

This experiment is not a product change or part of the default quality gate.
The explicit Vite configuration selects either the unmodified production
Resources page or a diagnostic copy. The first all-width candidate passed its
interaction cases but was rejected after it introduced 29px of horizontal
overflow at ordinary 1280px desktop width. The current candidate uses the
existing mobile hook (<768px): only there does it move the single static refresh
failure sentence into the recovery-action group, remove the short repeated
badge, and give failed groups a stable 20rem width capped by the existing
viewport-minus-2rem maximum. Desktop keeps the original paragraph location,
action width, and overflow reminder. All request, authorization, mutation,
confirmation, and failure-recovery logic remains the same. No whole-table mask,
edge fade, column snapping, or automatic scroll-position rewrite is added.

## Commands

From `web`, with the existing locked dependencies and CI Chromium installed:

```sh
npx tsc -p tsconfig.resource-layout-experiment.json
node node_modules/playwright/cli.js test --config=playwright.resource-layout-experiment.config.ts
```

The configuration runs six long-name stress cases against baseline and proposal
projects at 1280, 1440, and 390 pixels. Four additional ordinary short-name cases
at 1280 and 1440 isolate desktop row-height and overflow tradeoffs that a long
name could otherwise hide. Two breakpoint journeys retain focused recovery
actions through 767→768→769→767 and verify one full reason with unique description
IDs after every resize. The 390→1440→390 journeys remain. There are 12 cases.
It starts only two loopback Vite servers,
not a backend. The spec intercepts all API requests and rejects unknown or
external requests. Failure and retry interactions operate on intercepted data
only. Screenshot and measurement output goes to `bin/verification/resource-layout-*`.

## Decision criteria

- Inspect actual screenshots and numeric row-height, group-width, and table
  overflow measurements. DOM class names cannot establish geometry.
- The proposal must show the full static failure reason, record identity, and
  recovery controls together when either action is keyboard-focused.
- A long record name must wrap without widening the bounded action group.
- Preserve one live request error, ordinary non-live persisted status, exact
  accessible descriptions, cancel focus return, and successful retry cleanup.
- Healthy resources must not acquire a failure description.
- Do not accept the proposal solely because tests pass. Check whether desktop
  row height or earlier horizontal scrolling is a worse tradeoff. Keep the
  baseline if superiority is unclear.

The persisted consequence is fixed product copy, not arbitrary API error text.
API failures remain in the existing confirmation/global ErrorNotice. This
experiment cannot establish live-node behavior, backend persistence, or full
page/state/device coverage.
