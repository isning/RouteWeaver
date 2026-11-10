# Backup export dark-token review coverage

The existing export validation journey only captured light desktop/mobile states.
This test-only increment runs that same public UI journey with light and dark
semantic tokens at 1440×1000 and 390×640. A controlled root `dark` class selects
the existing stylesheet; this is not evidence of an application theme selector.
No product layout, palette, validation rules or credential handling changed.

Initial-dialog captures complement the existing invalid-password and mismatched-
confirmation captures. Every capture masks both fields and uses CSS-pixel scale.
Trace, automatic screenshot and video remain disabled. The journey checks invalid
field focus/visibility and the independent confirmation reveal control with
Enter/Space, with no export write. Each case owns an isolated sample workspace.

Strict browser-spec TypeScript and Playwright discovery pass: 17 supplemental
cases across six files, including four export validation theme/viewport cases.
Discovery is not execution. Local Chromium remains blocked by the known host
socket restriction and was not retried or bypassed. CI captures must be reviewed
before drawing visual conclusions or changing production styles. This does not
establish dark-mode accessibility compliance or backup restore correctness.

Static verification and current-source Gitleaks pass (2,353 source entries).
Independent source review found no actionable correctness/privacy issue; this
review did not execute Chromium or judge unproduced dark screenshots.
