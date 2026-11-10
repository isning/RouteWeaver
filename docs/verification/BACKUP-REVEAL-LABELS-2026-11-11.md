# Backup password reveal controls

## Finding and change

The actual mobile confirmation-error capture from supplemental run 42896088159
at `1968623` was reviewed: labels, error, credential disclosure and footer remain
visible. No layout or palette change was justified. Separately, rendered DOM
inspection confirmed both export password reveal buttons were named “显示密码”.
A button-list user could not distinguish the password from its confirmation.

The two export fields now use the existing PasswordInput `revealLabel` seam:
“显示备份密码” and “显示再次输入的密码”, changing to matching “隐藏…” names when
revealed. No shared component, credential handling, input value, or visible layout
was changed.

## Bounded verification

- New DOM regression failed before the two-prop change because the distinct
  confirmation action was absent (7 existing cases passed).
- Export and inspection recovery DOM suites pass 12 tests after the change.
  The new case uses Enter and Space, verifies only confirmation visibility changes,
  preserves both values and focus, and asserts no network submission.
- Application typecheck/build, strict browser-spec TypeScript, static verification
  and current-source Gitleaks pass. History coverage is not claimed.
- Existing 1440px and 390px browser validation cases now also exercise the distinct
  reveal controls by keyboard. Independent review caught and corrected a locator
  that stopped matching after its accessible name changed; final review found
  no further actionable issue.
- Local Chromium execution remains blocked by the previously established host
  socket restriction; it was not retried or bypassed. Browser checks for this
  patch await CI and are not claimed as passed here.

This is a bounded accessibility correction, not a screen-reader user study or
whole-app accessibility certification. No live data or deployment was involved.
