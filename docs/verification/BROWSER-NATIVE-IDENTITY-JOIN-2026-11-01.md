# Same-instance browser/native identity bridge

Source base: `dcfbe27`. This is acceptance tooling only, not a new production
endpoint, node enrollment flow, OS service or deployment feature.

## Missing link addressed

Existing browser publication acceptance and native fleet/service acceptance used
separate fixtures. The new named browser case uses one isolated normal CLI
control plane and one synthetic managed instance:

1. Provision its private service/principal through authenticated public HTTP.
2. Publish the reviewed deployment through the real browser UI.
3. Compare receipt instance, operation, generation and revision with the real
   CP desired identity; retain every identity field, including digest and scope.
4. A tagged Go test helper receives that desired through the normal enrolled HTTP
   transport and submits it to the real `Reconciler` / owned managed-Xray
   `ProcessSupervisor`. It does not write the CP database or construct a positive
   conformant observation. Its admission broker uses that same CP transport.
5. Hold the actual observation: CP and UI must remain queued despite local native
   completion. A deliberately mismatched copy of the actual observation must fail.
6. Report a fresh native `Recover` observation. The CP identity and browser
   confirmed-state/technical details must match the browser's original receipt.
7. Queue a new reviewed stop through the public Fleet API, apply and report it,
   reject replay of the first native observation, and verify the UI no longer
   shows applied/healthy state.

This is an explicitly coordinated reconciliation/observation test, **not** a run
of the continuous driver, traffic test, quota experiment or soak. Those existing
native gates remain separate. Stop is API-initiated, while publication and state
inspection are actual UI actions. It does not claim a complete browser Fleet-stop
journey or any real Linux-node deployment.

## Isolation, identity and cleanup

The helper is build-tagged `browser_native_acceptance`; it is absent from ordinary
builds/tests. Explicit invocation without opt-in fails. Enrollment exists only
in the synthetic CP and crosses a pipe in memory, not logs, a saved token file or
artifacts. The managed executable is built from the exact checkout, hashed,
verified by the helper and copied into its private owned runtime root before
activation. Build SHA and Git source are recorded in a gate receipt. The gate requires a
clean committed source tree and rejects source changes across execution.

The browser uses no API mocks, synthetic applied observation or authentication
bypass. Traces/screenshots/video are disabled. Its evidence attachment includes
only publication and observation identities, not enrollment secrets. The helper
stops only its ownership-verified process on completion or SIGTERM. It checks
stop/close errors and retains its private evidence root on uncertain cleanup.
A 120-second helper lifecycle cancels through owned cleanup, beneath its
180-second outer test safety timeout. The browser bounds exit waiting to 20
seconds; a timeout is an explicit uncertain-cleanup failure, never a successful
stop or absence claim. Unreferencing a stuck helper is not called cleanup.
No host settings, firewall, TUN, stock sing-box or live node are touched.

## Explicit execution and cost scope

`scripts/verify.sh browser_native` builds the helper and managed runtime and runs
only `playwright.native.config.ts` / `*.native.spec.ts`. Ordinary UI/API discovery
does not silently require a native binary. Full verification explicitly includes
the new gate. Missing prerequisites, absent/wrong/duplicated cases, skipped,
failed, interrupted or retried results fail the gate.

GitHub `browser_native` is a separately required 20-minute Ubuntu job. It uses the
existing exact vendor-installed Chrome verification and sandbox rules. The root
aggregate requires it; no continue-on-error or timeout relaxation was added.
Declared worst runner budget grows **425 → 445 minutes**: **+$0.12**, to **$2.67**
compute at the coordinator's existing $0.006/min assumption. Artifact/storage
costs remain separate. No remote run or budget authorization is implied here.

## Local evidence

- Tagged helper compiles; explicit missing-opt-in invocation fails as required.
- Real normal-CLI API companion passes: one managed publication remains queued
  with exact receipt/desired identity and no fabricated observation. Initial
  fixture validation omitted If-Match, failed, then was corrected; no product bug.
- Strict TypeScript checks explicitly include all helper/spec/config files.
- Separate native browser discovery finds exactly the one required case.
- Static gate passes, including 63 helper regressions, architecture and actionlint.
- Pure tagged outcome-classifier regressions reject network/500 errors as identity
  refusal, and reject unobserved/uncertain stop outcomes. Exact HTTP 409
  request_rejected is required for stale/mismatched observations.
- Go formatting and whitespace checks pass.
- **Browser/native execution is UNRUN locally.** No managed or browser process was
  started for this change. The tagged helper's missing-opt-in negative test exits
  before reading initialization or executable bytes.

AGENTS.md was read. Pinned local skill references were absent and the official
pinned tests URL cache-missed; no unavailable skill execution is claimed.
