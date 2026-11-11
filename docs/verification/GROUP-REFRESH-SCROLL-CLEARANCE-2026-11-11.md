# Group inventory Refresh scroll clearance

## Native finding

Exact native run `df1ff56`, recovery artifact `13894293646`, showed both 1440×900
UserGroups cases failing the unchanged viewport-containment assertion. Refresh
bounds were x=1224, y=-0.5, width=92, height=44. Focus-visible and center-point
unobscured checks passed. Original PNGs show the top border/focus ring clipped at
the viewport edge. The same bounds persisted through cached-error,
retry-keyboard and final-original captures, excluding a transient pressed state.

Evidence: `policy-inventory-retry-keyboard.{json,png}` in the artifact's
`web/test-results/admin-policy-inventory-rec-be5b3-ntory-group-retry-at-1440px-chromium/`
and `admin-policy-inventory-rec-50ee3-roup-stale-editor-at-1440px-chromium/`.
Authentication reads remained 2, failure reads exactly 2, and preparatory reverse
Tab traversal stayed within the focused workspace. This finding is separate from
the sampler's development StrictMode editor-attempt count correction.

## Scoped correction

Add `scroll-m-1` only to the group Refresh ActionButton. This is a 4px native
scroll margin for the existing 3px focus ring and fractional edge alignment,
consistent with the table-action clearance already in use. The shared Button,
group New action, focus ownership, fetch behavior and native assertion thresholds
are unchanged. No scripted focus, screenshot repositioning or tolerance change
is introduced.

## Verification and limits

The rendered-CSS tracer uses real UserGroups with an HTTP-boundary fixture and
compiles the actual rendered Tailwind utilities. It failed before the fix:
Refresh's computed scroll margin was 0. It passed afterward with the one-spacing
unit margin; the sibling New action remains at 0. This is CSS-contract evidence,
not proof of native painted geometry.

- Focused single-worker regression: **105/105 passed across five files** in
  22.13 seconds (CSS clearance, admin policy inventory, Users inventory, service
  creation readiness and group edit intent).
- `npm run build` (TypeScript and Vite) and `git diff --check` passed.
- Independent source/test review found no blocking issue. The test asserts the
  compiled spacing utility contract, not a browser-resolved pixel measurement.

The unchanged native keyboard/viewport assertions still require
a corrected run before claiming native acceptance. No full aggregate, browser
bypass, publication, deployment or real-user mutation was performed here.


## Corrected native acceptance

The pending native check above is now resolved by exact source
`2f5291ba3fbc419d90d7d2963d9094af77056cd2`, recovery artifact `13897258136`,
original ZIP SHA256
`ca79a6393a6c7318abd8be85b97807c59f57ce8a3587cf5731ae905c1c22f3fe`.
Both desktop group cases retain Refresh at y=3.5 with height 44 (pending width
increases from 92 to 114). Independent original-PNG inspection shows the strong
outer ring wholly inside the top viewport edge; paired geometry reports
focus-visible, viewport-contained and unobscured focus. This directly resolves
the previous y=-0.5 clipping finding without weakening its assertions.

The [policy recovery acceptance](ADMIN-POLICY-INVENTORY-NATIVE-RECOVERY-2026-11-11.md#corrected-native-original-pixel-acceptance)
records the complete bounded review: 27 unique originals across 52 captures,
eight passing service/group cases at 390×560 and 1440×900. Narrow table content
remains horizontally partial and may be below the viewport during pending
refresh. No dark-mode, full-offline, comprehensive keyboard/accessibility,
backend enforcement or deployment claim follows from these captures.
