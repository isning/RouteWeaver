# Forwarding path Sheet hierarchy

## Scope

Local UI candidate only. No deployment, live nodes, credentials, or remote source publication. This revision does not modify shared tabs styling.

React SPA, Tailwind v4, shadcn/Radix primitives and existing semantic light/dark tokens remain authoritative. Reviewed the repository content-design contract, pinned TDD skill and user-selected Refactoring UI reference (including its shadcn composition guidance).

## Changes

- The path orchestration has one bounded workspace, distinct from the route name and advanced configuration. View controls precede the content they control.
- Full-width node rows replace the separate numbered timeline gutter. Hop numbers sit beside names; server, protocol and port remain separate wrapping metadata. External proxy ownership and read-only explanations remain intact.
- Insertion occupies the full workspace width. The append action is a subordinate full-width outlined control, and node actions remain in their existing menus.
- The footer offers Cancel alongside the single primary Save draft action. Cancel uses the existing unsaved-change confirmation, with no additional persistence or application.
- Sequential editing uses the narrower Sheet size; graphical/policy editing keeps its larger work area. Existing semantic tokens, focus treatment and reduced-motion handling are preserved.

These are source-informed design decisions, not a claim of rendered visual acceptance.

## Verification

Passed on the final candidate:

- TypeScript `tsc -b`.
- Vite production build.
- 93 focused tests across `server-mixed-path-workspace.dom.test.tsx`, `server-mixed-path-editor.dom.test.tsx`, `server-path-workspace.dom.test.tsx`, and `server-path-model.test.ts`, with one worker.
- Added a component regression for footer cancellation: declining discard preserves the name and entire mixed path and makes no network request.
- Screenshot sampler build and browser test discovery: three cases at 1440, 390 and 320 pixels. The sampler imports the real editor with synthetic props, not a replica.

Blocked/unrun:

- Native browser tasks could not start because no Go compiler is installed in the selected environment.
- Chromium could not start: `process_singleton_posix.cc: socket() failed: Operation not permitted`. The same sandboxed Chromium launch failed after an approved escalation. Browser sandbox was not disabled.
- Consequently no desktop/mobile pixels or native browser interaction results were obtained. This remains a UI candidate pending rendered review. DOM tests do not establish layout quality.

## Resume visual review

From `web`, run:

`ROUTEWEAVER_CHROMIUM=/usr/bin/chromium node node_modules/@playwright/test/cli.js test --config=playwright.route-sheet.config.ts`

This test-only sampler has no backend dependency. It checks grouping, target sizes, viewport containment, expanding a node, and declining cancellation; it captures collapsed and expanded screenshots. It aborts any unexpected API requests. Review the produced images manually before visual acceptance.

For real HTTP persistence and end-to-end tasks, run the existing server-path and server-mixed-path browser suites with an official Go compiler and a usable sandboxed browser. Do not describe sampler acceptance as native backend acceptance.
