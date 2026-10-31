# WIP49: layout and interaction motion

Status: bounded actual visual/motion review and final source-bound frontend stages accepted. The initial focus observer mismatch was resolved without changing production behavior; historical failure and command interruption remain recorded. The owner-private read-only demo has been updated; artifact saving is separate and neither constitutes user acceptance.

## User-directed focus

Following WIP48, the user requested continued optimization with attention to animation and UI layout. This pass retains the official shadcn/Radix composition and semantic Tailwind vocabulary. It does not add a new animation framework, ornamental page effects or protocol/backend scope.

## Layout work

- Collection sources receive clearer title, metadata and action hierarchy without another decorative card layer.
- Basic and subscription-origin settings use task-appropriate bounded form widths and an explicit 24px section rhythm rather than stretching small forms across the workspace.
- The resource list uses the plain list surface. Its current sample fixture is empty, so populated-list appearance is source-reviewed rather than claimed as actual rendered evidence.
- A subscription-origin preview fixture is confined to the read-only Site adapter: an unverified `.demo.invalid` draft, no real token, no live origin and no mutation capability. It permits visual inspection of the actual form without pretending that configuration has been saved or verified.

## Motion work

The existing measured-height disclosure animation is reused for navigation. Dialog, sheet and alert surfaces share a restrained 200ms entry / 150ms exit, and progress animates only its value transform for 300ms. Small menus retain their faster cadence. Numeric progress is forwarded to the Radix root so visual value and `aria-valuenow` agree; null/undefined remain indeterminate. See `WIP49-MOTION.md` for implementation boundaries and official references.

Reduced-motion classes and the existing global fallback remain part of the source contract. Actual preference emulation was unavailable in the reviewed browser; source/tests are not misrepresented as an actual reduced-motion browser run. Force-mounted form accordions deliberately retain their existing state-preserving lifecycle rather than gaining exit effects at the cost of draft retention.

## Animation must preserve task ownership

Actual browser work found two regressions that settled-state tests alone did not expose:

1. **Exiting sidebar links remained focusable.** During the new close animation, Tab could enter a child whose group already reported closed and then lose focus when it unmounted. Local controlled open state now marks closed content inert and aria-hidden immediately, while retaining the height transition. Focus recovery is conditional on ownership so a newer focus choice is not stolen. Rapid toggling with Tab was rechecked in the actual browser.
2. **A closing task flashed the wrong form.** Longer exit presence exposed presentation derived from already-cleared live editor state. Admin and inventory editors now retain presentation-only values for the closing frame, keep live operation ownership guards authoritative, and clear forms with identity-aware completion. Closing content is inert. Actual server/core/endpoint dismissal and opening a newer task were rechecked. Retained presentation does not authorize stale saves.

These fixes are necessary behavior work caused by the motion change, not merely visual decoration. Failing-before focused evidence is preserved separately from the final full suite.

## Review standard

Evaluate coherent movement, stable layout, keyboard/focus behavior during exits and clear task hierarchy, not only absence of overflow. Desktop/narrow CSS viewport review does not establish physical mobile/touch behavior, a full assistive-technology audit, design perfection, Google-level equivalence or user acceptance. Actual reviewed-state evidence is summarized in `../verification/WIP49-FINAL.md`; the historical full frontend failure and separately completed offline build are explicitly distinguished from final acceptance.
