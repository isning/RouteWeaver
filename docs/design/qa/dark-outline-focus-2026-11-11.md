# Dark outline button keyboard focus

## Scope and rendered finding

React SPA, Tailwind 4, official shadcn/ui components and existing semantic tokens.
This is a bounded shared-component repair, not an application redesign. Existing
hierarchy, spacing, labels, button dimensions and light appearance remain intact.

The reviewed baseline is the actual desktop sampler from commit `3bedf3d`,
[successful supplemental run 42895065401](https://github.com/isning/RouteWeaver/actions/runs/42895065401).
Artifact `13800152432` was SHA256-verified:
`c9b158932b40f6b90c23e09b44e68c2a74be11b12c2a469e40143ac5a50a7c74`.
Viewed images are `8d4bec7d1c904a19d4dd64ab688f5a3d890ff856.png`
(card outline focused) and `6ed7d9dd95f68a6411fb2dbcad8cf02709eb948d.png`
(muted outline focused), with before/after paint records in the same report.

The dark outline variant keeps its idle border on keyboard focus. At the left
straight edge, card border RGB 57 and muted border RGB 70 do not change. There is
no visible outline or caret to supply another focus indicator. Only the 3px halo
changes: RGB 69 against card RGB 23 (**1.870:1**), and RGB 77 against muted RGB 38
(**1.790:1**). Replaying these saved pixels fails the new 3:1 regression criterion.
This is an actual rendered finding, not a conclusion from the halo alone.

Ordinary inputs and checkboxes in the same sample acquire a solid RGB 115 focus
border. Tabs also have an outline. Those controls are not changed on the basis
of their translucent halo alone; this review does not certify them globally.

Reference: the user-selected Refactoring UI reference,
[Focus states](https://github.com/edisonmbli/refactoring-ui-skill/blob/main/skills/refactoring-ui/references/15-beyond-the-book.md)
and [component editing boundaries](https://github.com/edisonmbli/refactoring-ui-skill/blob/main/skills/refactoring-ui/references/16-component-libraries.md).
Focus guidance is an external supplement, not an original-book claim.

## Bounded repair and regression

Only the shared outline button variant gets explicit dark focus border and solid
focus ring using the existing `ring` semantic token. No new palette, dependency,
custom CSS selector, app route or public endpoint is introduced.

The test-owned sampler reads actual screenshot pixels for outline buttons on
card and muted surfaces in both themes. It requires the halo to contrast at least
3:1 with its adjacent surface, verifies width and height are stable, and verifies
the dark border changes on focus. It attaches the exact measured viewport PNG.
Native scrolling is allowed; screen coordinates need not remain unchanged.

## Verification boundaries

The baseline evidence is desktop-only. Local browser execution remains blocked
by the host Chromium singleton `socket()` restriction; no launch retry or sandbox
bypass was attempted. The corrected pixels require a successful exact-commit CI
sampler run. DOM checks and builds cannot replace that evidence. No whole-app
WCAG, narrow viewport, live-node or deployment claim is made.

Local checks passed: 11 action-button/checkbox DOM regressions, application
TypeScript and production build, strict browser-spec TypeScript, sampler build,
two-case browser discovery, and the named static gate (including 102 helper
regressions). These are bounded checks; the full web/backend/browser suites were
not rerun locally for this patch.
The pinned Gitleaks current-source scan passed. Reachable-history coverage is not
claimed from this shallow checkout.
Independent read-only review inspected both actual baseline PNGs and the patch,
confirmed sample coordinates and bounded selectors, and found no blocking issue.
Corrected-pixel acceptance is still reserved for exact-commit CI.

## Corrected rendered evidence

[Supplemental run 42897359172](https://github.com/isning/RouteWeaver/actions/runs/42897359172)
succeeded at exact commit `62e27ef007513c3fe8769daf195df741c772a127`.
Artifact `13802025598` was downloaded and its SHA-256 verified as
`a6c076129eab3d294e09b7871b5a9268da75a5ed79ca7aaafbe54c66988ec14d`.
Both corrected measured PNGs were visually inspected: `cb1a6aae6a2f436b166dabd5a442ce9b9013a15a.png`
(card) and `14ce73787afaf036147d41c4e59869888e7fa496.png` (muted).
Their attached pixel readings show ring RGB(115,115,115) against RGB(23,23,23)
at 3.781:1 and RGB(38,38,38) at 3.192:1 respectively. The corrected focus ring
is visibly distinct on both surfaces. This closes the corrected desktop pixel
check above, not whole-app compliance or the required aggregate CI gate.
