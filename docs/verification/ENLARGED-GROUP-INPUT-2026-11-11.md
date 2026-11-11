# Enlarged group input: bounded native evidence

## Failed observation

Source `213e6b211effe36461a9dec4393fff87d0b20703`, native browser job `130729980133`, failed the existing strategy-group journey in `web/tests/product-model.ui.spec.ts:463`. After `readingTarget.scrollIntoViewIfNeeded()`, the 200% computed font/line-height simulation required `toBeInViewport({ ratio: 1 })` for the group-name input. Intersection ratio initially read `0.9860321879386902`, then remained `0.9848484992980957` through the unchanged 5-second assertion timeout.

Artifact `13884856238`, ZIP SHA-256 `b2d5be7bf9235350d117331dac792194b7a51bf5ae16f2d45c78dc68ab187036`, was downloaded once and verified. Extraction directory: `/workspace/scratch/d385eb428cee/ci-evidence-213e6b2-13884856238`.

Within that directory:

- Failure report: `decoded-report/2edbdcf1763e273c20e4.json`.
- Error context: `web/test-results/product-model.ui-existing--43c59-ly-the-selected-client-link-chromium/error-context.md`.
- Earlier original images in the same test-results directory: `lower-group-completion-320-reflow.png` and `lower-group-sticky-completion-390-short.png`.

There are no original failed-state 200% pixels, intersection bounds, or trace. The assertion preceded explicit screenshot/geometry capture, and automatic screenshots/traces were disabled. The earlier 320px audit checked 35 controls/labels with no vertical-text issues. The ratio is consistent with 65/66 visible height, but its axis and clipping ancestor cannot be established from that ratio alone. Sticky occlusion alone does not explain an IntersectionObserver ratio reduction. This is separate from the previously corrected tab-label sizing defect.

## Later non-reproduction

Source `fe343795f87d0cfd8f35ae281f2d0d6a81468694`, native browser job `130740642722`, passed the strategy-group journey in 6.9 seconds and all 101 tests in its shard. This followed diagnostics-only instrumentation, not a CSS correction.

Artifact `13885842598`, ZIP size `35717851` bytes, SHA-256 `d1d9502bf6528a379c145e95f9a275ed8df81a28a2c5b407f0bfe2012f2ad789`, was downloaded once and verified. Extraction directory: `/workspace/scratch/d385eb428cee/ci-evidence-fe34379-13885842598`.

Within that directory:

- Original image: `web/test-results/product-model.ui-existing--43c59-ly-the-selected-client-link-chromium/lower-group-completion-200pct-text-simulation.png`.
- Geometry attachment `lower-group-completion-200pct-geometry` in `decoded-report/2edbdcf1763e273c20e4.json`: viewport 390×844, font 16→32, 35 controls/labels, issues `[]`.

The preceding 320px and 390px-short screenshots are byte-identical across the failed and successful runs. Their respective SHA-256 values are `2221fb6f5efef748715e601786b4a8712327389ebfebefdd66df83299a7ee429` and `3dca1058847da3cbdf27ca8ca938da63bfd7831bcd4ebbdb7905050c64c7752f`.

## Residual risk and limits

Original successful 200% pixels show the input border approximately at y778–843 in the 844px-high viewport: the bottom border occupies the last image row, leaving no lower clearance. Its outer focus ring extends beyond the viewport. This near-boundary placement is consistent with sensitivity to a one-pixel layout/scroll difference, but does not establish the earlier failure's cause. The screenshot occurs after additional primary-action scrolling and completion inspection, not at the original assertion instant. The successful text-geometry attachment contains no target bounding boxes or intersection margins.

The failure remains an unresolved intermittent observation and a candidate for a future focused layout audit, not a closed product defect. No hypothetical CSS fix was made. Strict ratio 1, assertion timeout, and normal action order remain unchanged. Failure-only instrumentation now captures privacy-masked original-position pixels and allowlisted numeric intersection/ancestor/animation evidence before text styles restore; keep it for recurrence. It records failure-time animation state, not a history of preceding transitions. No local native-browser run was used for this review.

## Separate natural keyboard-focus probe (native execution pending)

A new native UI case, `enlarged group name keeps its focus ring visible on natural keyboard entry and return`, uses a saved synthetic group at 390×844. After the group panel mounts with its details collapsed, it doubles the existing computed font and line-height values, waits for fonts/finite transitions and the panel to settle, then follows the native keyboard path from the selected tab: panel → Add group → summary → Enter → group-name input. It also checks Tab to strategy and Shift+Tab back. There is no target `focus()`, `scrollIntoView()`, viewport repositioning, or screenshot-scroll adjustment in this measured path.

This is deliberately separate from the original scroll-based audit, which remains unchanged. The original screenshot followed a retained input focus and repeated programmatic locator scrolling, so it cannot establish what ordinary focus navigation does. Source inspection found a 128px top scroll margin on profile inputs and a 3px outer focus ring, but no bottom scroll margin; this is a hypothesis to investigate, not evidence authorizing a CSS correction.

Before entry or reverse-entry focus/clearance assertions, the new case writes and attaches `group-name-keyboard-200pct-{entry,reverse-entry}.json` and privacy-masked original-position PNGs. Numeric evidence includes the target rectangle, intersection ratio, focus state, shadow lengths, font and scroll margins, viewport scroll, clipping ancestors and sticky toolbar bounds. Text and replaced content are masked without repositioning the page. Checks retain strict full border-box intersection and require the rendered 3px ring to fit the viewport and clipping ancestors without toolbar overlap. Soft geometry assertions allow both directional samples to be recorded when possible; a keyboard-path failure still fails the test.

Local verification: explicit TypeScript checking of the native spec and helper passed; application `tsc -b` passed; Playwright discovery found exactly one new Chromium case. Native execution, actual keyboard screenshots and red/green reproduction remain **unrun** here. No production CSS/component change and no local browser launch were made. The first explicit TypeScript command was issued from the repository root and could not resolve Node types; rerunning from `web/` with the installed compiler resolved that invocation issue.
