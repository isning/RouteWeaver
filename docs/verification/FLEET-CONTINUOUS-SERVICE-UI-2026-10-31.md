# Explicit continuing-service UI contract (2026-10-31)

Coordinated with the CP service-recovery implementation; this frontend commit does not itself enable backend renewal/recovery.

- `FleetInput.continuousService?: boolean` is sent explicitly true/false only for start/configure. Every new plan starts false; changing action or deployment clears the choice. Historical true values are never adopted as a new authorization.
- Preview must echo the requested continuing mode. A missing/false response for an opted-in plan, or unexpected true for a one-off plan, is rejected. Checkbox changes invalidate the review and its confirmation immediately; delayed older previews cannot restore it.
- The preview and actual stage-execution decision disclose ongoing reauthorization, three automatic attempts per reviewed intent (5/10/20 second backoff), review requirements for unconfirmed outcomes/changed authority, and that revoked access is not restored. Stop or any non-opt-in replacement disables previous continuing authorization. Backend coordination explicitly confirms even prepare-only install disables previous continuing authorization without immediately replacing/stopping the core; the UI explains expiry of its remaining bounded authorization. Exiting the Agent process alone is not authorization cancellation.
- Agent inspection optionally returns `serviceIntent` with ID, desired-running flag, status, automatic-attempt count, optional next-attempt time and lease expiry. The UI distinguishes this authorization from observed process health, renders known/blocked/superseded/unknown states, polls active service states, and refreshes state after fleet execution. A missing field is presented as no continuing-service authorization, not invented health.

## Checks

Public UI → HTTP red/green regressions cover opt-in absence before implementation, missing blocked-state presentation, rejection of unconfirmed preview mode, and final execution disclosure. Expanded focused run: **42 tests passed in 5 files**, including **15 new tests** in fleet-continuous-service.dom.test.tsx plus fleet-publication, fleet-feedback, fleet-pending-operation and fleet-model regressions; one worker, exact-lock dependencies. TypeScript and diff checks passed.

Three 320/390/desktop browser preview-only tests were collected with Playwright `--list`. They were **not executed locally** and generated no new screenshots; authorized private CI must establish their rendered/focus result. No real batch, service authorization, node recovery, or process action was performed. Backend and integrated tests remain separate coordinator gates.
