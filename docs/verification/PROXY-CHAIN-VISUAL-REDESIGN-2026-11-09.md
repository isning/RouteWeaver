# Proxy-chain visual redesign — 2026-11-09

## Scope

Implementation: `8a59fde46fe5498d3b47ff6ca798c7abf0367e71`, based on `dafd0c4373930acf457fd31f9c74bb48e0fdcb80`.

The previous compact editor still read as a stack of equal-weight forms. This revision changes the information hierarchy rather than merely reducing padding:

- A connected vertical sequence runs from client through numbered nodes to target.
- Collapsed nodes show identity first and type/server/protocol/port second. Configuration opens on demand without discarding unfinished selections.
- Reorder, insert and remove live in a contextual node menu. Unavailable actions keep their reasons next to the relevant action.
- The desktop sheet is 672 px wide, with a right-aligned primary action. Mobile keeps the full-width save action and stacked configuration fields.
- The redundant visible route summary is removed; the textual summary remains available to assistive technology.
- Existing ordering, ownership, validation, draft and deployment boundaries are preserved. No dependency, credential, production permission or security-setting change is involved.

## Visual evidence

Actual Chromium renders were inspected at 1440, 390 and 320 px widths, including expanded configuration and an open action menu. The 390 px layout was also operated at 700 px height. Images contain only a locally seeded synthetic route and were delivered separately, not committed to this repository.

An independent review first examined the previous desktop/mobile screenshots, then the redesigned rendered screenshots and source. It found the hierarchy, alignment, connection and mobile wrapping materially improved, with no remaining blocking visual issue in the reviewed states. This is a bounded visual review, not a claim of user acceptance or a general usability study.

At 320 px, the five collapsed rows measured 86/74/74/86/74 px high and did not overflow their 272 px row width. At 390 px, the measured summary hit areas were 240 × 72 px. Configuration and menu controls retain the existing 44 px target convention.

## Behavior verified

Focused regressions passed: **5 files, 113 tests** across mixed-path workspace/editor, path model/workspace and connector editor. The new cases were observed failing before their respective fixes:

- Overview-first node rendering, with explicit inline configuration.
- Returning from the connection-parameter dialog preserves the expanded node and restores focus.
- A rejected reorder returns focus to its node menu trigger.
- Removing the final managed node restores focus to the remaining empty-path picker.

An additional five-file regression run passed **95 tests** before the last focus-only fixes; it is not presented as a second final-source gate. TypeScript checking and the production build passed on the final implementation. `git diff --check` passed.

Actual browser interaction against the real local demo API verified:

- Expand/collapse and narrow-screen configuration layout.
- Move a node up and down, with the route order and focused node preserved.
- Insert a pending hop, observe save disabled, and cancel back to the original chain.
- Open editable connection parameters and return with expanded state/focus preserved.
- Open the named read-only reason and close it with Escape, restoring focus.
- Save a renamed draft, see the saved-draft result, and reopen the same five-hop order.

The synthetic VLESS route lacks authenticated principals and correctly remained blocked from application. No apply/deploy action was taken and no real node, subscription or user account data was used.

## Limits and unfinished gates

The focused Playwright CLI command could not start Chromium in this execution sandbox: `process_singleton_posix.cc:297 socket() failed: Operation not permitted`. All three viewport cases stopped at browser startup, before their assertions. No browser-security setting was weakened. Supported live-browser inspection supplied the rendered and interaction evidence above, but is not described as an automated Playwright pass.

The full serialized `scripts/verify.sh web` gate completed after the implementation and initial evidence pushes: TypeScript checking, all web behavior tests and the production build passed. The behavior suite passed **286 files and 3,596 tests** in 857.66 seconds with one worker. This named web gate does not establish deployed acceptance or completion of all project stories. The exact-commit supplemental mixed-path CI check had passed; other CI checks were still running at the recorded observation. Delivery did not wait for CI.
