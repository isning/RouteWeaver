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

## Corrected native original-pixel acceptance

The pending corrected native review above is resolved for exact source
`ed83f6d14009dac89b737bf6b7a64831ca5bb155`, recovery artifact `13900494005`.
The monitor verified original ZIP SHA256
`ad611d9193dea9facc0b72911cfadc45eab93842ee79bfb395dc30e4ea9e3e16`.
All four native service-rate cases passed. Independent inspection covered
**21 unique original PNGs across 30 mapped captures**, at 390×560 and 1440×900,
without transformations or duplicate downloads. Attachment mapping is in
`decoded-report/196b0fad6bb81adcf4a4.json`; originals and paired JSON are under
`web/test-results/service-rate-draft.ui-serv-*` case directories `a7aaa`, `995a7`,
`ec20e` and `6ccec`.

Reviewed `service-rate-{raw-input,discard-decision,continued-draft,blocked-preview,
corrected-remount,preview-review,final-original}.png` in all four cases, plus
`service-rate-collapsed-draft.png` in both exponent cases, deduplicating identical
originals. Actual red invalid rings and dark corrected/control rings appear
complete. Mobile raw/remount input is y512.5–556.5; its 3px outer ring ends at
559.5 within clip559.75. Desktop is y852.25–896.25, with ring bottom899.25 inside
clip899.75. The inline inset also clears the left ring. Paired clipping geometry
corroborates this painted inspection rather than substituting for it.

Raw “-” / “1e” survives cancel/continue, collapsed recovery copy remains visible,
and corrected “+03.000” survives remount. The preview visibly compares 2→3 Mbps.
Separately, each request ledger records one accepted synthetic preview at
375000 bytes/s, unchanged auth/context reads, no rejected requests and no page
errors. Transport values and request ownership are ledger evidence, not pixel
findings; no save/apply action is accepted by this review.

The prior `1a71da8` geometry had mobile y541.5–585.5 outside the viewport and
desktop y855.25–899.25 without 3px ring clearance. Its ledgers contain no motion
timeline. Current `service-rate-request-ledger.json` timelines separately record
mobile opening-end capture y618.5–729.5 followed by bubble y512.5, and desktop
855.25→852.25 (an already-revealed desktop reopening remains at 852.25). These are
numeric event observations, not screenshots of each animation frame or an
isolated proof of which browser scroll mechanism caused the earlier defect.

Bounded settled-pixel acceptance only: raw/remount and collapsed-invalid reveal
captures put helper/error explanations below the fold, so complete field/ring
visibility does not mean simultaneous explanation visibility. Narrow preview
also needs scrolling for lower review content. No blocking painted defect was
found within the inspected states; no full-motion, all-context, dark-mode,
full-system, backend-enforcement or save/apply acceptance follows. Aggregate
verification remains separate. This review performed no source changes, new
tests, browser actions or publication.
