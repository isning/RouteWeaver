# Doop mapping — 2026-11-18

Canvas: https://doop.design/c/JfC9yFHwTq

The user requested an actual mapping of the existing application and design tokens.
This capture uses the local demo control plane and current Vite application, including
pre-existing uncommitted changes. HEAD at capture was
`63b10e0e83f7ac594f03d015ad766a317eb8018b`; HEAD alone does not reproduce the working tree.

## Delivered

- 19 desktop navigation pages at 1440px, using their actual rendered DOM and CSS.
- Subscription, settings, server and forwarding-path pages at 390px in both themes.
- Overview, subscription and settings desktop dark-theme captures: 30 source frames total.
- Semantic OKLCH colors with dark-theme values from `web/src/shadcn.css`, plus radii,
  spacing, type, weights, a breakpoint and the four content widths.
- Six source-associated design representations: Button, Input, Badge, Card,
  SettingsRow and SettingsGroup. These are editable HTML/CSS representations, not
  executable React components or exhaustive reproductions of all variants and states.
- CapturedSidebar and CapturedSubscriptionStart were extracted from real source
  frames as reusable captured components. TokenSwatch supports the design-system board.
- A design-system board with token-linked swatches and component instances.

## Capture and verification

T3 Preview could not start because required host browser libraries were absent.
The repository's installed Playwright and existing Nix Chromium were used instead,
with the Chromium sandbox enabled. No browser setup or package installation was run.
Scripts, iframes and local image URLs were removed; inline SVGs and rendered layout
were retained. The local demo's synthetic account was used; no real nodes were changed.

All 30 local captures reported no horizontal page overflow. Every imported source
frame was rendered with Doop's screenshot tool and visually inspected. Text hierarchy,
group spacing, alignment, light/dark contrast and frame bounds were reviewed; no obvious
import layout breakage was found in these captures. Empty inventories remain empty.
The long account-security frame includes the demo's accumulated sessions.
These observations are bounded visual evidence, not behavioral or accessibility certification.

Local capture script, HTML, screenshots, capture manifest and frame mapping are in
`bin/doop-map-2026-11-18/` (ignored local artifacts). The source page snapshots retain
their captured structures rather than being rebuilt from approximate component templates.
Semantic color aliases reference canvas tokens; not every compiled Tailwind declaration
has been normalized into a token. Geist Variable is represented by Doop's hosted Geist;
Chinese glyphs still depend on available fallback fonts.

## Continuing design work

Use the Desktop, Mobile, dark-theme and design-system pages on the canvas. Preserve
source snapshots as comparisons and create separate proposal frames. Read canvas
guidelines, source files and the latest working tree before implementing any proposal.
Doop frames are static editable captures; API actions and React state are not imported,
and no automatic two-way synchronization has been configured. Most demo inventories
are empty; populated diagnostics, editor permutations, error states and all modal flows
are not covered by this mapping. No product code was changed and no behavior test
suite was run for this design-only delivery. Independent review was not performed.
