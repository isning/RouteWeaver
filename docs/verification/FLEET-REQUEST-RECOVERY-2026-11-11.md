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
