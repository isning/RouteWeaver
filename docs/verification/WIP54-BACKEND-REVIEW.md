# WIP54 backend reliability review — 2026-10-31

## Scope and provenance

Reviewed the verified recovered WIP51 source in this workspace, not unavailable
WIP52/WIP53 edits or historical success claims. Read `AGENTS.md`, `GLOSSARY.md`
and ADRs 0001–0003. The recovered local skills directory was absent; the exact
official Matt Pocock reference at commit
`49dd158d1076134a641b33efb035946536778336` was read for TDD, codebase-design,
code-review, tests and mocking. Tests use the repository-agreed public HTTP,
repository and Agent/resource interfaces. Network transport substitution is at
the socket/system seam, not mocked domain behavior.

Go 1.27.2 was installed by the coordinator using the official repository
bootstrap and checksum verification. No deployment, live node operation,
external credential creation, public publication, authentication retry or
sing-box netlink startup workaround was performed.

## Reproduced and repaired

### 1. One-time authentication was not one-time across SQLite handles

`Store.mu` serialized a single handle, but account/invitation validation happened
before the write transaction. Real independent handles reproduced:

- The same TOTP step authorized **two** `Authenticate` calls.
- The same TOTP step authorized **two** `Login` calls and session creation.
- One invitation created **two** accounts while another durable mutation held
  SQLite's writer.

Failing-before tests:
`TestTOTPStepIsSingleUseAcrossStoreHandles` (both operations) and
`TestInvitationIsSingleUseAcrossContendingStoreHandles`.

The fix compares the verified account snapshot inside the writer-reserved
transaction before changing an accepted TOTP step or creating a session.
Bcrypt remains outside the SQLite writer reservation. MFA setup uses the same
account fence; completing enrollment compares its pending challenge and reads
the sessions to revoke **inside** that transaction. `NewSession` also rejects
a stale or disabled account snapshot rather than creating a post-enrollment
session from pre-MFA state. Invitation compare, expiry recheck, account creation
and redemption commit together.

Additional public regressions cover stale session creation after MFA, competing
MFA setup/completion, competing completion of one challenge, and concurrent HTTP
logins. The losing HTTP login remains a fixed `401 invalid credentials` response
without a cookie or record-comparison details.

The invitation writer is held through `GenerateRecord`, a public repository
operation, for a bounded one-second contention window. Competing MFA completion
uses a 100 ms writer window; setup/completion has a 10 ms overlap opportunity
around bcrypt. These tests establish the observed before/after schedules, not
an exhaustive proof of every possible scheduler interleaving. No private timing
hook was added to production code.

An initial suspicion about first-admin overwrite was discarded: the existing
unique `identities.account_id` constraint already prevents that overwrite. It
is not reported as a fixed defect.

### 2. Slow source bodies lost timeout/cancellation classification

The resource fetcher propagated context errors while waiting for headers, but
converted a body-read deadline or cancellation into generic `ErrFetch`. An
offline real HTTP transport over `net.Pipe` reproduced both cases. The change
preserves the context error after an interrupted body read; no partial body,
subscription URL or transport diagnostic is returned. Existing HTTP source
error mapping can now classify a body timeout as `source_fetch_timeout` too.

Failing-before test: `TestFetchPreservesCancellationDuringBodyRead`.

### 3. Agent response interruption bypassed the bounded retry policy

The Agent preserved cancellation before response headers but lost it during
body reads. A socket fixture that writes headers and body separately reproduced
`response_read_failed` instead of `context.Canceled` after the caller had begun
reading the body.

A truncated meter receipt also returned after one request despite
`MaxAttempts: 2`. It now retries the same serialized batch and idempotency key
within the existing budget. Caller cancellation does not retry; incomplete
authorization rejections and redirects do not retry; oversized responses remain
terminal. No quota accounting, unknown-history attribution, meter receipt
verification or durable-outbox acknowledgement rule was relaxed.

Failing-before tests:
`TestOutboundTransportPreservesCancellationDuringResponseBody` and
`TestOutboundTransportRetriesInterruptedMeterReceiptWithSameBatch`.
Further regressions cover exhaustion and authorization/redirect bounds.

## Files changed

- `internal/store/identity.go`
- `internal/store/mfa.go`
- `internal/store/identity_concurrency_test.go`
- `internal/httpapi/auth_concurrency_test.go`
- `internal/resources/fetch.go`
- `internal/resources/fetch_cancellation_test.go`
- `internal/agent/transport.go`
- `internal/agent/transport_interruption_test.go`
- This report.

No `cmd/` or `runtimes/` production change was needed. Source application policy
remains direct auto/manual application, without an additional accept layer.
Publication tokens, frozen files, entitlement/quota rules and unassigned unknown
accounting history retain their existing contracts.

## Verification

Passed against the changed tree:

- All `internal/resources` tests.
- Focused auth regressions plus existing invitation, TOTP replay, durable
  session/reopen and MFA enrollment/revocation cases, then race mode.
- Expanded auth concurrency group repeated three times and under `-race`.
- The new HTTP auth race plus tenant/CSRF isolation, feed rotation/revocation
  and source failure-classification tests.
- HTTP source auto/manual application, bounded change history, output repair
  and platform-credential rotation/republication journeys.
- Agent outbound transport tests, repeated three times.
- Race mode for resource fetch and Agent transport, validation/generation fence,
  restart/no-replay, unknown outcome, lost acknowledgement, lease blocking,
  bounded driver, slow-control-plane lease enforcement and durable meter spool.
- `go vet` for store, resources, Agent and HTTP API packages.
- `gofmt -l` for every changed Go file: no output.
- Full ordinary package invocation `scripts/go.sh test ./internal/store
  ./internal/httpapi -count=1`: passed (store 10.010s; HTTP API 87.716s).

The ordinary package invocation does not opt into native parser/process tests;
their explicit environment-gated skips are not native validation evidence.
The coordinator owns the final combined repository gate after all contributors
stop editing.

Independent read-only review of the authentication changes reported no blocking
transaction, comparison or HTTP disclosure issue, and repeated its focused
store/HTTP checks five times successfully. Its final review is separate from
this author's evidence.

## Remaining evidence boundaries

This is a bounded local reliability review, not a product-wide readiness
certificate. No native runtime process, live-VPS restart, real network source,
deployed enforcement, browser UX or final aggregate gate is claimed here.
Existing restart/publication behaviors were exercised where listed, not
exhaustively audited. Remaining cross-product UI and native-host constraints
belong in the combined delivery report rather than product-facing statuses.
