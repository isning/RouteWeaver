# Server shell-label test: module preparation and controlled pending route

Base `877cc8a`; test-only correction, no product changes.

The integrated full frontend run failed one of 2113 tests:
`task-experience.dom.test.tsx` → “does not label platform administration as a
private workspace.” Its unchanged 1000 ms RTL heading wait expired. The original
log `/tmp/literal-final-web.log` is complete, but Testing Library truncated its
embedded DOM dump in the sidebar before the main content. It shows an
authenticated workspace shell; it does **not** retain enough main DOM or a request
ledger to establish the exact failed route/request state or sole cause.

An isolated instrumented rerun passed all 12 cases. Its selected test recorded
448.7 ms to the heading, `#servers`, main text “服务器添加服务器”, and `/api/auth/me`
followed by the five inventory reads (hosts, core-instances, managed-endpoints,
links, server-deployments). `/tmp/task-label-probe.json` retains this snapshot;
`/tmp/task-label-instrumented2.log` retains the run. This rerun alone is not proof
that the integrated failure was harmless or definitively caused by compilation.

A controlled regression in `server-route-import.dom.test.tsx` establishes the
specific test setup dependency:

1. Actual App authenticates the admin and selects `#servers`; server navigation
   remains current and available while “正在打开页面” is visible.
2. Only Infrastructure module **delivery** is held. The factory imports and later
   returns the actual production module; no replacement page/heading is used.
3. The original unchanged heading query rejects at its default deadline while
   only the auth request has occurred. Loading/route assertions remain true.
4. Releasing actual exports produces the server heading and exactly the five
   inventory reads. Unexpected requests fail the fixture.

The shell-labeling test now imports Infrastructure in `beforeAll`, outside its
user-facing heading assertion, following the existing workspace-shell setup.
It still requires the actual server heading, absence of “私人工作空间”, and the
workspace navigation. No timeout, assertion, product loading behavior or auth
boundary was relaxed. The separate controlled test preserves coverage of
pending route delivery rather than hiding that state by preparation.

Validation: **34/34 tests passed** in `/tmp/task-label-final.log` (four focused files),
`/tmp/task-label-ts.log` (application typecheck). The original failed full-suite
run remains failed; this focused result does not replace the coordinator's next
integrated run. No browser/native process, remote CI or push was performed.
