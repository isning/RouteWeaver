# Diagnostic target registration focus and task ownership

Integration base: `172fc6e`. Scope is the existing target-registration form inside
the server workspace. No diagnostic execution, endpoint, request payload, server
validation, shared form or shared modal behavior changed. All HTTP in these
regressions is intercepted synthetic data; no test target was registered on a
real server and no network diagnostic was executed.

## Findings and correction

- Keyboard submission with a missing target name left focus on Save. The first
  public server-workspace regression failed at the exact focus assertion before
  the change and passed after opting into the existing AppForm error-focus seam.
  The same owner also supports recovery to an invalid HTTPS address.
- The dismissal guard first failed its exact opener-restoration assertion. A
  controlled run without the focus opt-in reproduced that failure. Further
  observation found its cause: same-turn native Submit then Cancel unmounted the
  form before validation settled, and its old completion dispatched a target
  registration containing only the ID, server ID and default methods. That
  accepted synthetic write refreshed the target catalog and replaced the opener.
  This was not merely an overlay-focus issue. The mounted form now owns a live
  task flag, revoked in layout cleanup, and its submit callback checks that flag.
  The original zero-write and exact opener-restoration assertions are retained
  and pass. Earlier failures are not relabelled as passes.
- Independent source review identified a second invalid-field path: clearing all
  methods produced an error, but the custom control dropped the field's native
  checkbox error semantics. A new public regression failed because aria-invalid
  was absent. The methods group now has its field's accessible name, while each
  checkbox retains its own option name and receives aria-invalid, aria-describedby
  and disabled. The first checkbox can receive error focus; Space corrects the
  group and preserves the existing method payload.

The focus owner is stable for the mounted registration task. AppForm continues
to own first-invalid-control selection, visibility recovery, newer-interaction
fences and teardown. No new timer, focus observer, timeout or shared recovery
mechanism was added.

## Public regression coverage

`web/src/diagnostic-target-submit-focus.dom.test.tsx` uses the real ServersPage,
UI providers, native controls and intercepted HTTP. It does not export or mock
the private registration component. Unexpected requests are recorded and fail
the assertions.

Seven cases cover:

1. Missing-name keyboard recovery, retained URL/methods and zero writes.
2. Invalid-HTTPS keyboard recovery with retained name/methods and zero writes.
3. Empty-methods error association, first-checkbox focus, native keyboard repair
   and the unchanged explicit registration payload.
4. A definite synthetic HTTP 400 save rejection, retained fields/methods/focus,
   and exactly one retry after the next explicit submission.
5. Same-turn submit/cancel, no departed write or stale focus, exact opener return,
   and an independent reopened registration draft.
6. An already-dispatched save completing successfully after workspace replacement.
7. An already-dispatched save being rejected after workspace replacement.

Both late-completion cases retain the providers/cache and assert the replacement
dialog, draft and focus remain intact with no inherited error. Pending method
checkboxes are disabled. These cases replace the public workspace owner; they do
not claim real-browser history or animation acceptance. A request already sent
is not canceled, and an accepted save still refreshes the catalog. Unknown write
outcome recovery and arbitrary delayed validators remain outside this slice.

## Verification status

- Initial tracer: one expected failure, then one pass after the focus opt-in.
- First expanded file: three passes and the dismissal failure described above.
- Dismissal baseline: the original restoration assertion also failed without
  the focus opt-in. The direct zero-write assertion then exposed the stale POST.
- After the local liveness guard: all four then-present cases passed, including
  the restored original opener assertion. The affected five files passed 92/92.
- Both additional late-completion cases passed in the six-case file.
- Methods-only acceptance failed before native field semantics were forwarded
  and passed afterward.
- Final one-worker affected run passed **101/101 tests across six files** in
  36.16 seconds: diagnostic target focus, shared form submit recovery, diagnostic
  receipt/cancellation, infrastructure creation and shared checkbox focus.
