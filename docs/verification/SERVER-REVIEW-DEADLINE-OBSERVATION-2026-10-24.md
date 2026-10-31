# Server review deadline: bounded nonreproduction

24 October 2026

The current-source unfiltered web gate passed 1138/1139 cases. Its sole failure was `server-review-revision.dom.test.tsx`, “requires explicit reload and fresh consent when the saved path changes after opening”: **native 10,000 ms deadline**, reported duration 16,667.24 ms. The stack names the test declaration, not a failed assertion or stalled operation. The other five cases in that file passed.

A separately approved private observation then passed full typecheck and **all six original cases once**, with native budgets/order/events/assertions/query scopes unchanged, worker 1/retry 0. No profiler or production/test repair was introduced. The selected case passed in 2,997.10 ms native duration; its body markers spanned 2,977.62 ms and existing cleanup 11.64 ms. All 17 existing awaited-statement pairs completed. The longest composite interval was initial path lookup/click 762.91 ms; composite markers do not separate query, event, render and async costs.

Original assertions passed for opened-revision validation, stale-action blocking, explicit reload, renewed consent and the expected publication fingerprint. The case recorded 18 fetch entries and 18 response-construction-begin marks. These mark entry and the point immediately before constructing a Response—not response consumption or UI settlement. Construction rows are not correlated to individual request IDs; matching totals alone prove neither complete settlement nor request ownership.

The observed body used 4,204.38 ms process CPU, 2,940.54 ms active ELU and 37.06 ms idle ELU; the case-wide 20 ms histogram maximum was 455.61 ms. Process CPU includes background threads, histogram samples can be delayed, and observation overhead is unquantified. These passing-run numbers do **not** explain the earlier deadline, identify GC/environment causes or measure product/browser latency.

Data quality: 234 rows, 6 finished contexts,zero dropped rows; no abort or late/non-current-owner rows captured. All recorded native budgets were 10,000 ms. Boundary fake-timer flags were false, without excluding temporary changes between marks. No broader unhandled-error or post-flush lifecycle claim is made.

Canonical source bytes/modes, dependency bindings and provenance were unchanged. Private inputs were unchanged after execution except normal typecheck build metadata. Exactly three diagnostic overlays were used; stripping observations preserved the original test AST. QA was released at 06:42:19.783 UTC. No rerun followed.

**Conclusion:** no stuck phase reproduced in this isolated observation. The earlier 1138/1139 gate remains a failure; this pass is not a timeout fix, aggregate clearance or measured speedup.

Evidence identity: private validation manifest SHA256 `f2d8680a27dc33ef58e8193c70365eb95b3e72d48f8907007348a7b966183968`; raw phase artifact SHA256 `ef1fd7074bb77d78421d2e9f8b43fdd403107398991bae749b54f0b1980ceb9e`.
