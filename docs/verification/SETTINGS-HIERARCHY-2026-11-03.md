# Settings hierarchy refinement

Scope: Basic Settings, subscription-origin settings and their loading states. The user rejected v13's weak row boundaries and flat information rhythm. Cloudflare reference images were inspected privately; no image or account content is included here.

## Composition

- Group headings and the domain group's useful scope description sit outside the surface. A larger inter-group gap separates different tasks.
- Each setting is a full-width row with its own padding. Row separators reach the inside edge of the shared border, rather than stopping at one large card's padding.
- Labels use a narrow stable column. Values use the flexible primary column, necessary explanations follow the value with muted styling, and genuine actions occupy the trailing column. Mobile follows label, value, explanation, action.
- Remove the tautological name explanation. Preserve the invitation creation requirement and the explicit UTC+8 accounting fact because an absent default-setting value does not change the accounting implementation.
- Effective origin and current-link example are separate rows. Draft editing and saved-draft verification/activation are separate full-width work areas. Keep format, blank/default behavior, DNS/TLS/proxy prerequisites, proof validity, failures and activation consequences.
- Loading uses the same grouped-row vocabulary; an origin query no longer nests a form-card skeleton inside a card.

## Behavior preserved

The same name form and inputs stay mounted. Read/edit state, accepted baseline, complete settings PUT, concurrent newer draft protection, hidden-tab focus ownership, Origin revision/verify/activate flow and confirmation are unchanged. No new endpoint, action, default, or editable policy is introduced.

## Evidence and limits

Baseline name-explanation regression: 1 failed, 29 passed before candidate. Initial candidate: 46/46 settings and origin DOM tests. Broader loading checks exposed one old two-column skeleton CSS assertion; it was adapted to the new grouped-row geometry while retaining loading/not-ready assertions. Browser assertions additionally check external heading placement, full-width row edges, separators, desktop value/help alignment and mobile reading order. Existing downstream task and zero-write checks remain.

Final focused suite: 55/55 across six files; application and browser-spec type checks and production build passed. Settings row columns switch on the content container budget, not the window width.

Browser execution and actual new pixels must be verified in CI; local browser execution is not attempted. DOM/type/build success is not visual acceptance and does not establish user acceptance or whole-console completion.

## CI22 findings and follow-up

CI22 was not accepted: twelve Origin geometry cases retained the old inset-summary contract (768px maximum, 16px desktop gap and 4px mobile gap). The new whole-row group is bounded by the 832px primary content cap, has no inner summary cap, and uses 20px/6px gaps. New assertions compare the summary with the enclosing surface's exact inner edges, retain the content upper bound and test both layout modes by the available surface width. No functional assertions were removed.

Actual 1440px and 390px screenshots exposed a production rhythm defect beyond the failed tests: AppForm's default space-y-5 survived the removal of the local class, creating a 20px gap between the name and policy lists. The settings form now explicitly overrides it with space-y-0. Added browser checks require all adjacent row boundaries to be contiguous except the 1px separator, and equal term insets.

The rail-budget test measured after observing only a visible grid, which can belong to the loading skeleton, then read three separate bounding boxes. CI22 returned a null canvas during those reads while the failure snapshot showed ready content. This supports a render-transition sampling race, not a demonstrated missing stable canvas; a unique historical cause is not proven without an intermediate DOM trace. The test now waits for the real task's public controls and reads frame/canvas/context geometry atomically. Missing children fail explicitly. The dedicated module/GET/ready test remains unchanged, so loading geometry is still covered.
