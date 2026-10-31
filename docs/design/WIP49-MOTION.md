# WIP49 interaction motion

This is a bounded motion refinement of the existing shadcn/Radix interface, not a new animation framework or a claim of overall product readiness.

## Observed problems and intended changes

- The navigation chevron rotated, but the corresponding links appeared and disappeared instantly. Actual baseline review observed a 144 px content insertion. `CollapsibleContent` now reuses the existing shadcn accordion keyframes, mapping Radix's measured collapsible height to the existing keyframe variable.
- Dialog and alert-dialog content/backdrops used a 100 ms, 5% zoom; sheet content used 200 ms while its backdrop used 100 ms. Large task surfaces now share 200 ms ease-out entry and 150 ms ease-in exit. Centered dialogs use a restrained 2% scale change. Small menus retain their existing faster cadence.
- Progress indicators used `transition-all`. They now transition only their value transform for 300 ms, so unrelated layout/style changes are not animated. Numeric progress is also forwarded to the Radix root, correcting missing `aria-valuenow`; null/undefined remain indeterminate.

These timings are design choices for this product, not a claim that shadcn mandates them. Official primitives, state selectors and CSS keyframes remain the mechanism. No timers, animation library, page remount animation, synthetic progress or delayed request handling were added. Radix retains responsibility for exit presence and task focus hooks remain unchanged.

## Accessibility and interruption

- All changed disclosure/task-surface primitives opt out of animation under `prefers-reduced-motion`; the existing global reduced-motion fallback remains in place for library-owned effects.
- Determinate progress exposes the same numeric value visually and through its public progressbar semantics.
- Existing overlay Escape, pending cancellation, safe confirmation, focus return and newer-task ownership tests remain relevant.
- Forced-mounted form accordions retain their existing hiding/state-preservation behavior. This pass deliberately does not trade draft retention or closed-field semantics for an exit effect.
- New regression tests exercise settled closed navigation, rapid close/reopen and numeric/indeterminate progress. JSDOM does not render animations: class-contract assertions and behavior tests do not establish animation smoothness or intermediate-frame accessibility. Actual browser review is required separately.

## Sources

- [Radix animation guide](https://www.radix-ui.com/primitives/docs/guides/animation): CSS mount/unmount animations and exit presence.
- [shadcn components](https://ui.shadcn.com/docs/components): existing component composition remains the foundation.
- Installed `shadcn/tailwind.css` and `tw-animate-css` supply the state variants and accordion keyframes. These were inspected directly rather than replaced with hand-written keyframes.

## Browser-found exit focus correction

The actual browser review found a regression invisible to settled-state JSDOM tests: during the 150 ms sidebar exit, pressing Tab could enter a retained child after the trigger already reported `aria-expanded=false`, then lose focus when Presence unmounted it. The sidebar caller now owns local open state (keeping the original route-dependent key and default-open rules) and makes closed content `inert` and `aria-hidden` immediately. Height animation remains intact. Closing only recovers focus to the trigger when focus is actually inside that group; focus already moved elsewhere is not stolen.

`sidebar-motion.dom.test.tsx` deliberately force-mounts content to exercise retained exit DOM, checks rapid keyboard toggles, current-route remount semantics, and owned-focus recovery. JSDOM does not implement native inert tab suppression: those tests verify the inert contract, not actual browser tab behavior. Browser exit-frame retesting is required.
