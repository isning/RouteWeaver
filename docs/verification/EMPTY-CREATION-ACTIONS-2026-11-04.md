# Empty list creation actions

Scope: resources and published routes, based on `27a7d9c`.

## Rendered finding

Reviewed CI32 `41788431252` images `route-width-resources-{1440,320}.png` and `route-width-published-routes-{1440,320}.png` from browser shard 3. Both pages repeated their black creation action in the page header and the empty state. Resource public-reference creation was already a secondary action.

## Decision

Keep the existing page-header action group at the same location across loading, empty, error and populated states. Remove only the redundant empty-state action. Retain the empty-state heading and the route prerequisite explanation. Resource import and public-reference creation remain available; route creation still chooses between creating a transfer path and configuring a public route according to the actual infrastructure inventory.

Moving creation actions between the header and empty state was considered and rejected: an intermediate implementation caused the workspace form-label regression to miss an opener when the list finished loading during a click. Keeping the action mounted avoids that race and preserves populated-state behavior.

## Verification

- Red: replacing the resource task helper's ambiguous first-match lookup with a unique accessible-name lookup failed four tests against the original duplicated actions.
- Green: six focused DOM suites, 46 tests passed. These cover both resource creation paths and busy/failure focus ownership, field labels, resource inspection/editor lifecycles, line path identity, and new keyboard open/close/focus restoration and empty/populated/error action visibility checks.
- TypeScript typecheck and production build passed.
- Existing five-width browser coverage now additionally requires exactly one action, checks both resource dialogs with keyboard activation/dismissal and restored focus, and checks the route prerequisite link. It retains screenshots at 320, 768, 1440, 1920 and 3440 pixels.
- New browser assertions and final-state screenshots require CI execution. Local Chromium was not attempted; the earlier execution restriction remains authoritative. DOM tests establish interaction contracts, not screenshot quality or deployed production behavior.

## CI33 onboarding regression follow-up

CI33 exposed one old workspace onboarding assertion that required two identical “创建转发路径” links. Reproduced locally against `3a35cc2`: the no-path case failed with expected 2 / received 1; the existing-path case passed. The test now requires a unique accessible link, retains its `#routes` destination and prerequisite explanation, activates it with Enter, then opens the real transfer-path creation dialog through the workspace. Existing-path configuration and resource import label tests likewise use unique accessible-name queries rather than taking the first match.

Added a public-route inventory test covering pending infrastructure, a 503 failure, and successful retry: configuration remains disabled and the page never claims an empty inventory before the result is known. Recovery exposes the unique transfer-path link and explanation. Existing authorization, draft handling, identity and save assertions remain unchanged.

Searched `web/src` and `web/tests` for all `toHaveLength(2)` / `toHaveCount(2)` occurrences and creation-action first-match queries. No other resource/published-route duplicate-CTA count assumptions were found; counts for requests, writes, unrelated controls and data remain unchanged.

Local follow-up: all 37 tests in public onboarding, resource form labels and empty creation actions passed; typecheck passed. These are DOM/workspace task tests, not new browser screenshot evidence.
