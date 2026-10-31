# Visible DOM fixture wave scope

## Narrow scoped change

The ownership investigation in [Source-editor fixture wave ownership](SOURCE-FIXTURE-WAVE-OWNERSHIP-2026-10-24.md) established that an AntD wave can create an independently owned React root and native deadline outside RTL parent cleanup even when the fixture disables theme motion.

Six more fixtures share the relevant configuration: `theme.token.motion:false`, a visible `offsetParent` shim for real focus tasks, and no disabled-wave option. The change adds only `wave={{ disabled: true }}` to one existing ConfigProvider in each file:

- `web/src/collection-source-task.dom.test.tsx`
- `web/src/existing-source-selection.dom.test.tsx`
- `web/src/profile-source-task.dom.test.tsx`
- `web/src/source-controls.dom.test.tsx`
- `web/src/source-import-task.dom.test.tsx`
- `web/src/ux-recovery.dom.test.tsx`

These are **potential exposures identified from source**, not six newly reproduced defects. The change uses the same documented decorative-wave API as the confirmed fixture correction. It does not change production waves or production motion.

All existing events, focus/visibility assertions, task assertions, cleanup, native budgets and owner-replacement behavior are retained. In particular, SourceImportTask's StrictMode wrapper remains intact. Each provider wraps AntD App within the fixture; no production application provider or generic shared harness needs modification. No inspected case asserts wave visuals or wave completion events.

## Deliberate exclusion

`server-validation.dom.test.tsx` has a narrowly targeted `getClientRects` override for a recovery button. Installed AntD visibility support reads `offsetParent`, `getBBox`, or `getBoundingClientRect`, not `getClientRects`; this override does not establish the same activation mechanism. That file is excluded rather than expanding the change to every test that disables motion.

## Verification state and ordering

The original six-file inventory was verified after the CPU baseline completed: **49/49 passed** (16 collection-source-task, 13 existing-source-selection, 4 profile-source-task, 3 source-controls, 7 source-import-task, 6 ux-recovery). Typecheck passed. The six-file invocation used one worker, retries disabled, and unchanged native budgets; it exited 0 with no unhandled errors. Nonfatal existing Modal deprecation and jsdom scrollTo diagnostics were retained rather than suppressed.

An initial formatting preflight stopped before typecheck/tests because whole-file formatting removed an unrelated optional trailing comma. That failed attempt was retained. The corrected attempt retained only formatted provider opening tags and restored every other byte from the reviewed candidates, then passed the exact-delta guard and ran the previously unexecuted stages once. Canonical content/modes and the dependency link were unchanged throughout; private compiler build metadata was the only post-freeze difference. This is focused verification, not a full aggregate pass.

The original collection-source-task worker CPU profile captured its wave-enabled canonical baseline before this extension was verified. The fixture change is not evidence of a CPU-timeout fix. Full aggregate verification and attribution of historical window errors remain separate open work.
