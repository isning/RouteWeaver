# Resource and source inventory read recovery

## Finding and bounded change

Starting from `6940f22`, a failed background list read replaced the entire resource or source inventory with an error notice, even when the client still knew the previously loaded rows. Ordinary resource refresh, file replacement, source refresh, or source save could trigger this immediately after a successful operation. Source search also disappeared with the inventory.

The two pages now keep known rows and search while showing the read failure and retry action. Cached paused and pending reads have distinct feedback. Initial unknown reads retain the existing loading/error treatment, and a successful authoritative empty result still clears the inventory. The shared `QueryState` component is unchanged.

Retained presentation does not establish current mutation authority. Resource edit/replacement/refresh entry waits for a completed successful list read; replacement still uses the opened revision precondition. Source apply/refresh/delete/review and configuration continuation also wait for reconciliation. Source editing remains independently available through its existing fresh reveal and matching summary read, without using cached private form content. Open editor drafts are not replaced by list reconciliation.

## Review corrections

Independent source review caught two intermediate regressions before acceptance:

- An open source detail sheet could keep its original snapshot/candidate after retry returned a changed or missing source. The sheet now derives title, metadata, content, and actions from the current known row. Confirmed absence hides stale content/actions and retains explicit feedback. A subsequent failed read does not restore the originally selected record.
- That derivation initially preferred an old list row over a confirmed application result. The existing source-application hook now cancels the exact source-list query before replacing only an already-known matching row with the validated public application summary. It excludes the response-only application receipt, checks command ownership/liveness/scope before and after awaiting cancellation, and retains normal settlement invalidation. An older held GET cannot overwrite the confirmed result. Later successful reconciliation, including absence, remains authoritative.

## Verification

- The original resource and source inventory regressions each failed on the missing known-row lookup before their corresponding fixes, then passed.
- Two open-sheet changed/removed cases failed against the intermediate retained-list implementation. Two application-result cases, with ordinary and held older-read ordering, failed against the intermediate sheet reconciliation implementation. All four pass after the review corrections.
- The two new files contain **8 passing public DOM cases**. They also cover initial unknown reads, source search/no-match recovery, paused and held retry, successful empty reconciliation, independent reveal failure/retry, fresh source revision submission, and recovered resource `If-Match` submission.
- Final serialized related run: **161 tests across 15 files passed**, using one worker. It includes source application modes/targets/continuation, source editor recovery, source search/actions, resource import/modal recovery, and session recovery.
- Final production TypeScript/Vite build and `git diff --check` pass. An earlier build failed only on new test fixture typings (a required digest and unsupported query options); those fixture errors were corrected before the final checks.
- Independent read-only source review accepted the final implementation and test design with no remaining concrete blocker. That review did not execute suites or browsers.

These are bounded DOM/HTTP-fixture and build results, not native browser, pixel, backend persistence, full-suite, or remote-CI acceptance. No native/browser execution, publication, deployment, credentials, or real source/resource mutation was performed in this work. The coordinator owns the subsequent full suite.

## Prepared native evidence

Six real-App synthetic loopback journeys now cover resource unknown/cached/empty recovery and source cached-sheet changed/removed reconciliation at 390 and 1440 pixels. Exact synthetic refresh requests are fulfilled locally, unexpected/off-origin HTTP is blocked, and no API mutation is forwarded. Current-viewport masked originals, keyboard focus/geometry, and independent sanitized request ledgers have bounded artifact retention.

Strict browser-spec TypeScript passes. Supplemental discovery is 50 cases across 17 files, and all five workflow contracts pass. Independent source review accepted payload/path matching, selectors, keyboard traversal, evidence privacy and additive artifact bounds. Existing sandbox, time limits, one worker, zero retries and required gates remain unchanged. Actual native execution, lane runtime, pixel review, paused native recovery and backend correctness remain unverified.

## Complete integrated DOM pass

At approximately 13:22 UTC on 2026-11-11, the serialized whole suite passed **4,046 tests across 328 files** in 1,100.61 seconds. Production/DOM source was `e4b2298`; `5486e50` adds only native fixtures/config/contracts/documentation. This passing run includes resource/source read recovery, confirmed-apply ordering, open-detail reconciliation, and the earlier backup/profile fixes. Native browser/pixel acceptance and remote CI for unpublished changes remain pending.
