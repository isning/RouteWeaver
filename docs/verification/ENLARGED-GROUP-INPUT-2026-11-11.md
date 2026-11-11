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

## Natural keyboard-entry reproduction and scoped candidate

The separate probe failed on exact source `e3f1c727ad1b43ba5e8fe8eeea4bd1f8f4cabfbe`, native run `43087454728`, job `130755475991`. The shard had 101 passing cases and this one failure; the original scroll-based strategy-group journey passed. Artifact `13888440075` is 35,656,679 bytes with verified ZIP SHA-256 `77c0dc0bf73048d05dfc2b26ce9f89afa8c9a74bfeb96e311e5aecc1e8a4ff9f`, extracted under `/workspace/scratch/d385eb428cee/ci-evidence-e3f1c72-13888440075`.

Both original-position privacy-masked images and numeric attachments were inspected in `web/test-results/product-model.ui-enlarged--a5e42-l-keyboard-entry-and-return-chromium/`:

- Forward entry: `group-name-keyboard-200pct-entry.json/.png`; actual keyboard focus and `:focus-visible` were true, font/line-height were 32/48px, and the rendered shadow spread was 3px. The input rectangle was x66–324/y778–844 in a 390×844 viewport, intersection ratio 1, scrollY 855. Bottom scroll margin was 0 and top margin was 128px. The ring extended to y847, producing the strict bottom-clearance failure. Sticky toolbar y0–121 and clipping ancestor x16–374/y344–1469 did not cause this bottom viewport clipping; center hit-testing succeeded.
- Reverse entry: `group-name-keyboard-200pct-reverse-entry.json/.png`; focus and ring remained active, input y334–400, scrollY 1299. The full ring fit the viewport. This bounds the observed defect to forward entry in this specific enlarged-text journey; it does not explain the earlier intermittent 213e6b2 border-box ratio failure.

Candidate: add `scroll-mb-1` only to the strategy-group-name Input in `Profiles.tsx`. This reserves one spacing unit (4px with the current theme) for its 3px ring during native focus scrolling, while retaining the inherited top margin. The shared Input, other fields, native keyboard probe, original scroll-based audit, strict assertions and screenshot positions remain unchanged.

A rendered `ProfileEditor` CSS contract in `group-membership.dom.test.tsx` compiles actual Tailwind utilities and checks the group input's bottom margin plus retained top margin. The final contract failed before the candidate (`scrollMarginBottom` was `0`, expected `var(--spacing)`). An initial assertion expected an unsimplified `calc(var(--spacing) * 1)` expression; it was corrected to the installed compiler's equivalent `var(--spacing)` serialization, then the no-production-change red baseline was repeated. This checks applied CSS, not browser scrolling or painted pixels. Native candidate execution and red-to-green ring evidence remain pending; no local browser bypass was used.

Candidate local checks passed: 68 focused tests across group membership, profile content hierarchy and group interval intent (one worker), application `tsc -b`, and `git diff --check`. The coordinator owns the final aggregate gate and native CI verification.

## Corrected natural-focus clearance: bounded acceptance

Exact source `c22478d843b3bef6efcd9fdae97985f60819caec`, run `43090150934`,
shard job `130764758717`, passes the unchanged natural-focus probe and original
scroll-based audit; the native suite reports 567/567. Artifact `13888258077`
(35,708,848 bytes) has verified original ZIP SHA-256
`c488392407ad578a73810e444fb6e2e1fc7fd7947f13ce4b954500f1fb4a8473`.
The corrected originals are under
`/workspace/scratch/d385eb428cee/ci-evidence-c22478d-13888258077/web/test-results/product-model.ui-enlarged--a5e42-l-keyboard-entry-and-return-chromium/`:
`group-name-keyboard-200pct-entry.json/.png` and
`group-name-keyboard-200pct-reverse-entry.json/.png`.

Independent review opened both corrected JSON records and original-position
privacy-redacted PNGs, alongside both prior e3f PNGs. Forward entry now places the
input at x66–324/y774–840, with the unchanged 3px ring reaching y843 inside the
844px viewport. The corrected image contains the lower ring boundary; the prior
y778–844 input lost its ring below the viewport at y847. Reverse entry remains
y334–400, with its ring at y331–403, visibly contained.

Both corrected records retain 32px font/48px line-height, ratio 1,
focus/focus-visible/center-hit true, top scroll margin 128px and bottom margin
4px. Forward scrollY is 859 rather than 855; reverse remains 1299. The ring fits
the recorded clipping ancestor and does not overlap the sticky toolbar y0–121.
The numeric observations corroborate the bounded image review rather than
substituting for it.

This accepts the observed natural-keyboard forward/reverse ring-clearance
correction only. The remaining forward clearance is 1px, not evidence of broad
cross-browser or layout robustness. Computed text was doubled; this is not
browser-native zoom. Privacy redaction changes content/styles, so the captures
do not establish original text readability, full visual contrast or color. The
older intermittent 213e6b2 border-box-ratio failure is not root-caused by this
result. The reviewer performed no download, image transformation, source edit or
test run. The separate full local suite was still running when this note was
written; no pass is recorded for it here.
