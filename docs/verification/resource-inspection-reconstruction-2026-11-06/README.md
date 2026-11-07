# Resource numeric and inspection intent: source-only reconstruction

Baseline: a1fbbc3. Historical 940693b intent summary, not recovered source: retain raw numeric edits, validate exact integers, cancel/fence stale inspection success/errors, and prevent save during active inspection.

## Candidate

- Resource-local numeric controls retain every edit in the form, including empty/incomplete text, so validation and dirty/discard use the same draft. Shared NumericInput is unchanged. The local control retains spinbutton bounds, finite current-value semantics, and ArrowUp/ArrowDown behavior. Explicit arrow actions step from finite numeric text (including out-of-range/fractional text), or zero for incomplete text, then clamp to existing bounds. This is separate from exact submission validation; incomplete/below-min text steps to the lower bound rather than lower bound plus one.
- Exact decimal/scientific text is checked before Number conversion. Fractional tails cannot round into valid integers. Existing ranges remain 60–2592000 seconds and 1–5 for sing-box format version; unchanged valid numeric values remain numbers. Numeric grammar has no whitespace acceptance. Text is bounded to 1024 characters and exponent magnitude 1024 before expanding zeroes. Negative and zero values are outside both existing positive ranges.
- Submit explicitly guards exact numeric results and retains ruleResourceReference payload filtering, remote-only intervals and sing-box-only format versions.
- Inspection owns a controller before async validation, snapshots URL/format, and fences validation completion, success, failure and cleanup against editor identity and request identity. Source/digest/version edits, editor replacement/discard and unmount cancel the read. Name/interval edits do not invalidate unrelated inspection results.
- Save button, implicit submit button and submit handler block saving while inspection is active. Cancellation permits a new request without waiting for an obsolete transport to settle.

## Authored public seam checks

ResourcesPage rendered controls with actual form/API adapters, synthetic fetch responses only. New regression source covers interval and version invalid tails, incomplete edits and correction, bounds, valid decimal/scientific integers, untouched default value, dirty/discard/reset, arrow keys (including blank, incomplete, below-min, above-max and fractional inputs), save gating, manual-digest cancellation and stale outcomes, unrelated edits, and unmount abort. Existing resource-inspection-lifecycle tests cover URL/format changes, close/reopen, replacement request ordering and current retry errors.

## Verification limits

All behavioral checks UNRUN. No Node/npm, Go/gofmt, browser, server, installation, network, push, deployment or upload was used. No red/green or runtime/type/build/lint pass is claimed. Git diff whitespace checks and source review only. Native rendering, focus, browser geometry, server authorization, SSRF and deployed behavior are not validated here.

Runtime inspection-response schema validation is absent in the baseline and remains out of this bounded reconstruction. The response is still trusted at the existing typed API seam; malformed successful responses need separate validation coverage. API request cancellation is best-effort; ownership fencing remains necessary when transport ignores abort. This candidate does not recover the historical commit byte-for-byte or establish full v110 readiness.
