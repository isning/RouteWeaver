# Narrow empty-table visibility

## Confirmed defect

The actual `admin-notifications-outbox-390.png` and 1440px counterpart from the `product-baseline-2ad-review` evidence were inspected. At 390px the zero count and first headers are visible but `暂无发送记录` is centered beyond the table's visible area. The same message is visible on desktop.

`Notifications.tsx` supplies `minWidth={760}`. `DataTable.tsx` centers the empty message in a full-width colspan cell. The existing no-scroll-hint/no-keyboard-region behavior for zero rows is intentional and does not solve the hidden message.

## Bounded change and geometry contract

Only the shared table's non-loading, zero-row content gains a wrapping block. It remains inside the original semantic table cell. The original table, headers, summary association, populated rendering, minimum widths, pagination and scroll-region handling are unchanged. Caller-supplied ReactNode empty states and their actions remain supported.

The block uses the already measured `--table-viewport-width`:

- For visible viewport width V, content width is V minus 2rem, matching the cell's existing 1rem left and right padding.
- `max-width: 100%` bounds it to the cell content area. The block plus padding contributes at most V to intrinsic table width, not V plus padding.
- A sticky left inset of 1rem keeps the message within the scroll viewport even when a previously populated table remains horizontally scrolled after filtering.
- Normal whitespace and anywhere wrapping allow long or structured empty content to fit.
- The existing measurement reads the scroll viewport, not the child width. On a desktop-to-narrow resize, the measured value reduces the inner block without widening the containing viewport.

Loading still suppresses the empty message and default zero count. Outbox read failures remain the caller's `QueryState` error with retry, not an empty result. Populated tables retain their actual scroll hint and keyboard region; no empty-state hint was added.

## Public regressions

- `notification-readability.ui.spec.ts`: controlled outbox loading, failed read, retry and confirmed empty at 320/390/1440; complete message and zero count in viewport, initially and at the right scroll edge; repeated narrow/wide resize, desktop no artificial table overflow and no rendering/ResizeObserver error. Captures initial and scrolled empty views.
- The existing populated outbox test additionally verifies a focusable scroll region, width of at least 760px, actual ArrowRight scrolling, and a reachable failure reason.
- `source-list-layout.ui.spec.ts`: representative shared client with a structured no-match state and Clear search action at 320/390/1440. Starts populated, scrolls horizontally, filters to no matches, checks message/action visibility at the right edge, and uses Enter to restore results and search focus. Narrow populated scrolling and desktop fit remain checked.
- The real normal-CLI `uiux-inventory-admin.ui.spec.ts` still covers the same routes. Its existing outbox capture now requires the zero count and complete empty message to be in viewport at 390/1440. No fixture replaces that real backend evidence.

## Verification status

Completed locally: `git diff --check`, Node syntax checks on the three modified browser specs, tracked private-file exclusion, and ticket DAG consistency.

Browser execution was attempted before the production fix but could not start: this checkout has no `web/node_modules/@playwright/test/cli.js`. No packages were installed and no alternate cache runtime was substituted. The attempt is not a failing-before-passing behavior result. Typecheck, DOM tests, browser regressions, post-change screenshots and full verification remain pending the exact-dependency CI run. The original rendered defect is confirmed; corrected pixels are not yet claimed.

Suggested focused browser run, from `web/` in the exact dependency environment:

```sh
node node_modules/@playwright/test/cli.js test --project=chromium \
  tests/notification-readability.ui.spec.ts \
  tests/source-list-layout.ui.spec.ts \
  tests/uiux-inventory-admin.ui.spec.ts \
  --grep 'viewport-visible empty|narrow announcement and delivery|source no-match|inventory admin notifications' \
  --workers=1
```

The coordinator retains the full web and browser gate. Review actual resulting pixels independently of passing overflow assertions before accepting the UX fix.
