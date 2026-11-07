# Policy partial-audit frontend reconstruction

## Provenance and scope

This is a new source-only candidate based on `a1fbbc301378e47489660791e68f8c50fcf2b93f`, not a recovered copy of historical v130 (`f9729fcf77f61dc891fd254750c457e0b46fbcf4`). Historical parity is not established. No backend atomicity, audit persistence, or authorization behavior is changed.

Current source evidence: `internal/httpapi/access_policy.go` calls `ApplyPolicyChange`, handles its errors, and then attempts `Audit`. Only an audit failure after that successful policy operation produces HTTP 500 through `fail` with the exact detail `policy applied; audit could not be recorded`. `internal/httpapi/api.go` serializes this as a JSON detail field; `web/src/api.ts` preserves status and parsed payload in `APIError.details`.

## Candidate behavior

The apply-error callback recognizes only APIError status 500 with that exact structured detail. It does not recognize message/error fields, nearby wording, other status codes, or network exceptions. For the recognized result it requests the same six policy query invalidations as successful apply; existing output-input invalidation remains unchanged. Cache invalidation is before the ownership fence because a committed policy still matters after its editor is gone. Invalidation is a request to refresh, not evidence that a later GET succeeded.

For the current mounted draft owner, the consumed review and its consent are retired. The existing editor ErrorNotice states that platform authorization changed but the audit record could not be saved, directs the user to inspect current authorization and audit records rather than repeat this change, and says current inputs and retained drafts remain. The success-close callback is not invoked: it would discard retained local copies. The existing review-close lifecycle hands focus to the editor warning. A stale response cannot set the replacement editor's error/focus or close it. A deliberate new preview requires fresh consent.

## Authored regression source, all unrun

`web/src/policy-partial-audit.dom.test.tsx` uses real API parsing and React Query with mocked fetch at the transport boundary. The public usePolicyChange consumer harness covers three entity shapes in legacy-replacement mode, draft retention, retired apply, fresh consent, visible policy query refresh, nonmatching structured errors, a matching-message transport exception, an unmounted/replaced owner, a newer draft on the same owner, and ordinary successful close. The same-owner invalidation is a consumer-driven lifecycle scenario, not a claim that the real modal permits typing into its background.

One additional scenario uses the real guarded ServicePolicyEditor and service edit-context/preview fixtures to assert input retention, no close callback, and focus transfer to the warning. There is no new real guarded GroupPolicyEditor or UserPolicyEditor acceptance scenario; their shared hook use was inspected in source only. Retained-copy coverage comes from the public hook harness, not a full guarded-editor conflict/rebase flow.

## Review and validation limits

Self-review inspected the exact server response path, APIError representation, apply ownership/version checks, onClosed success callback, query keys, editor error rendering, and draft-clearing call sites. The implementation keeps the success path and unrelated error handling intact. Independent source review inspected the narrow response classification and ownership checks; executable and guarded-editor acceptance remain pending.

Git whitespace/diff checks and Python text inspection only were performed. No Node, npm, Go, gofmt, test runner, compiler, type checker, browser, server, package installation, network operation, push, or deployment was executed. No failing-before-passing test cycle, rendered UI acceptance, backend fault injection, or full regression pass is claimed.

Unresolved: generic 500/transport/malformed-response outcome uncertainty follows existing behavior and is not solved by this narrow branch. A new preview still uses the editor's existing baseline and may require normal conflict recovery after the committed change. The missing audit record is not recreated. Backend partial-commit atomicity remains unchanged. Future changes to the backend detail contract need coordinated frontend changes. Runtime/type/focus verification and complete guarded editor acceptance remain required before readiness can be asserted.
