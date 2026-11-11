# Policy editor browser lifecycle evidence

## Observed failure

At source da66409, Chromium browser shard 2 (job 130680920337, run 43065981350) passed the 1440px conditional-policy editing journey and failed its 390px counterpart. Diagnostics artifact 13876373087 records the rule 2 destination as `直连`, followed by a full-viewport assertion reporting ratio 0. The initial default-action screenshot is healthy. There is no screenshot or numeric scroll geometry for the failing step, so these artifacts do not establish a product root cause.

## Bounded test change

The rule destination loop now awaits focus returning to the actual action trigger after each selection, matching the existing default-destination step. A changed label alone does not establish that a retained popover has completed its close/focus lifecycle. A late focus return changing scroll after capture begins is a hypothesis, not a proven explanation of this failure.

The capture helper saves its existing unmodified viewport PNG before visibility assertions and attaches numeric viewport, target and body geometry plus a target-focus boolean. It does not collect field values, text, URLs or credentials. This journey uses isolated synthetic inventory; screenshot scope, dimensions and names remain unchanged. No upload workflow, mask, production component, timeout, viewport-ratio requirement or hit-test requirement changed.

## Verification

Passed: strict TypeScript checking of `tests/server-policy-editor.ui.spec.ts` and its imported test helpers with `tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution bundler --types node`.

Passed: Chromium Playwright discovery for this spec, reporting both 1440px and 390px cases.

Not run: browser execution or the full suite. Native CI must rerun the journey before this can be called a passing fix. If the viewport failure persists, inspect the pre-assertion screenshot and geometry instead of weakening the assertion or increasing timeouts.
