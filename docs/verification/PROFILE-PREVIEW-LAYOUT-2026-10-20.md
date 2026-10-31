# Full-editor workspace and on-demand preview

Actual browser review at 1196px showed a fixed 295px sidebar consuming much of the usable editor width. It repeated counts, an explanatory pipeline diagram and a second preview button while showing no generated configuration. Four simple rules consequently required excessive vertical scrolling.

The editor now uses its available width for editing. The existing top-level Preview action opens generated configuration or validation diagnostics in a 720px responsive drawer. Closing it preserves the current unsaved draft. The redundant explanatory sidebar and its unused CSS are removed; generation, revision fencing and saving semantics are unchanged.

Red: the old always-visible preview sidebar failed the initial absence assertion. Green: requested valid/invalid preview opens in its named dialog, preserves diagnostics and retains edited values on close. Focused preview, task experience and basic-routing tests passed 33/33; typecheck and diff check passed. Tests use production-style unique React IDs because Ant's test-only constant IDs mislabel multiple drawers. Full-suite and actual-browser post-change checks remain integration work.
