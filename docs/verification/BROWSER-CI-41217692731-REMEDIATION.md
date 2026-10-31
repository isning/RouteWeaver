# Browser CI review — run 41217692731

Actual private CI source: `1a737fa07727b9ee01425b92f0ae9e204aef33a3`.
Remediation starts from integrated `33aa87a66daffd50a195cc08265b1754a11c8c44`, preserving later backend D4.

## Captured results

All four actual job logs and artifacts were retrieved through the authorized GitHub connector. Shards: 41 pass / 3 fail, 44 pass, 44 pass, 42 pass. Total **174 executed, 171 passed, 3 failed, no skipped tests**. Artifacts were tied to the source SHA above. Local evidence directory: `remediation-evidence-20261031/browser-41217692731/` (logs, ZIPs, extracted reports/screenshots).

The three failures are the notification title geometry assertion at widths 320, 390 and 1440. The assertion incorrectly measured entire table-cell height, which includes action-column-driven row height, as title text height. It received 65/45px against a normal-title 41px bound. Actual 390 announcement-list screenshot shows a normal horizontal title. The fix measures rendered text ranges, preserves the 192px column minimum and original 2/5-line height limits, additionally checks nonempty actual line counts, and attaches measurements/screenshots before assertions. Explicit geometry fixtures distinguish a tall row containing one line from an actual six-line title; these fixtures do not claim jsdom rendering.

## Actual image review and production fixes

Reviewed actual CI images: account recovery 320×360, 390×844, 640×400, 1440×1000; Fleet review widths 320, 390, 1440; announcement list 390 and editor 320×360/640×400. This is a selected review, not a claim to have inspected every artifact image.

Account recovery and announcement editor at 320×360 had usable footer controls but an excessively compressed form-body viewport. Existing tests missed this by checking only focused inputs or cancel buttons. Both specific dialogs now use the existing measured `scrollMode="auto"`: adequate heights keep the normal body scroll, insufficient heights switch to sequential whole-task scrolling. No global overlay styling or copy shrinking was introduced. Browser assertions now require the focused field and label fully in view, plus short-screen task mode. Fleet screenshots at 390 and desktop show the continuing-service consequences and review context; the 320 screenshot captured only the scrolled completion area, so a separate full-consequence screenshot and viewport assertion were added.

## Local verification and remaining gate

Exact lockfile install: `npm ci --ignore-scripts` (449 packages; offline cache miss first, ordinary install succeeded). Single-worker focused tests: 47 passed across 5 files. Red evidence: initial geometry/account cases 6 failed + 12 passed; announcement short-task regression 1 failed + 4 passed before its fix. DOM viewport fixtures exercise scroll selection, not browser pixels. Typecheck and diff check required before commit. Browser discovery remains 174 tests / 42 files.

No local Chromium was launched. Updated screenshots, actual title geometry, keyboard behavior, and strengthened short-screen assertions still require the next private CI run. This first run is not green and these changes do not claim final browser acceptance.