- Production build (`npm --prefix web run build`, including `tsc -b` and Vite)
  and `git diff --check` passed.
- Coordinator-owned full-suite and independent final review remain separate.
  Native browser execution and actual wide/narrow pixels are unrun.

No publication, deployment, real credential action or local browser launch was
performed. The previous full-suite pass at the integration base does not accept
these later changes.

Independent final source review accepted the stable owner/liveness guard, checkbox-group field semantics, seven public cases and bounded documentation with no blocking finding. The review did not execute tests or a browser.

## Native preparation and aggregate interruption

Four real-App native fixture cases at 390 and 1440 pixels cover missing name, invalid HTTPS URL, empty methods, definite synthetic save rejection, Continue/discard and clean reopening. Invalid cases forbid all writes; rejection cases validate and locally fulfill exactly one synthetic registration response. No target registration or diagnostic execution is forwarded to a backend. Original masked captures and a sanitized ledger have 19 exact scoped artifact paths.

Strict native TypeScript, 68-case/20-spec supplemental discovery, and all five workflow contracts pass. Independent source review accepted the integrated fixture, complete reopening assertions and additive artifact wiring. Shared sandbox, servers, timeouts, one worker, zero retries and required gates remain unchanged. Native execution/pixel acceptance and lane runtime remain unverified.

The first coordinator full-DOM attempt was interrupted: its process handle became unavailable and its log contains no completion result. It is not a pass or an assertion failure. A fresh serialized run was started against production/DOM source `0d7e226`; its completed result is recorded below. The separate published checkpoint `172fc6e` excludes this diagnostic change.

## Completed aggregate and origin fixture preparation

The replacement serialized full-DOM run completed with **4,099 passes and one
failure across 330 files** in 1,171.66 seconds. Production/DOM source was
`0d7e226`; later `eae55d2` only added native/config/contract/documentation changes.
The sole failure was the first `subscription-origin-refresh-race.dom.test.tsx`
case, at its initial `findByRole("textbox", { name: "订阅域名草稿" })` on line 77
before any refresh, write or race/recovery assertion. The other four origin-race
cases passed. Neither that fixture nor its production component changed since
the earlier complete 4,093-test pass at `36fa9d7`.

This identifies an initial field-readiness failure, not a failed origin-write
invariant. Cold loading of the real lazy Admin module is consistent with the
first-case-only result and the earlier settings-receipt finding, but the truncated
failure DOM does not establish which initial loading stage consumed the wait.
The origin-race fixture now imports the real Admin module in `beforeAll`, matching
the receipt-test preparation from `dde6bf7`. These tasks exercise read/write
ownership after the workspace is available, rather than cold route compilation.
App routing/session, intercepted HTTP, assertions and all timeout budgets are
unchanged. Controlled pending/rejected page imports remain covered separately.

After this setup correction, the requested one-worker focused run passed
**23/23 tests across three files** in 15.11 seconds: origin refresh races, settings
save receipts and page recovery. `git diff --check` passed. No production code
changed in this correction. A new coordinator-owned full run is still required;
the failed aggregate is not relabelled as a pass, and the focused result does not
provide native-browser or rendered acceptance.

## Final local aggregate

The serialized rerun at `4424892` passed **4,100/4,100 tests across 330 files**
in 1,155.68 seconds (2026-11-11, start 15:41 UTC, exit 0). The earlier failed
aggregate remains recorded above. This accepts local DOM behavior, not native
browser execution or original-pixel review.

The preceding published checkpoint `2addd3a` passed journey/mixed feedback and all
11 primary non-browser repository-quality jobs. Browser installation failed on
Ubuntu mirror DNS resolution (`azure.archive.ubuntu.com`), including one bounded
recovery rerun on a fresh runner. Browser tests never started and recovery emitted
no screenshot artifact. No sandbox, browser checks, assertions or timeouts were
weakened. Later diagnostic changes require fresh exact-head CI after publication.
