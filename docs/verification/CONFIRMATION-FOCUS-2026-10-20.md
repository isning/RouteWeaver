# Non-destructive confirmation focus

Actual browser review of the server-route editor showed the discard dialog initially focused “放弃修改”. The policy-only fix did not cover other editors. All remaining explicit modal confirmations now initialize focus on their cancellation/preservation action, including draft discard, deletion, subscription rotation, runtime execution and notification confirmation. Actions and authorization checks are unchanged.

A public user-task regression was strengthened to assert Continue Editing receives focus and Enter preserves the unsaved route draft. It failed before the change (15 pass / 1 fail), then the focused public-onboarding, policy and recovery suites passed 47/47. Typecheck and diff check passed. This is not an independent review or exhaustive keyboard/browser proof for every dialog.
