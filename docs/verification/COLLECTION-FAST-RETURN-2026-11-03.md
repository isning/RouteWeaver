# Collection fast source-task return

CI22 existing-source-selection failed its return-to-Add-source focus assertion. The report establishes a missed focus target, not a uniquely proven scheduling history.

A public DOM reproduction retains the actual Radix Sheet Presence through its exit-animation computed-style boundary (no mocked overlay). Returning before that retained Sheet unmounts does not fire Radix mount autofocus again. The existing Collection owner restored focus only from onReady, so cancellation/repair can return with body focus. The controlled baseline failed; the same test passed after an owner-scoped return effect. The test retains all rich draft, reorder, cancellation target, successful fallback, no-parent-write and preview payload checks.

The effect runs only for the current Collection session's pending return, checks that no newer source task owns the session and that focus has not moved since the return commit, then resolves the live logical target. The existing onReady path remains for remounted Sheets. No timeouts, animation disabling, broader focus policy, or dropped browser assertions.

An earlier held source-list GET experiment passed without a fix; it did not substantiate a stale-catalog explanation and was not retained as the diagnosis.

Verification: 32 tests across existing-source-selection and collection-source-task passed with one worker; application TypeScript passed. Real browser CI remains required. The local browser restriction was not retried.

Independent review tightened the compensation to body-only at both commit and microtask: an already-focused control is never reclaimed by this new path. A new real-TaskDialog test holds the source PUT, opens/focuses a newer task before completion, then verifies that completion leaves its focus intact. It passes with both the initial candidate's hidden-target guard and the body-only refinement, so it is coverage, not evidence that the earlier candidate actually stole that modal's focus. The retained-Presence reproduction still passes. Final counts: 33 tests in the two files, application TypeScript passed.
