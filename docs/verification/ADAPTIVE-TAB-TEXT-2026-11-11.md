# Compact tabs with enlarged text

Actual native product-model audits at `da66409` and `0f5f613` found four profile
labels painting at 34/36px inside 25px triggers during 200% text enlargement. These
are real clipping failures before later journey assertions, not stale test copy.
The normal-size default shadcn appearance remains requested behavior.

A shared application composition adds intrinsic minimum rail height and a
text-relative 1lh minimum on direct child triggers. Both ScrollableTabsList and
CollectionPreview use it. The official radix-nova primitive stays unchanged;
CollectionPreview retains its ScrollArea, scrollbar, label handling and focus
repair. No fixed oversized target, text truncation workaround or audit removal
was introduced.

Baseline public CSS regressions failed twice at the missing intrinsic minimum.
Final focused run passed 15/15 tests across three files in 7.39 seconds; production
TypeScript/Vite build and whitespace checks passed. The tests render both real
compositions and compile installed Tailwind rules. They verify emitted 1lh,
applied intrinsic minimums and scaling with doubled text size, retaining baseline
height declarations. Initial candidate assertions incorrectly expected a literal
lh value, then exact explicit line-height pixels from jsdom; those expectations
were corrected to its supported computed behavior, not relabelled as passes.

Independent source review found no composition blocker. CSSOM/jsdom do not prove
intrinsic geometry. Native Chromium must still establish unchanged 32px rail/
25px trigger appearance at normal text and full enlarged-label containment,
including padding/borders, line variant, focus rings and horizontal scrolling.
Existing native 200% painted-text audits and strict normal-size checks are intact.
Do not call the observed browser defect fixed until exact-source native evidence
passes. No browser was executed locally.

The preceding full local run for opener recovery lost its process handle during
the environment interruption; its log has no terminal summary. It is unconfirmed,
not a pass. A fresh serialized aggregate covers this composition change plus the
corrected conditional-owner visibility recovery and new safe diagnostic helpers.

## Exact-source native evidence and bounded original-pixel review

Head `829a567e0ab413e15563881dd0979bef9db5a7c8` quality run `43074691960`,
shard 4 job `130712024016`, produced artifact `13882052106`
(`browser-diagnostics-4-of-6`). The downloading reviewer verified its ZIP SHA-256
against the GitHub digest:
`2fbb5fda8c7ee974364de1e0ba58712d1ddb22d52965a60aebb27a6f426ad04a`.
The twelve compact-tab native cases and the four product-model enlarged-text
geometry audits passed. Native assertions and visual observations are separate
evidence; this does not establish the full CI aggregate result.

An independent reviewer opened the following unmodified original PNGs from the
artifact's `web/test-results/` directory:

- `product-model.ui-existing--43c59-ly-the-selected-client-link-chromium/lower-group-completion-200pct-text-simulation.png`
- `product-model.ui-first-use-10267--by-an-explicit-user-choice-chromium/intent-editor-200pct-text-simulation.png`
- `product-model.ui-workspace-07b7e-wo-independent-client-links-chromium/publication-review-200pct-text-simulation.png`
- `product-model.ui-25-synthe-6a9d9-unded-and-explicitly-scoped-chromium/client-inventory-200pct-text-simulation.png`

The lower-group original visibly contains the complete vertical glyphs of
分流规则 and selected 策略组, with sufficient selected-trigger height. This is
bounded visual acceptance against the earlier 34/36px-label-in-25px-trigger
vertical clipping defect. The rightmost 检查与预览 is partly outside the horizontal
tab viewport. Horizontal scrolling is intentional; keyboard reveal is covered by
the separate compact sampler, not proven by this still image.

The other three originals show legible enlarged save/routing actions and the
imported-but-unused consequence; wrapped publication identity and update
consequence with both footer actions visible; and wrapped inventory names and
readable visible statuses with a complete search focus ring. The intent-editor
input does not show its entire value, and the publication body is partly scrolled
behind its header. These are not claims that every field or scroll position was
visually reviewed.

The paired decoded product-model report `2edbdcf1763e273c20e4.json` identifies
390×844 with computed font and line-height doubled, explicitly not browser-native
zoom. Its four audits checked 35, 26, 6 and 8 controls/labels respectively without
reported issues. The visual acceptance above is limited to these light-mode
captures; it does not establish all enlarged text, all tabs, dark-mode pixels,
assistive-technology behavior or comprehensive WCAG conformance. This review ran
no tests and made no source changes or image transformations.

The coordinator separately reports the fresh baseline full DOM suite at
production/DOM revision `b22ca0a`: 4,131 tests in 337 files, completed
2026-11-11 18:14:03 UTC with exit 0. Its log is
`/tmp/rw-adaptive-tabs-conditional-return-full-dom.log`. This supersedes the
unconfirmed interrupted local run above, but does not replace exact-head full CI
aggregate evidence. The original-pixel reviewer did not rerun this suite.
