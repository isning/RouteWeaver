# Task return: bounded pixel acceptance

## Exact evidence

The corrected native recovery run for source `e39c2c7` passed 70/70 cases.
This independent review accepts only the diagnostic returned-opener evidence
specified below, not all seventy cases or the full aggregate gate.

- Artifact: `13881275200`.
- Artifact SHA-256: `3b4120c21714ea6b3e68c7cc4e2de1eee4edb73e33f55b0a7eff5ce99aa3cc15` (coordinator-verified artifact identity).
- Case mapping: `diagnostic-returned-opener-manifest.json`.
- Native report: `diagnostic-target-submit-focus.ui.spec.ts`, Chromium.

Both original PNGs were directly inspected, without modifying or recapturing them:

| Original report image | Viewport | Mapped cases |
| --- | --- | --- |
| `dcbd46d5d111dc8c899b0be2056597c392119883.png` | 1440×640 | Invalid-field recovery and definite save-rejection recovery |
| `c69d4121d6d59e57c41db7582abc4cc899d40ba3.png` | 390×640 | Invalid-field recovery and definite save-rejection recovery |

These are two unique images mapped to four cases, not four independent images.

## Observations and acceptance

The earlier 1440px failure placed the returned opener at x795.5, y596.25,
width106, height44, with bottom640.25 in a 640px viewport. Its lower focus ring
was visibly clipped. The first attempted correction retained that geometry on
`9122d4d`; its DOM passes did not establish native recovery.

For corrected source `e39c2c7`, both 1440px cases place the opener at x795.5,
y425.25, width106, height44, with bottom469.25. The original image visibly shows
the complete painted focus ring and readable label, with ample viewport clearance.
Both 390px cases place it at x142, y432.75, width106, height44, with bottom476.75.
The narrow original likewise shows the complete ring and label.

All four manifest records report exact opener focus, focus-visible state,
viewport containment and successful center hit testing. None reports a settling
failure. Scroll widths equal the respective viewport widths, with no horizontal
overflow. No new clipping of the returned control or diagnostic card is visible.
Upper page content lies naturally above the scrolled viewport; this is not
classified as a new clipping defect.

This accepts the settled returned-opener correction for these four synthetic
native diagnostic journeys, retaining the strict visibility assertions.

## Limits

This review does not establish continuous ring painting during every intermediate
frame, general nested-scroll clipping recovery, visual-viewport changes, sticky
occlusion handling, assistive-technology behavior or whole-application quality.
It does not prove backend persistence or deployed behavior. The full aggregate
gate remains separate from this focused recovery run.

The review used existing originals and geometry only. No additional tests,
downloads, publication or deployment were performed for this note.
