# Console workspace width pass

Scope: shared console geometry, not live deployment readiness. The supplied Cloudflare reference was inspected for hierarchy and available-space centering; its account information was not copied.

- Desktop navigation is 256 px. At 1023 px and below, retain the existing accessible navigation drawer.
- Ordinary list tasks center at up to 1152 px; broad fleet/routing workspaces at 1280 px. Settings tasks cap at 832 px.
- WorkspaceFrame keeps the context pane separate from the centered content. Navigation panes are 224 px and open at 896 px of frame width; data panes are 320 px and open at 992 px. At 1440 px both are available beside the primary task. Below the budget, navigation precedes the task and data follows it.
- ContextLayout uses the same pane widths and caps its primary task independently. Its existing 24 px outer/gap treatment remains for embedded editor layouts.
- The route host and workspace subtree are stable across subscription aliases. No data owner, route boundary key, scroll root or mutation lifecycle was changed.
- Account-security and subscription-alias page skeletons use their corresponding context/workspace structures instead of an unrelated full-width form.

Verification: TypeScript and the focused workspace/account/navigation/context DOM suites, production build, and separate browser-spec TypeScript check were run locally. Browser geometry and screenshots are acceptance assertions, not observed local results: local Chromium was not run because of the existing environment restriction. The coordinator must execute the matrix in authorized CI and review its actual screenshots before declaring visual acceptance.

The browser matrix covers 13 widths from 320 to 3440 for workspace/context pages and a further 7 ordinary routes at 320/768/1440/1920/3440. It measures content centering, caps, pane/left-nav sizing, overflow, header alignment, expanded tasks, breakpoint transitions, loading transitions, and navigation/editor continuity. Width policies cover all registered routes in a DOM suite; that does not substitute for every page's browser task coverage.

Independent review caught a nested-layout regression: capping the entire contained backup view at 832 px prevented its 896 px context breakpoint from ever opening. Backup now explicitly declares its nested context; only its internal primary is capped, and the outer header uses the same context grid for alignment. The same canvas/owner remains mounted. A failing-before-passing DOM regression and 13-width real-page browser assertions cover the uncapped backup canvas, 832 px primary, matched header axis, and 224 px side directory at desktop widths. These browser assertions still await CI execution.
