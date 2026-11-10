# Browser contract reconciliation

Baseline: `f34eff0bbea039f0460014fa3e0b13df743f64ec`.

Repository quality run [42868189009](https://github.com/isning/RouteWeaver/actions/runs/42868189009) failed in browser shards 3/4 and 4/4. The other fifteen jobs succeeded; the required aggregate failed correctly. Four tests failed: three searched for a deliberately removed duplicate source-processing heading, and the group-membership journey expected the former combined connection summary despite selecting a platform entry.

## Correction

- Locate source and merged processing using the exact, existing accessible group names. The source disclosure keeps its purpose and step count without restoring the duplicate heading.
- Assert own connections and platform entries independently: initially two own connections plus one platform entry, then one processed collection connection plus that same platform entry.
- Preserve all processing, ordering, cancellation, persistence, narrow-layout and rendered-member checks. No interaction timeout, product behavior or CI gate is changed.

## Verification

- Application TypeScript passes.
- Explicit strict TypeScript check of all four changed browser files passes with their Node types.
- Playwright discovers all 23 cases across the four files.
- Four neighboring DOM files pass 43 tests: collection source tasks, collection preview layout, group membership and source task layout.
- `scripts/verify.sh static` passes, including all 102 offline helper tests, architecture guards and pinned actionlint.
- Independent source review found no blocker and confirmed the exact groups and separated counts against production code.
- Local attempt to run the four formerly failing browser journeys did not execute product interactions. Sandboxed Chromium startup was rejected by the host at `socket()` with `Operation not permitted`; no sandbox or host restriction was changed. Corrected browser behavior and the full gate remain subject to the new exact-commit CI result.

This is a focused test-contract correction, not an all-page UI or full-suite acceptance claim.
