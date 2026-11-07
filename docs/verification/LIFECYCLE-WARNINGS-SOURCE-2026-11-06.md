# Account lifecycle and managed-entry stop warnings: source reconstruction

## Status and provenance

Source-only candidate reconstructed on 2026-11-06 from recovered v88 baseline
`a1fbbc301378e47489660791e68f8c50fcf2b93f`. This is not the recovered patch for
missing historical v135 (`6d76dd3`) or v137 (`ad1577e`). Their exact source and
test results were unavailable. The baseline checkout remains unchanged; this
candidate is preserved on a separate reconstruction branch.

No Node, npm, Go, gofmt, browser, backend, native runtime, network, installation,
publication or account action was executed. Dependencies are incomplete.
This note does not certify page acceptance or deployed enforcement.

## Standards and agreed seam

Read AGENTS.md, GLOSSARY.md, docs/design/CONTENT-DESIGN-RULES.md and
ADR 0003. Read the locally recovered pinned official TDD, tests, mocking and
code-review references. The repository-defined public seam is the UI decision shown to
an administrator before an account lifecycle or entry-stop action. Tests use
existing rendered components and fetch-boundary fixtures, not private copy
helpers. These tests catch missing/misleading disclosure and accidental writes
on cancellation; they cannot establish real runtime enforcement or pixel layout.

## Contract traced in the baseline source

- `internal/store/identity_lifecycle.go:299-305`: disable sets Disabled; retirement
  sets both Disabled and Retired. Login sessions are separate from managed flows.
- `internal/store/admission.go:119-150`: eligibility checks disabled user/account
  and revoked entry grant; it denies those requests. `:310-316` invokes that
  eligibility check before new-presence/renewal handling on the shared admission
  path. This is not conditional on republishing a client subscription.
- `internal/httpapi/platform_entries.go:77-96`: the entry DELETE handler sets
  Revoked and records its audit event; it does not restart a core process.
- `runtimes/xray/runtime.go:295-318`: lease expiry uses an independent close timer.
  `:374-417`: renewal calls authoritative admission; denial closes the flow.
  Control-plane errors do not disable the independent expiry timer.
- `docs/adr/0003-managed-runtime-adapter.md`: managed capability is distinct from
  stock engines. Whole-process shutdown is not per-user revocation.

## Candidate changes

- AccountSecurity disable and permanent-retire confirmation footers distinguish
  login sessions from managed connections. They explain denied new connections
  and renewal, and possible existing-flow termination at denied renewal/expiry.
  Data retention, permanent retirement and separate non-managed credential
  revocation remain visible. There is no instant-disconnection promise.
- UserEntries stop confirmation uses the existing publishedRouteId managed-grant
  distinction. Managed grants explain the admission/renewal effect and that no
  subscription republication or core restart is required. Legacy grants retain
  the warning that downloaded credentials are not removed from nodes.
- API payloads, actions, backend logic and success notifications are unchanged.

## Regression coverage authored, not executed

- `web/src/account-security.dom.test.tsx`: extended existing public disable and
  retire tasks to require the managed-flow consequence, scope and timing before
  the existing submission checks. Retirement still requires the login-name
  confirmation. The retirement case also exercises the existing short-height
  dialog path, but this is not rendered viewport evidence.
- `web/src/rotation-recovery.dom.test.tsx`: added managed/legacy stop decision
  cases. Both identify the target, require the correct consequence before any
  write, and cancel without mutation. Existing submit/failure ownership tests
  remain unchanged. The fixture adds an optional managed flag, defaulting true.

The source assertions were authored before each corresponding copy change, but
no red/green run occurred. Do not describe this as completed TDD verification.
All DOM tests, TypeScript checks, lint/format, Go/native tests, aggregate gates,
and desktop/narrow-browser review remain UNRUN. An independent source review
traced the same backend and runtime paths and found no additional source blocker.
This bounded review is not a substitute for execution before acceptance.

## Checks actually performed

- Read the recovered source contracts and inspected the complete candidate diff.
- `git diff --check` returned success (whitespace only).
- Exported a standalone diff and committed the candidate on a separate local
  reconstruction branch. No public push or deployment.

## Next acceptance work

On a provisioned environment, run the two changed DOM test files with one
worker, type/lint checks and the repository gates. Independently review desktop
and narrow account disable/retire and managed/legacy stop dialogs, including
short-height footer visibility, cancellation, and failure recovery. Confirm
real managed admission denial and renewal/expiry behavior separately from UI
copy tests. Do not treat historical evidence as a run of this candidate.
