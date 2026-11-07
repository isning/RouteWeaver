# Diagnostic request recovery reconstruction (source only)

Status: candidate reconstructed from baseline `a1fbbc301378e47489660791e68f8c50fcf2b93f`, not recovery of historical commit `d1dae3d`, not v101 parity or product acceptance. All executable behavior, TypeScript, lint, build, browser, backend and traffic checks are **UNRUN**. Only Git diff/whitespace and source inspection were performed. No installation, server, diagnostic traffic, network, upload, push or deployment occurred.

## Existing contract inspected

- `internal/httpapi/diagnostics.go:54-73` accepts a client request ID and exposes exact-ID GET. POST passes the authenticated account ID to the store.
- `internal/store/diagnostics.go:97-105` reuses a stored request only when its digest and requested actor both match. This candidate does not use that contract to replay POST.
- `internal/diagnostics/model.go:59-76` serializes the original request and `requestedBy`. These permit acknowledgment checks without a new backend endpoint.
- `internal/store/diagnostics.go:144-150` can reject a full node queue before writing a job. `internal/httpapi/api.go:253-261` maps ordinary errors and miscellaneous transaction errors to generic HTTP 400; it supplies no definitive non-submission receipt. A failed POST and a subsequent 404 therefore cannot safely unlock automatically.
- `internal/store/diagnostics.go:154-191,213-223` GET may settle an expired job. Reading a job acknowledges the submitted request; it is not proof of successful execution, zero traffic, cancellation or current applied-path health.
- `web/src/SessionLifecycle.ts` owns authentication, active phase, account epoch and generation. `web/src/api.ts` guards asynchronous responses. The reconstruction reuses those owners, never persists CSRF/session tokens, and adds no backend lock or authentication state machine.

## Candidate behavior

`web/src/useDiagnosticRequest.ts` stores one actor-specific same-tab session record before POST, strictly allowlisting version, actor, request identifiers, path mode, kind and numeric limits. It stores no URL, connector/native configuration or secret. Unavailable storage fails closed before submission. A synchronous current-record guard blocks duplicate submit callbacks; persisted ownership is checked again before dispatch.

The editor entry remains available even when current targets/instances are absent so pending recovery is not blocked by changed inventory. The editor restores that record after remount/reload, hides mutable submission controls while pending, and reads only the exact encoded request-ID GET on explicit recovery. It checks every saved request field and requested actor before accepting the response. 404, malformed/mismatched replies and all unclassified failures remain unknown. No automatic retry, POST replay or cancellation is added. A successful read clears only the exact still-owned record and opens the existing result flow, which separately renders execution status.

Actor changes conceal the old record without deleting it. Returning to the same actor can recover it. Account/generation changes invalidate outstanding completions and confirmations, release obsolete local busy state, and retain the durable unknown record. Closing the editor does not cancel the original request. The optional session hook permits read-only isolated rendering, but submission is unavailable without the real session boundary.

## Deliberate bounded deviation from historical summary

The retained historical summary mentioned corrupt-record discard, not an exit for valid permanently unknown requests. Source review exposed a dead end: a pre-creation rejection leaves no GET-able job, while 404 cannot prove no submission. To avoid locking the actor/tab indefinitely without inventing a backend rejection contract, this reconstruction adds an **explicit local abandon decision for valid records** as well as corrupt records.

The valid-record confirmation names request ID and target, says the original may still run or have consumed traffic, says clearing does not cancel it, and warns a new submission may duplicate traffic. Clearing loses this tab's recovery record and resets this window's test settings; the confirmation explicitly discloses both. It never sends a POST, never marks the old job failed/cancelled, and never implies absence. The editor assigns a fresh request ID and resets consent; only a separate explicitly confirmed form submission can send another test. Both discard paths capture actor, account epoch, generation, local operation epoch and exact raw bytes when opening confirmation, then recheck before deletion. The action is disabled during the currently owned request.

This tradeoff is not recovered v101 parity. Cross-tab/browser deduplication and persistence after closing the tab are not promised. The backend remains authoritative for actual traffic execution and idempotency.

## Regression source and review

The agreed seam is rendered public UI plus controlled fetch/session-storage boundaries. `web/src/diagnostic-request-recovery.dom.test.tsx` supplies source cases for persistence-before-send, secret exclusion, remount and 404 retention, exact-ID reconciliation, no duplicate POST, denied persistence, corrupt cancellation/confirmation, mismatched IDs/actors/limits, delayed actor changes, stale account/generation confirmations, valid abandon cancel/no-delete, confirmed abandon/no-POST, and fresh explicit submission with a different ID. Existing managed-path/workspace tests now use the real session boundary and expect unknown recovery instead of blind retry.

No red/green cycle was executed. Cases were authored as public-seam regression source under the execution restriction. An independent source review found (1) the generic-error permanent lock and (2) contradictory possible-traffic copy on known pre-send storage failure. Both were addressed in source: explicit local abandon and distinct storage-unavailable copy. Additional source review found the stale discard ownership gap; confirmations now bind to their opening owner. A second independent source-only delta review found no remaining concrete blocker in those changes. This is not a full independent runtime or design acceptance.

## Remaining scope and acceptance gates

- Numeric raw-input precision is the separate missing v124 scope. This reconstruction validates already-materialized safe integers but does not repair `Number(event.target.value)` lexical rounding/precision loss in the original fields. Do not claim precision remediation.
- Same-tab records are nonsecret but remain in sessionStorage until acknowledged, explicitly abandoned or browser-cleared. Another actor cannot operate on the original record through this UI; this is not protection against hostile same-origin script/browser access.
- New backend definitive-outcome receipts would improve refusal recovery, but are not introduced here. Explicit abandon carries a real duplicate-traffic tradeoff rather than hiding it.
- Required follow-up when execution is permitted: focused DOM tests (one worker), TypeScript/lint/build, storage cleanup failures, malformed successful response variants, same-actor unresolved-fetch recovery, actual browser reload and narrow layout/focus review, then serialized aggregate verification. None are passes here.

## Follow-up: delayed form completion ownership

Local abandonment synchronously marks the old editor task retired, then replaces the keyed editor component and its form instance. Old validation can only reach callbacks from the retired instance; every submit callback checks retirement before recovery can dispatch. The new editor has a new request ID, blank settings and unchecked consent. It requires a fresh explicit submission. This does not rely on rc-field-form keeping the callback or values captured at validation start.

Input edits additionally replace the current request ID synchronously before scheduling a React update. Submitted values carry a nonsecret form-only ownership marker and submission checks current consent; that defense is not claimed to establish validation origin by itself. The marker is not part of the POST or persisted recovery request.

A source-only repeated-submit/abandon/fresh-consent regression exercises real asynchronous validation but does not deterministically hold a private onFinish callback until after abandonment. That exact adversarial ordering is source-reviewed, not dynamically demonstrated; no internal form mock was added to manufacture the ordering. All executable checks remain UNRUN.
