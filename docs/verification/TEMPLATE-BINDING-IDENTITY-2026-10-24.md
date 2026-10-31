# Template binding identity — bounded UX verification, 2026-10-24

## Accepted candidate scope

The existing template bindings table lost the acted-on profile/collection name off the left edge when narrow-screen users scrolled to update actions. Preserve one existing DataTable: fixed-left104px identity, wrapping names, numeric650px fixed-layout table,144px action column, and contextual accessible action names retaining the visible verb. Only these action buttons have a local44px minimum height at<=700px; desktop width/font/height remain normal. No global table/theme or API/Binding/preview/apply-handler changes.

A table-local ResizeObserver keeps an already-focused own action horizontally visible through width changes using actual sticky-column/focus-outline bounds. It does not move focus or scroll vertically. Width-unchanged, hidden, disconnected/replaced, unrelated-focus and disposed observations are guarded; lazy mount/cleanup are tested. No right-pinned action column, global listener or separate mobile UI.

The same update drawer's title uses local min-width0/normal/anywhere wrapping. Its version Select alone portals to the existing positioned drawer body, not the document-level session host or wrapping label. The popup remains inside the same session authority; no outside fallback, vendor/virtualization change or commit-on-pointerdown workaround. Normal click/up activation and cancellation remain.

This is a project adaptation of recognition rather than recall: keep distinguishing names/suffixes beside the action instead of requiring recall after scrolling. It is not Google-product, WCAG or whole-product certification.

## Final executed evidence

Private evidence root is `template-identity-proposal-20261024/` in the recovery workspace. Private fixtures/config/helpers, runners, copied sources, PNGs and raw JSON/ledgers remain outside canonical integration.

- `local-popup-typed-run-20261024`: all5stages native0 —23DOM,3selected workspace/29deliberately deselected,typecheck, fresh build,exact4browser cases. Browser count is two unchanged narrow keyboard/pointer tasks plus two separate programmatic background-scroll anchor contracts.
- Anchor contracts at320/390 genuinely move background document scroll0→80, observe a native scroll event, retain exact control/popup bounds, same non-null session/direct drawer-body ownership, visible/hittable real option, selectedv1 and unchanged request ledger. Actual320 popup PNG shows both options beneath the control without clipping. Programmatic scroll is a layout contract, not a user flow.
- `final-plain-nine-run-20261024`: native0/exact9passed using the exact newly built candidate source/assets, no diagnostic instrumentation or redundant rebuild. Original320x844,390x844,1440x1000 cases cover geometry, natural keyboard/precise Binding task, and resize continuity. The separate anchor2 are not counted as part of9.
- Final QA released12:52:12.137197 UTC; loopback4397closed. Source, staged inputs, dependency boundary, origin receipt/assets and canonical5b6cc baseline were unchanged. Per-stage native results, inventories, hashes and pixels remain in private receipts. No canonical integration was performed by these runs.

### Measured behavior

At320 the table viewport is254px(x33..287), identity104px(x33..137). Follow action94x44; pinned122x44. Natural pinned focus has a visible3px outline plus1px offset. Desktop→320 keeps the same focused button atx161..283 via minimal scrollLeft386, with outline ending at287. Unfocused320→390 preserves valid scrollLeft100 and tab focus. At390 viewport width324px; desktop retains normal28.5px button height.

Full Chinese/Latin shared-prefix suffixes, copy status and missing-name ID fallback are checked. Identity is measured at explicit start/middle/end positions; action bounds/hit tests at action edge or natural focus, not every scroll position. Actual text/control bounds, not decorative fractional row borders, define vertical fit. Drawer title text/individual Range fragments use the same strict bounds with default-budget condition polling through entrance motion; pixels follow the predicate, with no animation disable, added tolerance or longer timeout.

Natural Tab/Enter tasks preserve exact row-to-drawer association, dismiss a different row, select the real pinnedv2 option, confirm selected value/recheck readiness, and apply exact captured Binding/version/slots/digest. Each project's controlled ledger includes four applies in order: profile-beta,profile-alpha,collection-beta,collection-alpha. Geometry/resize cases write nothing. No unexpected requests/page errors. DOM regressions separately cover profile/collection follow/pinned association, lazy table mount, guards, cleanup and drawer-local popup ownership.

## Preserved failures and corrections

No earlier result was overwritten or silently promoted to success.

