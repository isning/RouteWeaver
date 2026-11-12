# Active service-cycle draft native sampler

Four cases cover monthly day and fixed-days duration at 390×560 and 1440×900, using the proven exact synthetic service GET/edit-context fixture and real App/session/StrictMode. The guarded saved record has day 1 and days 23. Invalid drafts send no preview and never change that saved record; local accepted intermediate values can change while typing. No mode switch is used to expose the bug.

The monthly case enters `-`; fixed-days enters `1e`. Ordinary Preview must be blocked by native numeric validity with zero requests. Cancel/Continue must retain the spelling. Next, `1.0000000000000001` or `23.0000000000000001` is native-valid after Number conversion but must fail caller-owned exact-decimal validation without sending the rounded old integer. Active mode and raw input remain unchanged. Explicit `2e0` or `24.000` corrections produce exactly one synthetic preview with the complete expected service/cycle and opening precondition; its comparison cell is exactly `2 日` or `24 天`.

Returning from review, explicitly discarding and opening a fresh guarded editor restores the saved active value/mode. No preview is applied. The `1e` input passes through accepted intermediate 1, so no raw-only dirty claim is made. Latest reads, retained-copy adoption and response races remain DOM coverage, not native claims here.

Screenshots preserve original positions before geometry. Natural keyboard traversal, strict 3px focus-ring/ancestor bounds and unchanged session behavior remain. Diagnostic booleans/counters and already-validated synthetic numeric values exclude raw request data, secrets, URLs and page-error text. Exact synthetic preview is fulfilled locally; all other writes, unknown API reads and external HTTP origins are rejected. HTTP interception does not claim WebSocket isolation.

This proposal is staged outside the checkout. Source integration, independent review and native execution are required before acceptance. No production changes, Save/Apply, real external writes, deployment or publication are part of this sampler work.
