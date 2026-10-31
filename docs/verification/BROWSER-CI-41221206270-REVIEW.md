# Browser review — run 41221206270

Exact remote candidate `f852b9b6d02cd0a8f1976fe9e1d688e6931a9ced` (tree `b61719fd…`). All four browser jobs reached terminal: shard 1 **43 passed / 1 failed**, shard 2 **44 passed**, shard 3 **44 passed**, shard 4 **42 passed**. Total **174 executed, 173 passed, 1 failed, no skipped browser tests**. Sandbox startup passed on Chrome 156.0.8078.47 / Ubuntu 24.

Four connector-retrieved ZIPs were downloaded and SHA256 checked against artifact metadata; actual logs and extracted reports are in `remediation-evidence-20261031/browser-41221206270/`.

## Actual measured title results

| Width | Title column px | Normal title | Long title |
|---|---:|---:|---:|
| 320 | 192 | 1 line / 18px | 3 lines / 58px |
| 390 | 192 | 1 line / 18px | 3 lines / 58px |
| 1440 | 342.84375 | 1 line / 18px | 2 lines / 38px |

Line-height was 20px. Original minimum column width and 2/5-line limits passed, as did action context and keyboard checks. The 320 announcement list image was inspected directly; titles are horizontal and readable.

## Short-screen image review

Inspected actual 320×360 account password-focus and completion screenshots: current-password label/input are together visible, additional fields are sequentially scrollable, and completion reveals full consequences plus cancel/disable actions. Inspected announcement 320 title-focus screenshot: title label/input and content field are readable without the prior compressed body. Inspected Fleet 320 consequence screenshot: the entire continuing-authorization consequence paragraph fits above the next table; recovery bounds, stop/replacement consequences and Agent-exit distinction are visible. These are real CI images, not fresh local-browser output.

## Remaining failure and narrow correction

The 640×400 announcement test passed its full-input and full-label visibility assertions, then failed the added assertion that auto scrolling must select internal `task` mode. It actually selected `body`. This assertion contradicted the intended auto contract: less wrapping at 640 leaves enough body capacity for the normal scroll rail. The previous run's 640 editor image also showed readable fields. This is not related to asynchronous notification delivery/API polling.

Correction is test-only: retain mandatory task mode at the evidenced 320×360 case; at 640×400 require at least 200px usable body capacity instead of forcing mode. Both sizes retain full focused label/input visibility, cancel reachability, exact draft title, focus return and no document overflow. No production code or timing/geometry limits are relaxed. New 640 screenshot/completion after this corrected assertion still requires the next exact-source CI run; the current failed run is not reported green.
