# Explicit destinations for new rules

## Model and interaction

New rules require an explicit destination, rather than silently routing directly or inheriting the default. Existing loaded rule actions remain unchanged. The editor alone permits `DraftRule.action: ActionRef | null`; `null` is truthful incomplete intent in the same authoritative draft, not a hidden second rule list or a selected valid action concealed behind UI state. Persisted IR/API types remain unchanged.

The normal placeholder is neutral. An attempted save/check shows “请选择此规则的流量去向” inline and focuses the first incomplete rule after changing tabs if necessary. Error visibility is feedback only; choosing a destination or deleting its rule clears that field's error. Newly added untouched rules are not immediately red.

The incomplete rule remains visible in JSON, survives tabs/reordering by identity, and marks the draft dirty. Canceling navigation keeps it. Missing/malformed action JSON is retained in the text editor with an error, without replacing the prior accepted tree. The conversion boundary rejects incomplete/malformed actions before save, save-and-check, or technical preview mutates cache state or sends requests. It never defaults, drops, reorders or coerces rules. Unknown string action kinds and extra fields remain for backend validation; this is not a new full JSON/domain parser. Existing request-name normalization remains explicit in the request payload function.

## Repairing a selected subscription

A publication session retains its last complete handoff profile and explicitly selected device while repair edits are incomplete. It stays mounted but suspended while repairing or revision-mismatched. Only a successful explicit complete save/check hands off the current profile. Returning to Android does not silently choose the preferred MacBook or reuse a stale preview: confirmation is disabled until a fresh check for Android. The retained snapshot is review context, not a parallel editable draft.

## Reusable verification method

Test through public editor actions and owner API boundaries: local incomplete save must cause no write and no comparison invalidation; explicit completion must preserve all chosen fields/order and unrelated default behavior. Test the whole repair session, not just an isolated selector: choose nonpreferred Android → repair → incomplete rule → complete it → save → return → fresh Android preview. Verify keyboard focus after animation settlement and real touch emulation separately from viewport-only mouse tests.

Error-text contrast uses computed CSS foreground/background, not screenshot antialiasing. The original14px `rgb(255,77,79)` on white measured3.267743233071127:1. The local existing `.profile-field-error` now uses Ant red7 (`rgb(207,19,34)`), measuring5.571286067441564:1. Explicit error text makes the meaning independent of color. [WCAG2.2 Understanding Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), consulted2026-10-23, requires4.5:1 for ordinary text; thresholds are not rounded. This is one bounded text/background check, not a whole-product conformance claim.

## Evidence and limits

- Old initializer RED sent a direct-action PUT when an incomplete rule should block. Corrected pure/public destination tests:22/22 pass; existing validation/input/content tasks:52/52 pass.
- A separate lifecycle RED lost the selected Android dialog after incomplete repair; corrected public regression passes, including disabled return confirmation and fresh Android `outputId`.
- Real local1440 keyboard and390 touch tasks pass: no write while incomplete, unchanged saved record, settled focus at the destination, exact chosen action saved, default preserved.
- Real desktop cross-device repair passes. Initial typed422 was deliberately injected; the fresh Android preview used the real backend. No publish occurred and both Output records remained unchanged.
- The existing strategy/revocation browser task passes after explicitly choosing direct. Five obsolete saved-status test locators were migrated to the owned public save/check group with identical assertions; all five affected named browser cases pass. Existing profile-intent suite:38/38 pass without fixture/action changes.
- Typecheck and exact-build browser gates pass. Earlier test-only unsupported selector typing and hidden-dropdown ambiguity are preserved as harness failures, not product RED proof. Historical full-suite failures remain failures; these focused passes do not replace a full-suite run. No live deployment, native client application, or user study is claimed.
