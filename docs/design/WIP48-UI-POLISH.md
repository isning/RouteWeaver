# WIP48: composed interface refinement

Status: bounded actual-browser comparison and final frontend checks accepted. The owner-private read-only demo has been updated; artifact saving is a separate operation. This is not user acceptance or blanket product certification.

## Why this pass exists

The user found WIP47's interface insufficiently polished after the shadcn migration. A component library does not determine a finished composition. This pass addresses concrete visual problems in the actual sample UI while retaining the official shadcn vocabulary, restrained motion and existing application contracts.

The baseline was the exact previously deployed WIP47 source, inspected in the cloud browser at 1180×757 and an authored 390×568 child CSS viewport. Representative pages were subscriptions, endpoints and their edit dialog, routes, servers, sources and users. These observations are bounded visual evidence, not claims that every page/device was exhaustively reviewed.

## Changes and visual acceptance criteria

- **One content rhythm.** Remove the page heading's extra bottom padding so it no longer doubles the workspace section gap. Use bounded search controls and one main table surface instead of an outer rounded card around another bordered table. Sparse datasets stay sparse; no decorative dashboard filler is added.
- **Stronger object identity.** Configuration, server and route names lead their rows/cards; secondary addresses and descriptions are muted. Server cards place the icon/name/address together, with actions opposite, instead of spending an extra row on icon/edit controls.
- **Compact endpoint forms.** Related protocol/credential and basic identity fields share desktop rows where appropriate. Redundant section headings above already labelled controls and excessive section gaps are removed. Mobile remains single-column; conditional fields, warnings, validation and long-content scrolling remain available.
- **List summaries remain summaries.** Forwarding rows use a compact listener/host/action layout rather than full detail-panel spacing. Branched/policy programs are not invented into a linear chain. Expanded details preserve the original semantic content.
- **Proportionate actions.** A normal row has a clear direct action and quieter secondary/destructive choices. Destructive controls do not visually dominate every row. Durable openers, cancellation focus and operation guards remain part of the contract.
- **Subscription composition.** One configuration card contains divider-separated subscriptions rather than another bordered card per child. The title is foreground text; primary subscription retrieval is distinct from review/background comparison. For a single applicable subscription, background comparison remains in the configuration menu; it is not removed or confused with the per-subscription review dialog. Multiple-item bulk comparison remains visible.
- **Quota and empty-state weight.** Usage is a compact meaningful summary retaining rate/quota/billing semantics. An empty user-group state is contextual, not a large competing card.
- **Navigation and dialogs.** Primary subscription/network destinations are discoverable while groups remain collapsible. Task titles have a deliberate hierarchy. A consistent non-blurred scrim separates foreground tasks; focus behavior, official primitive motion and reduced-motion support remain.

## Component and styling choices

Existing shadcn primitives and semantic Tailwind utilities are reused. `Section variant="plain"` is an explicit opt-in for unboxed list regions; the default card variant remains for genuine grouping. The Dialog/Sheet/AlertDialog scrim customization is documented in `SHADCN-MIGRATION.md`; no claim is made that those three files are untouched registry output. No separate CSS framework or bespoke visual component replacement is introduced.

Official composition references:
- https://ui.shadcn.com/docs/components/sidebar
- https://ui.shadcn.com/docs/components/data-table
- https://ui.shadcn.com/docs/components/field

## Behavior that must not change

This is presentation work, not new protocol or backend scope. Preserve authentication and credential boundaries, target-specific endpoint validation, unchanged-legacy metadata editing, dirty-form retention, pending/error states, stale-response fencing, keyboard navigation, focus restoration, source acceptance and routing semantics. Browser review must compare useful task states, not only report no overflow. Test counts alone do not prove visual quality or user acceptance.

## Final evidence

Final candidate r3 was compared with the baseline in actual desktop and authored narrow CSS viewports. Server cards reduced from approximately 210px to 114px and forwarding rows from approximately 210px to 116px without inventing chain semantics. Essential desktop TLS fields and the narrow-screen primary subscription action became initially visible. A newly observed narrow-navigation blank strip was corrected and rechecked. No remaining concrete visual blocker was found in these reviewed states; this is not design perfection or user acceptance.

Safe interaction checks confirmed named-target destructive confirmation, initial focus on the safe choice and cancellation focus return; source-menu Return/Escape navigation and durable opener restoration; and separate discoverability of background comparison versus per-subscription review. No mutating confirmation was executed. Public receipt: `CHECKPOINT-EVIDENCE/WIP48/visual-r3.passed.json` from repository root. Final frontend results are recorded in `../verification/WIP48-FINAL.md`: 1,806 tests passed, with typecheck/build and unchanged source binding. Native browser automation and actual mobile-device/touch/accessibility certification are not implied by CSS viewport inspection.
