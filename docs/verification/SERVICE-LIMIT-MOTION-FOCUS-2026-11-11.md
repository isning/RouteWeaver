# Service limits: focus during opening motion

## Original native evidence

On source `1a71da8`, both 390×560 service-rate journeys failed the initial raw-input focus capture. Verified recovery artifact `13898674188` records the focused input at `(17,541.5,357,44)` with its center and text below the viewport. The original screenshot was taken after ordinary motion settling, not during animation. Both 1440×900 cases passed the previous border-box assertion, but the original desktop PNG shows the left outer focus ring clipped at the accordion boundary and the lower ring clipped by the viewport.

The report places rate focus about 96–120 ms after accordion activation, during opening motion. The existing reveal ran synchronously on focus only. These observations establish a real fast-keyboard interruption gap, but do not establish whether the final position results from the drawer rail's initially limited scroll range, the inner overflow-hidden accordion's scroll clamping, or both.

## Narrow correction

The service editor rechecks visibility at the exact open accordion's own `accordion-down` animation completion. It uses the currently focused control inside that exact content, then the existing ownership, document visibility, session, disabled, and ring-aware nearest-scroll guards. It never moves focus, remembers an old target, schedules a delay, or changes reduced-motion synchronous focus behavior. Child or unrelated animation completions are ignored.

A service-editor-only 4px inline inset inside the accordion preserves its overflow-hidden animation while leaving room for the existing 3px focus ring. The shared accordion primitive is unchanged.

The native sampler keeps fast real keyboard entry and all prior assertions. It additionally checks the actual settled 3px ring against viewport and every clipping ancestor (the existing focus-paint suite's 0.5px raster tolerance). Its request ledger gains bounded passive numeric input/accordion/body geometry at focus, input and opening completion; no raw drafts, credentials, identifiers or API payloads are recorded by that observer.

## Verification and limits

An isolated real-editor DOM regression models a clamped opening rail because jsdom has no layout. With the original production source it fails the completion reveal (scroll20 instead of103); with the correction it passes without refocusing or changing the raw draft. Guard cases cover newer focus, Cancel confirmation, closed/unmounted content, child/unrelated animation, hidden/inert/session-busy state, hidden document and disabled control. No-motion focus still reveals synchronously.

The final 162-test focused drawer/count/rate/policy/motion set passed, including all 14 motion/clearance cases and the added privacy guards and inline-inset assertion. Compiled CSS confirms `.px-1` uses `padding-inline:var(--spacing)` with `--spacing:.25rem` and retains `overflow:hidden`. Frontend type/build passed. The changed native sampler type check and four-case discovery passed. No local browser run, corrected native result, full aggregate, backend mutation, deployment, or publication is claimed here. The native originals must still establish final motion and ring behavior on the corrected revision.
