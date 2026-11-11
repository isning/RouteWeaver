# Fleet request recovery — November 11, 2026

## Reproduced interruption

A public FleetBatchDetail regression reproduces: confirmed execution returns 503 → “重新提交同一请求” → held resubmission. The retry disappeared because it was rendered only while the mutation was in its error state. That removed the pending indicator and the keyboard-owned control. This is an observed DOM defect, not a native-geometry claim.

The same operation now remains visible during error or pending states. Its button retains keyboard focus while exposing busy/disabled semantics and suppressing repeated activation. Success still removes the recovery action. Request ID, payload, confirmation and backend execution rules are unchanged.

The regression fails before the correction and passes afterward, including repeated Enter suppression, a second 503, immediate Enter retry, identical request payloads and explicit success. All 56 tests across fleet feedback, pending operation and continuous-service files pass. Application type checking/build pass. Independent source review accepts the change.

## Native coverage awaiting execution

Two new actual-App tests cover 390px and 1440px. Only the exact loopback synthetic execution endpoint is intercepted; no write reaches the backend or a node. Both cases hold resubmissions, check native focus/disabled semantics, press Enter ordinarily, verify unchanged requests, and then observe explicit successful submission. PNGs and a sanitized count/equality ledger are attached to the Playwright report. Assertions do not dump raw request payloads or request IDs. Strict native-spec TypeScript and two-case discovery pass; native execution and pixel review remain pending CI.

A pre-existing boundary remains: if background batch refresh itself fails, QueryState replaces the batch content. This patch does not claim to preserve recovery through that distinct GET-failure state or to restore focus after successful submission removes the button.

## Populated group decision review

Separate read-only review inspected all 16 original group decision PNGs and both ledgers in exact 59f6205 artifact 13841417265 (ZIP SHA-256 `800f43b328c86718d27c16185bb6a3551aa11af97c24dfb13480f588a97a9281`). The desktop/mobile editor, paired changes, unchanged consent and retained-draft recovery are supported without a blocking visual defect or horizontal overflow. Equal service names are distinguished by stable IDs in the group comparison; both runs contain only the expected stale-apply 409 and no page errors.

At 390px the lower affected-account limit rows scroll away from the account and before/after headings. Retaining identity/direction in that viewport is a further design opportunity, not proof of an incorrect-target action. These older originals do not validate the later duplicate-user identity correction, large memberships, screen-reader behavior, live enforcement or full product acceptance.

## Earlier native feedback without replacing full CI

The existing supplemental recovery lane now includes the two Fleet request-recovery cases: 30 cases in nine files. This is additive feedback while the unchanged full repository gate runs asynchronously. Required jobs, sandboxed vendor Chrome/provenance, permissions, timeouts, one worker, zero retries and artifact paths remain unchanged. The new PNG/ledger attachments travel through the already-uploaded Playwright report.

Updated exact-spec contracts fail before adding the spec and pass afterward (five contract tests). Discovery and independent source review pass. Local tracked-private-file and ticket guards pass. The complete local static gate is not claimed: this workspace lacks a Go compiler, so Go architecture/actionlint stages were not run locally. Remote full CI remains authoritative.

## Native retry capture review and keyboard evidence follow-up

Exact commit `ae91497324ea605538c2ef4c609e4195eb75d595` passed native supplemental recovery run `42996160341`. Artifact `13843823668` ZIP SHA-256: `f9963cae65723a1e04ddf3f75daa3710ea427671305d0a1bec4167dc5143fab0`. Independent inspection of all six original Fleet attachments and both ledgers accepted visible pending/error/retry/success states at 390 and 1440 pixels, count 3, identical requests, no blocked requests, and no retries in the test report.

Those images do not accept settled keyboard-focus ring visibility: the flow initially clicked the retry, and the later repeated-failure image captured only faint transition-edge shading. There was no initial-failure image. The narrow error/retry stayed visible, but the bottom explanatory paragraph was below the captured viewport. The synthetic success fixture leaves target state planned, so this evidence does not establish post-submission target readiness.

The follow-up uses ordinary Tab traversal and Enter to reach and activate retry, adds an initial-failure original, and waits for the control's real finite CSS transitions after two frames before capturing. It does not alter motion, synthesize focus, or wait on the infinite spinner. A sanitized ledger adds active focus, `:focus-visible`, computed shadow, and viewport clearance. Independent source review accepted the approach. Strict native-spec TypeScript and discovery passed. Fresh CI execution and independent original-image review remain pending; viewport clearance alone does not exclude ancestor clipping and computed shadow alone does not prove visible pixels.