| Private attempt | Actual result and limited interpretation |
|---|---|
| `browser-red-run-20261024` | Build passed; desired390 identity assertion failed on unchanged production, name off-left at actual action edge. |
| `first-green-run-20261024` |17DOMpassed/4failed: Ant two-character Close spacing. Later stages NOTRUN. |
| `first-green-close-corrected-run-20261024` |19DOMpassed/2failed: pinned test clicked virtual accessibility proxy with no click handler. Later stages NOTRUN. |
| `first-green-option-corrected-run-20261024` |21DOM,3workspace,typecheck/build,one390browser passed; predates44px height and expanded matrix. |
| `matrix-run-20261024` | Pre-browser stages passed; browser1passed/8failed:2decorative row-bottom0.234px clips,3localized icon/footer Close ambiguities,3genuine focused-action resize visibility failures. |
| `matrix-resize-corrected-run-20261024` |23DOM,3workspace,typecheck/build,9browser passed. Independent pixels then exposed clipped unbroken Latin drawer title at320, not asserted by this pass. |
| `matrix-title-corrected-run-20261024` | Pre-browser stages passed;8/9browser.320existing pinnedv2 commit failed before title check;390/1440title checks passed. |
| `pinned-option-observation-run-20261024` | Single passive320 task: original selection failure did not reproduce; later whole-drawer entrance translation failed one-shot title bound. Actual Beta title fit. |
| `matrix-title-settled-run-20261024` | Pre-browser stages passed;7/9browser.320/390existing pinnedv2 commit failed before title check; desktop and all geometry/resize passed. |
| `pinned-entrance-observation-run-20261024` | Passive2narrow passed, not a causal repair. Event-time layout reads can affect timing. |
| `pinned-light-observation-run-20261024` | Ultra-light2:320failed/390passed. Same physical320activation changed reference target option-down→drawer-body-up→outer-DIV-click; v1 remained selected. |
| `pinned-scalar-observation-run-20261024` | Native scalar2passed; scroll/motion correlations did not prove exact failure mechanism. |
| `local-popup-targeted-run-20261024` | DOM23/workspace3 passed; typecheckTS2347 from untyped trigger generic call. Build/browser NOTRUN. Explicit trigger:HTMLElement fixed typing only. |
| `local-popup-typed-run-20261024` | All5stages0, including unchanged original2pointer tasks and2new deterministic anchor contracts. |
| `final-plain-nine-run-20261024` | Exact original9passed, unchanged fresh candidate/source/assets, no diagnostic recorder. |

Test-only corrections retained exact named context/semantics: contextual labels; /^关\s*闭$/ scoped to the existing footer; visible popup option associated by field aria-controls, not hidden virtual proxy/index; selectedv2 and enabled recheck; strict text/control bounds instead of decorative row edge; two read-only animation frames before table resize metrics; default-budget strict title-condition settling. No click retry, keyboard substitution, arbitrary sleeps, larger budgets or weakened version/digest assertions.

The ultra-light failure establishes missed option-click activation, not evidence of committedv2 state reset. Reference IDs/order/coordinates were historical; DOM descriptions/geometry were collected only at terminal time. The optional selected-value span was absent in diagnostics; raw content text/retained assertions were used honestly. Successful diagnostic runs never replaced failing plain runs. The local popup change has structural ownership and deterministic anchoring evidence plus final plain task passes; the exact historical alignment/dispatch race is not claimed proven.

## Portable canonical checks and limits

Seven integration paths only: Templates.tsx,styles.css,two existing DOM selector compatibility edits,two new DOM regression files,and this document. Private browser harnesses and screenshots are deliberately not formal-suite additions. Existing127historical logs are not integration touches.

From repository root after authorized integration:

```sh
npm --prefix web run test -- src/template-binding-identity.dom.test.tsx src/template-binding-resize.dom.test.tsx src/template-update-review.dom.test.tsx src/data-table.dom.test.tsx --maxWorkers=1 --retry=0
npm --prefix web run test -- src/workspace.dom.test.tsx --testNamePattern "^(shows and previews the exact pinned template version rather than the latest spec|drops removed template slots and submits the same exact version and bindings on preview and apply|keeps the profile's selected platform entries available when reviewing template updates)$" --maxWorkers=1 --retry=0
npm --prefix web run typecheck
npm --prefix web run build
```

Private browser replay uses its frozen checked source/config, owned output, installed Chromium and serialized QA lane,45s/worker1/retry0; it is not implicitly available from the canonical suite. Final private runner SHA256 `3acd78a9fc407de1d9b963469b9bf986b1540251094df323b7d07f50835ac305`; nine-overlay aggregate `f2e1ae8fcee69cb14de921b0faf1986139e81636ab7608bf72797fbae18c999c`.

Controlled API ledgers prove client target/version/slots/digest association, not durable backend writes or live apply. No deployment/publication/client traffic was changed. Backend/API,Go/race/nested runtime,native opt-in,official quick/full and final current-source aggregate gates remain separate root-owned validation. Boundary checks are not continuous filesystem/OS-library integrity proof. Canonical integration, independent visual acceptance and full-product acceptance are distinct decisions.
