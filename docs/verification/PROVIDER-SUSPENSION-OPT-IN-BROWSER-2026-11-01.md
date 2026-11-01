# Provider suspension opt-in — bounded browser candidate

Base: `e327c4c` (new `work/provider-optin-browser-20261101` worktree; provider author's worktree untouched).

One new browser case: [`provider-suspension-confirmation.ui.spec.ts`](../../web/tests/provider-suspension-confirmation.ui.spec.ts).

The real App opens the exact administrator host detail, resource/allowance section, `NodeObservation` and `ObservationConfigForm`. Synthetic read-only HTTP supplies an owned managed-Xray instance and unknown provider usage with an advisory policy. The user explicitly selects suspend-managed and invokes the named task-footer save action.

At **320×844**, the case asserts:
- Exact host identity in the opt-in heading.
- Full freshness/unknown/expired-cycle refusal, short-lease connection consequence, manual statement freshness, uncontrolled stock/external credentials, no automatic exit switching, recovery and old-version backup/data-downgrade consequences.
- Complete heading/description and both decision actions in the viewport, no dialog/document horizontal overflow, and a named screenshot artifact.
- Safe-default **返回修改** focus; cancel twice restores the exact editor-footer save control and preserves the selected policy/provider name.
- No mutation request, external request or unexpected read; it never confirms enabling the policy.

Selectors use exact named dialogs and explicit dialog/alert-dialog footer slots, not ambiguous generic Close controls. No production code changed.

## Verification

- Typecheck: **PASSED** (`/tmp/provider-browser-typecheck.log`).
- Browser discovery: **1 test / 1 file**, PASSED (`/tmp/provider-browser-list.log`); this does not execute a browser or server.
- Relevant tests: **4/4 ObservationForms DOM + 3/3 observability-model tests PASSED**, one worker per invocation (`/tmp/provider-browser-dom.log`, `/tmp/provider-browser-model.log`).
- Prettier/source diff checks: PASSED.
- **Native browser geometry/focus timing: UNRUN**. Local Chromium and new CI/push were not authorized for this worker. The next coordinator-authorized CI must execute the candidate before its geometry or screenshot can be claimed as evidence.

The HTTP fixtures are UI-only evidence. This case does not establish backend enforcement, provider freshness acceptance, mutation persistence, native Linux behavior, or rollback safety; those remain the provider implementation's separate evidence.
