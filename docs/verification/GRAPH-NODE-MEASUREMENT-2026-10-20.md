# Graph nodes remain measured and visible

Actual cloud Chrome review with two configured endpoints showed an empty graph. Rendered node DOM contained both labels and nonzero dimensions, but every node retained inline visibility:hidden. The controlled onNodesChange callback discarded dimension changes and recreated only a position map; rebuilding node objects then lost React Flow's measured state.

The graph now uses the installed library's useNodesState/change reducer rather than a partial custom reducer. A small view-model module refreshes endpoint/path labels while retaining per-ID geometry and measured UI state. Stable path dependencies prevent state-feedback loops. Layout stays in editor memory, separate from routing IR, and survives switching to ordered editing and back.

Red: a route editor integration test delivering the library's public dimensions change event expected measured geometry and received undefined. Green: measurement, drag position, path selection/linking, draft name change, view switching and save payload checks pass; geometry does not enter routing intent. The controlled React Flow boundary is mocked for deterministic change-event testing, so this is not a substitute for rendered browser confirmation. Relevant graph/endpoint/TLS/validation/public-route DOM tests passed 34/34; typecheck/diff checks passed. Post-change full suite and actual drag-to-connect verification remain integration work. No independent post-implementation review is claimed.

## Integrated browser confirmation

At main commit 0196a40, cloud Chrome displayed both synthetic FRA and UK endpoint nodes. Selected FRA as entry, physically dragged its right connector to UK's left connector, and observed the directed edge and both hop summaries. Moved the UK node, switched to ordered editing (FRA:1080 then UK:2443), then back: the moved layout and route remained. Saving created a two-hop draft. Validation correctly reported the fixture's missing entry TLS certificate rather than offering application. No Agent or VPS was connected and this does not establish network traffic success.

The serialized complete frontend suite passed 244 tests across 28 files (148.73 seconds); production build passed. Log: /tmp/graph-integrated-ui.log. Earlier pending-browser/full-suite wording above describes the pre-integration checkpoint and is superseded by this section.
