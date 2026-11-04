# CI30 responsive task review

CI30 reported three session-recovery failures and one users-table action-context failure. The failing session snapshots show an authenticated workspace and the navigation-drawer trigger, not an authentication failure. The native CDP harness explicitly sizes the first page at 1280 but creates secondary tabs without a viewport override. Those tabs previously happened to display a sidebar; after the responsive threshold moved to 1023, their default browser-window size instead displays the drawer.

The cross-tab desktop identity journeys now explicitly size secondary tabs at 1280. Their real server logout/login, concealed draft retention, identity replacement, trusted focus, and no-automatic-write assertions are unchanged. Account lookup uses the workspace navigation's stable identity instead of assuming the desktop `aside` role. A separate 900px native journey opens the drawer, verifies the account identity and keyboard access, closes it with Escape and checks trigger focus, then reopens it and completes a real logout.

At 900, removing the desktop sidebar gives the users table enough space for its 700px minimum. That is expected responsive behavior, not loss of the scroll affordance. The test now explicitly expects the fitting users-table state at 900, checks available width and the drawer trigger, and retains required horizontal overflow, nonzero scroll movement, keyboard-visible action buttons, and target labels at 320/390. Other route/width expectations remain unchanged.

The actual CI30 320px initial-viewport profile screenshot was inspected: the index is below the save strip, not obscured. The full-page capture alone cannot prove a sticky-header defect. New 320/390 checks traverse every index button with Tab and record scrollY, focus geometry, sticky-bottom geometry, and `elementFromPoint` hit testing; the runtime-tab target is checked too. No scroll-margin change is made without a failed user-task check.

Local validation: changed browser specs type-check. Browser execution remains delegated to authorized CI because local Chromium is restricted. These fixes are not yet a passing CI claim.
