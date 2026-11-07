# Collection preview selection reconstruction

Source reconstruction from integration base `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`. Missing historical objects `8159df2` / `ecbde0b` were not recovered or executed. This is a new implementation of the assigned v94/v95 behavior, not an exact restoration.

## Scope

CollectionPreview uses collection, stage scope, source ID and step ID as the stable stage identity rather than array position or current translated label. Legacy stages without scope use their stage/name field. Canonical backend stage tuples are expected to be unique; indistinguishable malformed duplicate tuples are not assigned invented index identities.

A selected stage that survives refresh or reordering stays selected. A missing selected stage immediately displays final results and clears the stored selection, so reappearing stages cannot resurrect an old choice. A detaching tab ref captures actual DOM focus ownership. Only removal of that focused tab can move focus to final results, using preventScroll and nearest-edge scrolling; outside editor focus is left alone.

Sources.tsx and Pipeline.tsx are unchanged, preserving existing raw-port draft, source-subtask and request ownership reconstruction.

## Public regression sources

`web/src/collection-preview-layout.dom.test.tsx` covers same-step-ID stages from different sources, reorder, source rename, removal before the selected stage, selected focused removal, empty stages, no selection resurrection, editor focus preservation and nearest scrolling. Existing layout, keyboard traversal, comparison delta tests remain intact. These are public rendered component/DOM seams authorized in the assignment, with browser scrolling represented by a boundary spy.

## Evidence and limits

Git diff whitespace inspection and source review only. All new and existing DOM tests, TypeScript, lint, builds, browser behavior, actual scrolling, rendered layout and accessibility execution are **UNRUN** under the explicit no Node/npm/Go/browser/server/install/network restriction. No red/green result, full-gate pass, historical equivalence or shipping readiness is claimed. No upload, save, push or deployment was performed. Runtime validation and independent review remain required.
