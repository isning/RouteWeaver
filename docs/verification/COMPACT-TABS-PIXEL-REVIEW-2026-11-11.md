# Compact tabs: bounded original-pixel review

Reviewed on 2026-11-11. This is a review of existing CI evidence, not a new browser run or acceptance of the current working tree.

## Provenance and method

- Exact captured source: `da66409ada7d4db648176d2e64b12fd00a755bb5`.
- Supplied CI artifact identifier: `13874973257`.
- Supplied artifact SHA-256: `a74a04c43d2f0a43680d33252838eca786b5f72562ef5da056358ff4175a9a9b`.

The coordinator supplied the artifact and its hash verification. The reviewer inspected original PNGs using the image viewer, mapped report attachment names through the embedded Playwright report, and read corresponding tab paint metadata. No thumbnails, reconstructed layouts, new screenshots, tests, downloads, or production changes were used. AGENTS.md and CONTENT-DESIGN-RULES.md were read. The referenced local code-review skill file was absent and is not claimed as executed.

## Checked original captures

Paths below are relative to `web/playwright-report/` inside the artifact.

| Attachment | Viewport | Original file |
| --- | --- | --- |
| focus-sample-light-active-tab-focused.png | 1440 × 1000 | data/f5da28746a15d35ac73bbdd1809e81b2e477aef7.png |
| focus-sample-light-inactive-tab-focused.png | 1440 × 1000 | data/6e44ad9de09a6f7ce3101b40513f741da43f18bf.png |
| focus-sample-dark-active-tab-focused.png | 1440 × 1000 | data/03e529561bd37a2c4cc203db495cc5aa7c90f14a.png |
| focus-sample-dark-inactive-tab-focused.png | 1440 × 1000 | data/79c6c36d4733d456e23ca1bfdb2ec72e90c28413.png |
| first-profile-390 | 390 × 844 | data/70ad677c620e826b8183b894cd0027e3465ed201.png |
| first-profile-1440 | 1440 × 1000 | data/3a18ad6c6c6b6bee448d1edae5a3a3d0e711feb3.png |
| backup-initial-light-390 | 390 × 640 | data/b69eee6ab5f3e7f9673f4a53fa95220006c39613.png |
| backup-initial-light-1440 | 1440 × 1000 | data/bb00567ef6b41873fbeb4a3844b65b3192951d64.png |

## Findings and bounded acceptance

No confirmed visual defect was found in these checked states.

- **Synthetic default tabs:** compact and readable at the captured desktop viewport. Active and inactive focus rings are visibly intact in both light and dark samples. Corresponding embedded paint records report 25px-high triggers, a 1px focused outline, and a 3px focus ring. This supports the smaller default-tab treatment in these samples, not every product usage.
- **First-profile header:** at both checked widths, title, unsaved status, secondary save action, and primary save/check action fit without visible clipping. At 390px the name input and associated-subscription disclosure remain readable. The desktop two-column body becomes a vertical arrangement on mobile. The viewport crop is not evidence that the rest of the form was reviewed.
- **Settings backup dialog:** settings tabs fit above the open dialog at both checked widths. The dialog's labels, security disclosure, cancel action, and download action fit. The magenta input regions are screenshot masks, not evidence of actual input rendering. The dialog obscures part of the underlying settings page.

## Evidence gaps

- No 320px default-tab screenshot was identified in the artifact. Do not claim 320px visual acceptance.
- The default-tab focus samples are synthetic desktop controls. They do not establish narrow product-tab focus clipping behavior or coverage of every tab group.
- Settings coverage here is the light-mode backup dialog and visible surrounding tabs, not an unobstructed general-settings review.
- Dark-mode acceptance is limited to the two checked synthetic tab states. This is not comprehensive dark-mode or contrast-compliance acceptance.
- No Sheet acceptance, keyboard interaction rerun, touch-target compliance verdict, or full-page/profile acceptance follows from this review.
- Findings apply to the exact captured source above, not later commits or uncommitted work.
