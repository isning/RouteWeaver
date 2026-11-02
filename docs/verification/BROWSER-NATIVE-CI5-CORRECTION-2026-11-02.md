# Browser/native CI5 initialization correction

CI run **41379700309**, job **125067567424**, exact remote source `5f92e2c`:
one required bridge case failed, zero passed/skipped/flaky. The retained artifact
`browser-native-diagnostics` (ID 13113246272) binds its build to that remote
source. The single test body failed in 836 ms; total Playwright phase was 7.359 s.

The helper failed in `NewHTTPTransport` with `explicit bounded transport timeout
and retry policy required`. It supplied a timeout and maximum attempt count but
omitted the required positive backoff. This occurred **before native checker,
reconciler or broker construction**, before publication, native activation,
identity matching, stop or UI observation. A managed executable was built and
copied to a private temporary path, but those bytes were not activated by this
failed helper. Its generic initialization/cleanup aggregate error does not prove
that a native process ever existed.

## Correction and regression

The test helper's shared option constructor now explicitly supplies a 1 ms
backoff, preserving its 2 s request timeout and one attempt. No production
transport default, policy validation, retry count or deadline was changed.

A new subcase inside the already mandatory tagged classifier test calls that
exact option constructor with synthetic scope/token and a literal loopback URL.
It constructs and closes the transport without sending any request, then
requires removal of the backoff to be rejected. Before the correction it failed
with the same CI initialization error. After the correction it passes under the
race detector (1.077 s, one top-level test plus its constructor subcase). This does not start a browser, native process or HTTP listener.

The actual same-instance browser/native path remains **pending a fresh CI run**.
Neither the constructor regression nor the original failed run proves native
activation, observation identity, absence after stop, or full bridge cleanup.
