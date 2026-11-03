# Subscription inventory grouping: bounded performance correction

## Finding and change

On base `a08ec44666628630decd152e9ea344f0fdd0afee`, the default subscription page scanned every output for each profile, scanned profiles again to identify orphan outputs, and rescanned orphan outputs for each orphan group. This happened before ten-group pagination and on subsequent renders/search changes. The profile/output relation alone therefore incurred repeated `P × O` work; pagination did not bound it.

`groupSubscriptionInventory` now builds one output index and one profile-ID set, then emits groups in the existing order. Relation indexing is `O(P + O)`; search still inspects relevant links, and deliberately preserved duplicate profile rows may revisit their matching lists. There is no new memoization or cache. This removes unnecessary CPU work, especially for large inventories; it is not evidence that the user's hosted page now loads quickly.

Preserved behavior: profile order, per-group output order, first-seen orphan order, duplicate profile rows, original object identities, scoped empty groups, case-insensitive trimmed search, profile-name matches, full totals versus filtered visible links, pagination and remembered selection. Existing query, authentication, task, draft, cancel and refresh code is unchanged. The returned lists are only read by the page.

## Fresh verification

- 4 pure grouping tests: explicit examples, 3,240 old/new equivalence combinations, and a deterministic key-access check. With 100 profiles/1,000 outputs the old implementation reads the output grouping key over 100,000 times; the new helper reads it exactly 1,000 times. This is an operation-count regression guard, not a timing SLA.
- 88/88 focused tests across 6 files passed (one worker), including workspace return, search/filter/page handling, selected profile, creation, overview and error recovery behavior. The old implementation is retained only in the test and benchmark as an independent pre-change comparison; no old pass is reused as new evidence.
- Application typecheck, production build with manifest, and whitespace check passed.
- No local browser, full suite, native process test, deployment or hosted timing was run for this change. The coordinator owns exact integrated-head CI.

Commands from repository root:

```sh
npm --prefix web test -- --maxWorkers=1 src/subscription-inventory.test.ts src/subscription-workspace.dom.test.tsx src/workspace-return.dom.test.tsx src/subscription-overview-status.dom.test.tsx src/creation-entry.dom.test.tsx src/ux-recovery.dom.test.tsx
npm --prefix web run typecheck
npm --prefix web run build -- --manifest
node web/scripts/measure-bundle.mjs web/dist
node web/scripts/measure-subscription-grouping.mjs
```

## Synthetic grouping measurements

Node v24.22.1, local synthetic arrays, no search, 5 warmups and 15 old/new sample pairs per size. Equality is checked before timing. The recorded run was repeated after other local validation processes finished; runtime remains environment- and data-dependent. No absolute acceptance threshold is used. Raw results are in `qa/subscription-grouping-20261103/node-grouping.json`.

| Profiles / outputs | Old median | Indexed median |
| --- | ---: | ---: |
| 10 / 50 | 0.0189 ms | 0.0135 ms |
| 200 / 2,000 | 4.4789 ms | 0.1967 ms |
| 1,000 / 10,000 | 140.5431 ms | 0.8570 ms |

These numbers exclude React rendering, DOM, network, auth, module startup and hosted latency. They cannot establish user-visible speedups; small inventories have very little grouping cost to remove.

## Production bytes: no reduction claimed

The committed before/after manifest-closure artifacts count actual built JS files using Node's per-file `gzipSync` defaults. They include the shell plus static route imports, not dynamic imports, fonts or runtime requests. Baseline is the production source at `a08ec44` (identical to CBC production source); after is this isolated grouping branch, **not** the later integrated layout aggregate.

| Static JS closure | Before raw / gzip bytes | After raw / gzip bytes |
| --- | ---: | ---: |
| Shell | 591,732 / 187,626 | 591,732 / 187,621 |
| Subscriptions | 747,257 / 238,579 | 747,310 / 238,622 |
| Profiles | 947,153 / 300,983 | 947,206 / 301,022 |

The default route adds 53 raw / 43 gzip bytes. Tiny shell compressed differences follow generated asset references, not removed work. The earlier shell reduction does not establish reduced default-route transfer: its full closure was still larger than accepted baseline before this change.

## Remaining default-route diagnosis (source/build evidence)

- `/api/auth/me` is the necessary authorization boundary. Once the page mounts, overview, outputs and profiles queries are independent, not a chained data waterfall. This audit does not remove that private-data boundary or add speculative prefetch.
- Per-output comparisons are disabled until an explicit action, not an automatic initial N+1 query. Profile effective-input preview intentionally waits for authoritative recipe/catalog state.
- QR and graph engines are already deferred. A concrete remaining byte candidate is the publication/review UI retained in `Subscriptions.tsx` even during inventory viewing. Its chunk is 76,895 raw / 22,980 gzip bytes **including the inventory itself**, not all removable bytes. The shared `RoutingSummary` chunk is 17,947 / 4,500 bytes and is used only in selected detail/review contexts on this route.
- The 33,453-byte raw `choice-select` chunk is not a removable widget cost: retained module metadata includes required TanStack query machinery as well as command/popover UI. Names alone do not identify optional dependencies. Module `renderedLength` was used only for attribution, not as gzip cost.
- Login itself requires shared forms; extracting publication forms does not remove all shell form code. Geist is self-hosted with swap/subset CSS; no external font/CDN dependency is proposed.

**Recommendation:** do not broaden this safe grouping patch into a blind lazy split. A later publication/review extraction is worth a separately bounded change only if its import failure preserves the modal, Close/focus, drafts, authoritative freshness and all evidence required before confirmation. Then measure its actual production closure and execute interrupted-load tests. Do not defer required comparison evidence while leaving confirmation enabled.

## How to measure the unresolved hosted complaint

For application startup, the existing authorized CI browser environment can serve **built production assets** with the demo API, a fresh context/cache condition and explicit data/module gates. Record navigation, paint, route-ready milestones and resource bytes without universal timing thresholds. Development-module interception tests remain state-behavior evidence, not production-speed measurements.

For the owner-private Site, use a normal authorized owner visit and sanitized Navigation/Resource Timing evidence, correlated with supported read-only Site worker logs when relevant. Do not copy owner credentials/cookies into public CI, bypass login, or retry the denied local Chromium launch. Worker logs alone need not contain navigation timing. Hosted auth/platform/network latency remains unmeasured here; neither cold starts nor a specific cause of the user's slow page are established.
