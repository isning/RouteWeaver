# Dark appearance activation and shared surfaces

## Source findings and changes

- Production had dark semantic tokens but no theme provider or root-class activation. Synthetic samplers toggled the class themselves, so their dark checks did not establish actual application support.
- The root UIProviders now owns a next-themes class provider: default system preference, explicit light/dark choice, persisted under `routeweaver-theme`. Nested workspaces inherit it rather than creating conflicting owners. Native controls receive the resolved browser color scheme. The sidebar exposes an accessible, labeled appearance choice.
- Existing body, card, popover, sidebar, muted, input, border, foreground and focus tokens already cover standard shadcn surfaces. Their established neutral palette is retained; this patch does not redesign tabs or route sheets.
- React Flow defaults were independently light: canvas, nodes, buttons, handles and labels now use workspace semantic tokens. Legacy Admin graph borders and paths use primary/border rather than fixed green/light values.
- White QR-code surfaces are intentional scanner contrast, not missed dark-mode conversions. The MFA QR container explicitly retains black text. ServerRoutes graph constants are coordinated with the separate route-sheet change rather than edited concurrently here.

## Verification

- Functional red/green: before the provider existed, selecting dark failed to activate the root class; after the fix, preference persistence, remount, nested providers and explicit/system selection pass.
- Passed: production TypeScript/build and 15 focused DOM tests (theme + task overlays); diff whitespace check.
- Added native tests at 1280px and 390px: real provider responds to OS preference changes, explicit choice survives reload, browser native color scheme, graph node/card matching, notification theme and overflow.
- Native tests did not execute: Chromium launch aborts on this host with `socket() failed: Operation not permitted`, including an approved elevated attempt. No browser security setting was weakened. Run `cd web && ROUTEWEAVER_CHROMIUM=/path/to/chromium npx playwright test --config=playwright.theme.config.ts --workers=1` on a supported native runner.
- Actual rendered full-page contrast, visual hierarchy, graph interaction and screenshots remain unverified here. This is a bounded source audit plus functional checks, not a claim that every product state has passed native dark-mode review. Coordinator owns final aggregate/integrated verification.
