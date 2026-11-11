# Default shadcn tabs proposal, 2026-11-11

Request: “还有一个问题，tab栏都太大了，请你按默认的shadcn样式设计”.

## Provenance and scope

The installed preset is radix-nova (web/components.json). Restore web/src/components/ui/tabs.tsx from a9f1af5 exactly; SHA-256 b977274550595594055d850a16775c75761765e1cd76b4827e101c2f432762df matches the official CLI-generated file recorded in docs/design/SHADCN-MIGRATION.md. This is the installed preset's 32px horizontal list, calc(100% - 1px) triggers, px-1.5/py-0.5, not a newly invented size. No text or control semantics changes.

Remove oversized/wrapping overrides at every caller: Admin route mode, Infrastructure inventory/server detail/diagnostics, Profiles editor, Templates catalog, Notifications sections, ServerRoutes route mode, and platform settings navigation. These use the small ScrollableTabsList app composition, preserving default primitive appearance. Its native overflow container has 4px padding for focus rings and line indicator; lists remain one line at intrinsic width, with focused tabs revealed by scrollIntoView nearest. No height, hit-target enlargement, color, focus-ring, active-state or keyboard overrides are introduced. CollectionPreview keeps its existing ScrollArea, bounded-label tooltip, focus repair and explicit horizontal scrolling unchanged; its dimensions now inherit the compact primitive.

## Verification completed

Isolated tree created from git archive HEAD at /tmp/routeweaver-default-tabs-20261111; node_modules symlink points to installed dependencies. No production checkout files edited.

- In isolated web/: node node_modules/vitest/vitest.mjs run src/default-tabs.dom.test.tsx src/infrastructure-tabs.dom.test.tsx --maxWorkers=1. Passed 2 files, 10 tests.
- In isolated web/: node node_modules/typescript/bin/tsc -b. Passed.
- Shared checkout: git apply --check /tmp/routeweaver-default-tabs-20261111/evidence/default-tabs.patch. Passed (check only, not applied).

New DOM test checks ArrowRight skips disabled tab, active-panel relationship, Home and End, actual focus. Existing infrastructure coverage checks native tab/panel relationships, server opening, setup continuation, explicit multi-core choice, listener creation and stale selected-core clearing.

## Native acceptance prepared, not executed

Updated existing route-visual-gaps native settings acceptance at 1280/390 to assert 32px rail, 24–26px trigger and full focused target visibility, restoring original selected tab for screenshot. Only the prior tab >=44px assertion is superseded; password and task-action 44px checks remain.

Enhanced existing profile keyboard sequence at 320, 390, 768, 1024, 1280, 1366, 1440, 1536, 1920, 2304, 2560, 2880 and 3440 with default-size and full viewport visibility checks. Its previous actual hit-testing, sticky-header non-occlusion, selected-panel, draft and history invariants remain.

No browser run or rendered desktop/mobile inspection was attempted because parent reported known browser sandbox launch denial and required native CI acceptance. No bypass. Native dimensions, clipping, scroll behavior, screenshots and full regression acceptance remain unverified. Last native test assertion additions were not re-typechecked after parent requested stopping tests during serialized full suite.

## Integration

Patch includes 11 files. ServerRoutes changes are only tab component import and list tag/class replacement; coordinate with concurrent Sheet worker. No route editor redesign, network change, dependency install, deployment or publication.

## Integrated verification

Integrated with Sheet hierarchy commit `269ca7b`, preserving the relocated header
and its guarded tab handlers. Independent composed source review accepted every
list consumer and preserved draft/history/mounting behavior. The new UI wrapper
is outside the Go-only architecture classifier and imports only existing UI
utilities and React types.

Combined local run passed **106 tests across ten files** in 35.35 seconds, covering
keyboard tabs, infrastructure, mixed-path editing/workspace, settings/backup tab
continuity, policy copy/comparisons and mixed-route creation/hops. Production
TypeScript/Vite build passed. Integration caught and fixed a mismatched JSX tag
and unsupported RTL `exact` option in the new Sheet test before this passing run;
no assertion or timeout was relaxed. Full aggregate and actual native pixels are
separate outstanding acceptance, not implied by these results.

Strict targeted native TypeScript passed for the updated visual-gaps and Sheet
specifications. Sheet discovery lists three viewport cases (320/390/1440).
Discovery/typechecking do not execute a browser or establish rendered acceptance.

The first integrated full run returned **4,106 passes and one failure** across
332 files in 1,178.88 seconds. Its sole failure was the prior profile CSS contract
requiring auto-height/minimum44px wrapped tabs, which conflicts with the explicit
new default-shadcn request. That check now retains expandable-input assertions
and verifies compact tab height plus horizontal overflow instead. Native focus,
viewport and hit checks remain. This earlier run is not relabelled as a pass.

After the explicit default-style expectation correction and dark-mode integration,
the full local aggregate at `074dc7a` passed **4,108/4,108 tests across 333 files**
in 1,195.89 seconds. Earlier failed result remains recorded, not overwritten.
