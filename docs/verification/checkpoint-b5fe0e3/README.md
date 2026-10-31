# Reviewed feature checkpoint b5fe0e3

At 2026-10-19 20:19 UTC, `scripts/verify.sh quick` passed against the frozen
feature sources in local commit b5fe0e3. This includes root behavior/race tests,
root and nested-runtime vet/build, nested runtime race tests, architecture/ticket
checks, web typecheck, all 93 model/DOM tests, and production web build. Static
guards were rerun after the new files were tracked (671 tracked files).

The pinned native parser gate also passed, including four owned-file formats
with file-consumption sensitivity tests, nodes-only merged receiving shapes,
native overrides, server/client fixtures and immutable installer checks.
Selected Xray process/lifecycle/fleet tests and the required managed CP→agent→
native payload tests passed. Read their logs for exact selected scope.

This supersedes the earlier aggregate's concurrent-compilation failure only for
this checkpoint. The earlier run is not retroactively a pass. The supported
Chromium retry remained blocked before test execution by host socket EPERM.
No sandbox bypass, screenshot, sing-box process success, real VPS rollout,
GitHub publication or remote CI is claimed. The `full` gate is not passed.

Build notes: the shared framework chunk remains 987.15 kB minified, 316.09 kB
gzipped. The jsdom suite reports unimplemented canvas context; passing DOM tasks
are not pixel or QR rendering acceptance.

The measured admission-history scalability issue is still present in this
checkpoint. The usage-only optimization is being developed on an isolated branch
and is not covered by these results or merged here. Canonical accounting and
backup correctness evidence must be rerun before accepting that change.

A subsequent static rerun exposed a test-fixture assumption after the catalog
received partial evidence links: the negative fake-completion fixture had relied
on the real integration ticket having no evidence. The fixture now explicitly
clears evidence before asserting rejection; production validation was unchanged.
The preserved `static-red.log` records that failure and `static.log` the passing
rerun. Thus the final static result includes this small harness-only correction
on top of b5fe0e3; the application/runtime sources are unchanged.

A fresh real-API Playwright run passed all 17 tasks against the local Go server
(7.4 seconds; `api-final.log`). These are request-level tests, not Chromium.
The extracted Linux-amd64 package smoke also passed health, static shell and JS
MIME loading, and synthetic session login; it uses only loopback, disables
outbound proxy discovery, and removes its temporary state. It is now a separate
required stage of the full harness after package creation.
