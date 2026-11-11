# Prepared native theme and graph evidence

The existing two theme preference cases remain. Four additional synthetic cases
cover light/dark system-theme emulation at 1280 and 390 pixels. The sample now has
two connected nodes and an uncontrolled edge so React Flow owns real selection.
Tests use public zoom controls and actual Tab/Enter/Escape navigation, preserving
normal motion. No injected theme class, scripted focus or replacement styling is
used. The actual UIProviders theme setup applies the browser preference.

Expected original and selected screenshots retain the viewport, not a reconstructed
or full-page image. A sanitized ledger contains synthetic colors, geometry and
zoom values. API requests are aborted and recorded only as generic occurrences;
no account data, URL or body is collected. Automatic traces/video/captures remain
disabled. These cases do not validate custom production edges/markers, reconnect,
portal dialogs, all graph interactions or every element's viewport visibility.
Token equality is not a contrast-quality proof.

Strict native specification TypeScript, sample TypeScript, six-case discovery and
whitespace checks passed. An initial temporary configuration outside the web tree
could not resolve its type packages; the equivalent local temporary configuration
resolved them and passed, then was removed. Independent source review accepted
the three-file native delta with no blocker. No browser has executed these new
cases and no screenshot/ledger output exists yet. Call this prepared evidence,
not visual acceptance. Production/DOM code is unchanged from the published
4,108-test checkpoint. Actual CI/browser execution remains required.
