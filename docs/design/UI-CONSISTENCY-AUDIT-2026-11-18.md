# Page consistency review — 2026-11-18

## Scope and reference

The requested reference is the redesigned platform settings page: restrained shadcn surfaces, clear groups, one primary action per context, independent setting edits, responsive content widths, and semantic theme tokens. The visual reference remains [Refactoring UI](https://github.com/edisonmbli/refactoring-ui-skill); product copy follows [CONTENT-DESIGN-RULES.md](CONTENT-DESIGN-RULES.md).

This review covers every navigation entry, the legacy route entry, notification and platform-settings tabs, and representative creation dialogs. It does not claim that every populated diagnostic state or every editor combination was visually reviewed.

## Findings and changes

| Area | Observed difference | Resolution |
| --- | --- | --- |
| Shared sections | Content cards had different heading weights and padding from platform settings | Align section headings, responsive padding, and quiet surfaces with settings cards; retain plain sections for inventories |
| Empty states | Materials had a bordered component, other pages floated on the page, user groups used a dashed text strip, and tables sometimes showed only a string | Use the shared EmptyState throughout inventories; string table empty states also use the component; suppress redundant borders inside cards and table cells |
| Account security | Old right-hand section index reserved space and produced a different form layout | Center the task at the same width as platform settings; retain semantic sections, forms, recovery behavior, and draft ownership |
| Notification settings | One large card contained reminder rules, external-channel accordions, and the save decision | Group reminder rules, email, Webhook, and save actions into distinct matching surfaces; preserve mounted channel fields and their validation/focus recovery |
| Notification lists | Announcement and delivery cards differed from other inventory pages | Use the same plain inventory sections and tab spacing |
| Loading states | Account and notification settings used different placeholder widths from their loaded forms | Match the new centered settings layout before data arrives |
| Templates and servers | Different tab-to-content spacing; template counts used authored dot separators | Align top-level tab spacing and group counts with layout rather than punctuation, without changing tab behavior |
| Service rates | Empty records were a single unstructured sentence | Use the common empty state and retain the default 1× accounting consequence |
| Log collection settings | Expanded settings used an older small bordered panel, with no expanded-state semantics | Align panel spacing/surface, add aria-expanded/aria-controls and reduced-motion-aware entrance animation |
| Accordion motion | Shared accordion animation did not declare a reduced-motion override | Honor prefers-reduced-motion |
| Account password copy | Persistent guidance exposed byte encoding details | Use ordinary password guidance; retain the exact byte-based validation, with actionable length errors |

## Page inventory

| Entry | Review result |
| --- | --- |
| Overview | Retain usage and account hierarchy; no page redesign needed in observed states |
| My subscriptions / profile and output aliases | Retain onboarding and editing workflow; shared sections inherit the new surface treatment |
| Subscription sources | Shared inventory empty state; source-import dialog reviewed at both widths |
| Node collections | Shared inventory empty state; processing-stage tabs retain their intentionally scrollable rail |
| Rule resources | Shared inventory empty state and existing search/table components |
| Templates and presets | Shared empty state and aligned tab spacing |
| Servers | Shared empty state and aligned inventory tabs; creation dialog reviewed |
| Connection endpoints | Shared inventory/table presentation |
| Forwarding paths | Shared empty state; path-creation sheet reviewed |
| Legacy route configuration | Shared inventory/table presentation |
| Published routes | Shared inventory empty state |
| Users and groups | Shared tables and user-group empty state; user-creation dialog reviewed |
| Service plans and rates | Shared surfaces and rate empty state; plan-creation dialog reviewed |
| Announcements and notifications | Inventory and settings layouts unified; reminder, email, Webhook and delivery tabs reviewed |
| Inbox | Shared inventory empty state |
| Account security | Centered settings layout and shared surfaces |
| Platform settings | Reference retained; basic, security and backup tabs reviewed |
| Change history | Shared tables and empty states |
| Execution tasks | Shared history/empty-state presentation |
| Login and invite registration | Retain the existing staged form; responsive entry layouts reviewed separately |

## Rendered evidence

T3 Preview could not start because host libraries were missing. A Nix-provided Chromium was used through the repository's installed Playwright package instead. No host browser setup scripts were installed.

Local evidence is under `bin/ui-audit-2026-11-18/` (ignored, local only):

- `before.json`: 17 entries at 1440 px and 390 px, 34 captures, no page overflow or JavaScript page errors
- `after.json`: 19 entries plus notification/settings subviews, both widths and both color schemes, 100 captures, no page overflow or JavaScript page errors
- `tasks.json`: refreshed account/rate pages and five creation dialogs at both widths, 14 captures, no page or overlay-body horizontal overflow or JavaScript page errors
- `entry.json`: eight separate login and invite registration captures, both widths and color schemes, no page overflow
- `inventory.json`: filtered users and clearing search at both widths, no page overflow
- `breakpoints.json`: 14 additional 320 px and 768 px checks on the main settings, account, notification, user, service, server and subscription tasks, no page overflow
- `loading.json`: delayed notification-setting reads at 390 px and 1440 px; the loading placeholder and loaded form share the same left edge and width (358 px / 896 px)
- Matching PNG files record the rendered states; `capture.mjs`, `after.mjs`, `tasks.mjs`, `entry.mjs`, `inventory.mjs`, and `breakpoints.mjs` describe the capture procedures

The local demo mostly contains empty inventories. Populated users, account sessions and audit history were observed; populated server diagnostics, loaded rule-resource inventories, and all graph/editor permutations were not visually exercised. Creation dialogs were opened without submitting data. No production nodes or external services were changed.

## Verification

- Typecheck and production build passed on the final source; build output is in `bin/ui-audit-2026-11-18/build.log`.
- `scripts/verify.sh web` completed its typecheck and full behavior-test stage: **4843 passed, 124 failed, 406 files**. The test stage failed, so that invocation did not reach its production-build stage; the production build was run separately and passed.
- The full-suite result is a checkpoint before the final targeted assertion updates. Failures include assertions about the removed application footer, obsolete settings directory/domain-draft controls, earlier source/collection editor controls and earlier subscription/profile flows. These were not resolved by restoring retired UI. Not every failure has been independently triaged, and this review does not claim a passing full suite.
- A notification loading/recovery test depended on the announcement container being a Card; its container lookup now supports the plain section while retaining its loading, error, retry, empty-state and request-count assertions.
- Account-password validation still tests the UTF-8 byte boundary and matching confirmation before any write; its error assertion now expects the actionable length message.
- Workspace-width assertions now classify the template and collection tables correctly, and the alias-loading contract covers the actual subscription aliases instead of the independently redesigned settings page.
- Final focused regression: **295 tests passed across 29 files**, one worker. This includes account security, notification drafts/conflicts/testing, loading recovery, settings continuity, shared presentation, table/search interactions, user groups, log collection settings, rates, motion, workspace aliases, template discovery and separator policy. Output: `bin/ui-audit-2026-11-18/focused-final.log`.

Browser overflow checks are separate evidence from visual comprehension and behavioral tests. Independent review was not performed.
