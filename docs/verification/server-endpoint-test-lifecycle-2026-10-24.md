# Server-endpoint DOM test lifecycle — 2026-10-24

## Finding and change

The two page-level endpoint tests restored their `getComputedStyle` spies only
at the successful end of the test body. A native test timeout bypassed that
restoration. The next test captured the leaked spy as its original function;
Vitest reused the existing spy, producing a self-recursive implementation.

The test file now restores spies unconditionally in its existing `afterEach`,
with DOM cleanup inside `try` and mock/global restoration in `finally`. The
success-only restores are removed. This is a file-local test-lifecycle change:
no production behavior, user-task assertions, network fixtures, global helper,
or test budget changed.

## Verification

Three serialized, single-worker Vitest processes ran once each with retries
explicitly disabled and the existing 10-second DOM test-body budget:

| Candidate | Native result |
| --- | --- |
| Baseline with deliberate native timeout | 3 failed, 5 passed; 1 unhandled recursion |
| Fixed teardown with identical deliberate timeout | 1 intentional timeout failed, 7 passed; no unhandled error |
| Fixed original file without injection | 8 passed; exit 0 |

The diagnostic injected an unresolved promise immediately after the first page
test acquired its style spy. It exercised the actual runner timeout and actual
file teardown, without manually invoking cleanup. Both diagnostic runs retained
the intentional failure; neither is a passing suite. The later public-path and
retained-label user tasks remained unchanged and passed with the fix.

In the uninjected run, the save task completed in 4690 ms, the public-path task
in 2434 ms, and the retained-label task in 301 ms. The exact formatted fixed
candidate also passed `npm run typecheck` (`tsc -b`). Source/config manifests
were unchanged during each test process and typecheck; canonical source was
unchanged during this isolated verification. The QA lock serialized the work.

The fixed test file SHA-256 is
`8b3ed5bfc7efc2c5b0a2b0433040049f9e144fcf7f7ab7a6f2589345fc1cb4fe`.

## Scope and remaining uncertainty

This establishes that unconditional teardown prevents the demonstrated
native-timeout-induced recursive-spy cascade. The deliberately stalled diagnostic
is **not** a reproduction or explanation of the original full-suite initiating
timeout. A single focused eight-case pass does not establish full-suite stability
or resolve that initiating timeout. No full-suite rerun or browser/product UX
verification is claimed here. Diagnostic injections are not part of the change.
