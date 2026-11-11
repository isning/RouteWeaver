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
