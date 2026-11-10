# Backup export lifecycle

Baseline: `3e7dd47033412128e4cadbd8b5a21552e7db6054`.

## Findings and correction

- Leaving the backup page did not retire an in-flight export. Its later success could initiate a download and announce success from a page the user had left.
- Mutation variables retained both password fields. Export now hands the request a one-use local password snapshot and retains only an attempt ID in mutation variables. Automatic retry is explicitly disabled, even when the shared client enables it.
- Dismissal, replacement and unmount retire the task. Repeated submission cannot start a second request. Failures preserve the visible form for an explicit retry.
- Independent review identified that cached callbacks could still retain the unmounted form store. The export form now uses the form library's `clearOnDestroy` contract, clearing its stored field values on unmount. This is a bounded retention improvement, not a JavaScript memory-zeroization claim.

## Verification

- Running the two new DOM cases against baseline production code fails: the abandoned archive creates a download URL, and mutation variables expose password/confirmation rather than only the attempt ID.
- Five focused files pass all 50 cases: export UI/API, inspection recovery, restore outcomes and capacity. The export retry case also verifies that client-wide retries do not resubmit this request.
- Application TypeScript, production build and `scripts/verify.sh static` pass, including 102 offline helper cases, architecture guards and pinned actionlint.
- An independent source review found the retention issue above and no additional concrete blocker. Dependency inspection confirmed that superseded form validation is rejected.
- A browser regression adds same-document navigation away from a delayed export, a new task, the abandoned response, and exactly one download from the current request. Discovery and strict browser-file TypeScript pass. Local Chromium launch failed before any browser interaction at the host's `socket()` restriction (`Operation not permitted`); no sandbox setting was relaxed. Browser execution remains pending exact-commit CI.

No full-suite, actual-pixel, encryption, live-node, deployment or production-data claim follows from this slice. Existing real-backend backup acceptance remains separate.

## Keyboard validation follow-up

At `417885b`, submitting an invalid export from the keyboard left focus on the
submit button. The first missing or mismatched field could therefore remain
outside the user's current view. A new public-form regression reproduces that
failure before the correction.

The export form now opts into the existing task-owned error-focus recovery,
using its current export owner. It focuses the first visible invalid input only
while that submission still owns the interaction. It neither submits invalid
values nor reclaims focus after the user changes controls or reopens the task.
The field's existing focus handler remains responsible for scroll visibility.

All 34 tests across export and shared form-recovery suites pass, including
keyboard correction, mismatch correction, new-control and reopened-task cases.
Application and browser-file TypeScript, production build, static verification
and source-tree secret scan pass. Two browser cases add focused-field visibility,
occlusion and masked captures at 1440×1000 and 390×640; all three export browser
cases are discovered. Browser execution and actual-pixel review remain pending
CI because of the same unchanged host startup restriction. This follow-up was
source-reviewed locally; it has no additional independent review claim.

## Preserve browser feedback during incremental pushes

The `90990d0` full run was superseded before reaching the new export-lifecycle
file. Its existing real-backend encrypted download/restore journeys did pass at
1440 and 390 pixels, but that does not prove the new lifecycle/focus scenarios.

The three new browser cases now use a fresh test-owned normal control-plane CLI
and normal UI login, and join the bounded supplemental visual workflow. Its
existing running job is allowed to finish while later pushes replace only the
pending job. No shared demo cookie, added server endpoint, retry, timeout or
weakened full gate is introduced. Traces/video/automatic screenshots remain off;
the explicit focus screenshots mask both password fields.

The workflow contract fails before adding this sixth isolated spec and passes
afterward. All 102 static helper tests, architecture checks and actionlint pass;
application/browser TypeScript and discovery confirm 15 supplemental cases.
This is verification scheduling, not a new successful browser execution claim.
