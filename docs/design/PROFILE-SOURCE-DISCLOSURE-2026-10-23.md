# Profile source disclosure — 2026-10-23

## Task and evidence

For an existing rule task (a ChatGPT domain condition with one excluded suffix,
explicit FRA → UK destination and an airport-group fallback), source setup occupied
substantial space before the rule. This is an expert walkthrough finding, not user
research or evidence that a domain list is complete. Fixture group names are not
proof of a deployed route chain.

Use one interface: retain the actual default destination, show the selected source
identity and authoritative effective-input state, and disclose source editing only
when requested. Do not introduce a basic/expert mode or additional helper prose.

## Interaction and preservation contract

- New editor sessions start with source settings expanded; existing profiles start
  collapsed. Initialization occurs once per editor session, not on fetch or edits.
- `编辑来源` / `收起来源设置` controls one always-mounted panel. Hidden contents are
  excluded from accessibility and keyboard traversal with `hidden`, protected from
  author CSS. Toggling changes neither routing intent nor dirty state.
- The original source/collection choice, platform entry selection and effective
  connection details remain available. Default routing is always outside the fold.
- Selection identities, unavailable-reference warnings, catalog failures, pending
  work and recovery actions remain outside the fold. Effective count appears once.
  Missing collection catalog data distinguishes pending, paused and failed reads;
  it does not manufacture a healthy count or an active request while offline.
- Source repair/removal expands the panel before focusing the relevant selector.
  A source task is not closed by disclosure changes. Return focus chooses its
  connected visible origin, otherwise the visible disclosure control.
- Remove only duplicate strategy/rule shortcut links; retain the actual tabs.
- Preserve source references, rule AST/order/actions, default destination, group
  identity and explicit-destination session guards. No backend/schema changes.

## Nested discard-dialog focus

Real desktop and narrow-browser traces reproduced an existing bug in both the
baseline and initial candidate: dirty source Cancel → Continue editing → Cancel →
Discard briefly returned focus to Add, then the closing confirmation restored it
to its disappearing button; settled focus became BODY and Tab reached the skip
link. JSDOM's motion-disabled test did not reproduce this failure.

The bounded fix records discard intent on the exact confirmation, then discards
only in that confirmation's supported `afterClose` lifecycle. Exact-reference and
active-session guards reject stale/destroyed confirmations; cleanup clears the
reference before destroy. No timer, global keyboard/focus interception or second
user action is introduced. The confirmation must relinquish focus before its
source editor owner closes.

## Actual layout comparison

Same fixture, viewport and scrollY=0, built baseline versus built candidate:

| Viewport | Source/default context before → after | First rule top before → after |
| --- | --- | --- |
| 1440 × 1000 | 336.55 → 153 px | 768.03 → 584.48 px |
| 390 × 844 | 559.09 → 311.55 px | 1087.78 → 840.23 px |

Both retain readable source identity, visible default and no horizontal overflow.
Narrow screens still require scrolling to rule fields; this does not establish
that every deep-rule or mobile hierarchy problem is solved. Injected effective
input failure remains visible with retry while source settings are collapsed.

## Verification record (separate outcomes)

Evidence directory: `profile-source-disclosure-evidence-20261023` outside the
project. Existing dependencies and serialized QA lock; no deployment.

- Baseline public disclosure RED: 1 failed / 5 skipped (missing Edit sources).
- Initial new tasks: 6/7; cancelled-button accessible-space locator corrected.
  Subsequent 7/7 passed. Unsupported RTL `exact` option removed from new tests;
  exact string semantics unchanged.
- Selected six-file gate: typecheck passed, **103/104**. Existing collection-source
  repair task exceeded the unchanged 10-second deadline (11,021 ms). No semantic
  failure or final public-state trace established; not retrospectively green.
- Added no-cache collection failure/offline cases: **2/2** passed; build passed.
- Initial actual browser exposed the dirty-discard focus defect; preserved failed
  screenshots and baseline/candidate focus traces, rather than hiding the result.
- After lifecycle fix: typecheck passed and **21/21 assertions** across three files,
  but **two unhandled React scheduler `window is not defined` errors** at teardown
  made that gate non-green. Do not treat assertion count as a successful process.
- Independent final build passed. Actual baseline/fixed focus trace retained the
  baseline failure and verified candidate owner focus after motion plus local Tab
  on both viewports. Full composed browser passed at 11:52:48 UTC: dirty-cancel
  continuation/discard, disclosure/tab focus, literal saved intent and collapsed
  failure/retry preservation. No arbitrary delay is used as the product fix.

The teardown errors remain an explicit verification limitation pending bounded
investigation; no deadline increase, error filter or global-window shim is used.

One authorized unchanged-last-test baseline/fixed diagnostic completed at 11:56:26
UTC: each passed 1/1 with exit 0 and no reported unhandled errors. Both retained
open-confirmation unmount behavior. This nonreproduction neither identifies the
scheduler-error mechanism nor supersedes the earlier non-green three-file gate.
No cleanup coverage was removed merely to suppress that result.

## Lifecycle source

Verified 2026-10-23: [Ant Design Modal API](https://ant.design/components/modal/)
defines confirmation `afterClose` as occurring once closure completes. Installed
Ant Design 6.6.6 `web/node_modules/antd/es/modal/useModal/HookModal.js` invokes
`innerConfig.afterClose` in its close lifecycle. That supported lifecycle informs
the ownership fix; actual browser traces, not the API alone, establish the observed
focus result. The online documentation showed 6.6.7 at review; installed code and
build remain 6.6.6, without dependency changes.
