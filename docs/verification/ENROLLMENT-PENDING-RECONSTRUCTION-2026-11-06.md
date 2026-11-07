# Bounded agent enrollment lifecycle reconstruction

Source-only candidate reconstructed from 4e660eb0e0395a9ae0a0705408cbb56028f0d5d0. Historical ec2baea5dec5fb553f8050963a2d5e0293d7f283 was unavailable. This is not recovery of historical bytes or evidence of historical test results.

## Scope

- Each opened enrollment owns its state. Instance changes or departure dispose it; later callbacks cannot display a token or error in the next enrollment.
- A synchronous submit latch rejects duplicate submissions before pending rendering. Pending Cancel and overlay dismissal are guarded. Request identity and expiry are copied into submission variables.
- Pending navigation uses a consequence-specific warning: leaving does not cancel issuance, old credentials may already be invalid, and the returning token may be lost. A displayed token also registers a departure warning. Requires the companion backward-compatible `useUnsavedChanges(boolean, warning?)` navigation reconstruction.
- Returned token material is kept in the mounted enrollment only, not returned into the mutation result cache. No durable secret storage is added.

## Regression sources

`web/src/infrastructure-creation.dom.test.tsx` exercises the public ServersPage task and HTTP boundary: duplicate submit, pending Cancel/Escape, beforeunload protection, successful token display, and late success/failure after forced unmount and reopening. Existing date-picker submission coverage remains relevant.

## Explicit limits

Lost-response and forced-departure token recovery remain **UNSOLVED**. The backend may have committed even if the client sees an error or leaves. This patch does not add backend idempotency, request reconciliation, rollback, or safe replay. Closing a settled result discards the local token. A warning does not guarantee the user stays, and browser-native unload dialogs use browser-controlled text.

The lifecycle guard is bounded to this mounted UI task, not a durable cross-tab operation lock. An error still permits manual retry; that retry may rotate credentials again. This is not end-to-end enrollment certification.

## Verification

Only local Git/Python/text inspection and `git diff --check` are permitted for this recovery. Node/npm/Go/gofmt, test runners, browser, server, install, network, uploads, push and deployment were not run. All behavioral regression tests, TypeScript/lint checks, aggregate checks, and rendered interaction/accessibility review are **UNRUN**. No red-to-green or runtime pass is claimed.


## Standalone prerequisite and follow-up

The reviewed navigation prerequisite `13d382bd8cef71949261f497ea4da7b840fbfece` was cherry-picked unchanged into this standalone worktree as `c43738d`. It supplies `useUnsavedChanges(boolean, warning?)` and public `getNavigationWarning`. Do not apply both prerequisite copies during composition. Enrollment-owned changes remain separate from this prerequisite.

Additional regression source asserts the pending warning discloses non-cancellation and possible old-token invalidation, that the settled token retains its loss warning, and that an explicit HTTP 400 rejection releases the pending guard while preserving expiry and enabling a manual retry. This control does not establish safe replay after an uncertain response. These tests remain **UNRUN**; only source inspection and Git whitespace checks were performed.
