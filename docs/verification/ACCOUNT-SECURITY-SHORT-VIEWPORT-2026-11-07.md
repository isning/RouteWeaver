# Account recovery: short-viewport evidence preparation

Base: `c55e172156bde5114d71fcc4ac27dbdc515c9589`. This is a test-only supplement, not rendered acceptance or a production fix.

## Changed checks

- Keep the existing 320×360, 390×844, 640×400 and 1440×1000 cases and forced-password-change isolation test. The loopback-only synthetic GET fixture and denial of unexpected API writes/external requests are unchanged.
- Reach the account opener and recovery controls using native Tab, then open with Enter. Traverse the unchanged default disable action, empty concealed password and empty authenticator field, Cancel and the destructive button. Never enter credentials, reveal a password, change an action or submit it.
- Reuse `settledTask` to observe natural finite motion and opacity before captures; wait for fonts before entering the task. No sleeps, motion disabling, CSS overrides or timeout changes.
- Capture separately labeled `initial-identity`, `password` and `final-decision` PNGs. Each has a JSON attachment with actual viewport, scroll mode and clipped geometry for the target name/login, full consequence and destructive action. Short frames are not presented as showing everything simultaneously.
- Require the complete initial target name/login and the complete final disable consequence, Cancel and destructive button within their visible clips. Preserve the exact accessible target name/login at the final action. Shift+Tab returns to Cancel; Enter dismisses without a write and focus returns to the original opener after settling.

## Source concern and acceptance boundary

`AccountRecoveryTask` places target name/login in the header and the consequence/actions in the footer. Whole-task scrolling at short heights can move the header out of the decision frame. The new attachments record that explicitly; they do not treat an accessible name as visual identity evidence. Review the two frames together and decide whether the sequential target context is understandable. No production change was made without actual rendered evidence of a need. Historical translucent captures are not evidence of a CSS defect.

This supplement covers the unchanged default **disable** decision and cancellation, not submission, other account actions, complete keyboard/screen-reader acceptance, reduced motion, real-backend recovery or live accounts. A passing test alone does not establish comprehension.

## Local verification and remaining work

- Passed: `node --check web/tests/account-security.ui.spec.ts` using Node v24.22.1 (syntax only; does not load dependencies or typecheck).
- Passed: focused `git diff --check` and a static comparison confirming the fixture, four viewport values and forced-change test remain unchanged, with no direct focus, field entry, motion override, sleep or timeout extension added.
- Not run: TypeScript, Playwright collection/execution, screenshots and full verification. This checkout has no `web/node_modules`; no dependencies were installed or borrowed from another checkout. No red/green browser result is claimed.
- Next: authorized CI must execute the focused file with one worker, preserve its attached PNG/JSON evidence and inspect actual initial identity and final decision at every size. Any clipping or target-context concern remains open until those artifacts are reviewed. The coordinator owns integration gates.

Repository instructions, content rules and the available pinned TDD/tests/mocking references were read. Public seams remain rendered user tasks and the existing controlled API boundary; no private component mocking was introduced.
