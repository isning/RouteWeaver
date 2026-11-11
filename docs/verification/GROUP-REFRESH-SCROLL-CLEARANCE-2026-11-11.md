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
