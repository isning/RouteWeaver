# React warning audit, 2026-11-05

Scope: warnings from [CI50's frontend job](https://github.com/isning/RouteWeaver/actions/runs/41862137337/job/126686537311), not a new full-suite or deployed acceptance claim. The job passed, but its stderr exposed the following cases.

## Findings and changes

- **Optional filter reset:** tracing the remaining controlled/uncontrolled warning found that resetting name/region conditions to an empty filter left the old text visible. Both optional text fields now render absent values as an empty string, without modifying the underlying filter object. A failing-before-passing regression checks the visible values after reset.

- **Repeated fixed members:** `group-membership.dom.test.tsx` deliberately retains two `endpoint:north` references. The multi-select gave both chips the same React key, and removing either chip removed every matching reference. Each chip now has a value-and-occurrence key, and its remove action deletes only that occurrence. Opening or changing unrelated policy still preserves the original references and order; no input deduplication was introduced.
- **Credential reveal cancellation:** `UserEntries` reset a form before an editor existed, including while cancelling the initial credential read or closing the entry sheet. Resets now require an existing editor. An accepted reveal still resets the store before filling the newly selected entry. Existing request ownership, cancellation, stale response protection, and unsaved-change confirmation remain in place.
- **Subscription list key:** the cached-access and selected-subscription tests omitted the output's `profileId`, producing an undefined group key. The HTTP output view always includes `profileId`. These fixtures now include an unavailable profile identity, preserving the intended missing-associated-profile behavior. Production subscription grouping was not changed to invent an identity for an invalid fixture.

No console warnings were suppressed globally or replaced with weaker checks. Regression tests capture, rather than silence, the relevant warning channel.

## Verification

Before the changes:

- Repeated-chip removal returned only `south` instead of `north, south` and emitted the duplicate-key warning.
- Cancelling the first credential reveal emitted the disconnected-form warning.
- The cached-access fixture emitted the missing-list-key warning.

After the changes, this focused command passed **62/62 tests in seven files**, with no test stderr warnings:

```sh
npm --prefix web run test -- --maxWorkers=1 --reporter=verbose \
  src/choice-select.dom.test.tsx \
  src/user-entry-task-ownership.dom.test.tsx \
  src/group-membership.dom.test.tsx \
  src/task-experience.dom.test.tsx \
  src/rotation-recovery.dom.test.tsx \
  src/line-workflow.dom.test.tsx \
  src/pipeline-controls.dom.test.tsx
```

Type checking (`npm --prefix web run typecheck`) and `git diff --check` also passed on the shared working-tree snapshot. A separate read-only source review found no actionable issues. A populated-credential A→close→B regression additionally verifies that B has empty credential fields and that saving B does not transmit A’s credentials.

These are functional DOM tests. They do not replace final combined-source type checking, the full repository gate, browser/native acceptance, or production acceptance.

## Other CI50 warning sources

The same job also reports intentionally duplicate rule IDs in `profile-validation.dom.test.tsx` and duplicate column IDs in the data-table remeasurement fixture. They are separate from these three investigated paths; this change does not claim that every CI50 warning has been eliminated.
