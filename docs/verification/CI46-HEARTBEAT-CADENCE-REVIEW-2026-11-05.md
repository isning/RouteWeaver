# Continuous-service heartbeat cadence regression

Date: 2026-11-05. Scope: owned loopback CP/Agent/native fixture with synthetic
authority. No real-node deployment, production credentials, or host network
changes. This document does not promote the candidate to production acceptance.

## Restored incident evidence

- CI46: <https://github.com/isning/RouteWeaver/actions/runs/41853823114>, native
  job `126656918591`, checked-out remote commit
  `8e15c65eb9fce39a9a6f9a130857f643285e44e8`.
- CI50: <https://github.com/isning/RouteWeaver/actions/runs/41862137337>, native
  job `126686536317`, checked-out remote commit
  `79f86eb98c9edebdd61ba05dead33dbdea458ede`.
- Full decoded CI46 native log SHA256:
  `e53e3676e6c79d64188d27ca27cdb6ca0bef4f3f371c080d4b292f29350345b3`.
- Full decoded CI50 native log SHA256:
  `c71d8bbfcb9c352ea2c70ddea5e6d765ab7247433ec5b1438f1e08d4f0188809`.

The following UTC observations come from CI46's redacted failure timeline:

1. Original policy expired at `15:10:42.998124861` on 2026-11-04.
2. Heartbeat began at `15:10:33.614637366`, returned HTTP 200 at
   `15:10:33.749712207`, and supplied refresh issued at `15:10:33.697600153`,
   expiring at `15:15:33.697600153`.
3. The next heartbeat began at `15:10:38.614492803`, sent that newer issued
   timestamp, and returned HTTP 204 at `15:10:38.617138690`.
4. Successful admission renewals remained clipped to the original expiry.
   The last success completed at `15:10:42.994991940`. The next request began
   at `15:10:42.999260770` and was denied as `deployment-unverified`.
5. The existing stream read zero bytes with EOF at `15:10:43.199236017`.
   Timeout and cancellation flags were false. Driver cleanup exited cleanly.

This proves that the Agent received/applied a newer lease while publication
authority had not advanced before the original expiry, and the admission path
failed closed. It does **not** identify the exact CP branch that returned the
third heartbeat's 204. Request-start scheduling versus CP receipt-based throttle
is strongly consistent with the timestamps, but remains a candidate cause for
this historical run, not a uniquely established incident root cause.

CI50 passed the original continuous-service test once in 23.04 seconds. That is
a useful exact-run result, not a repeated-load or all-platform stability proof.
The separate historical long-observation sample-410 EOF is not resolved by this
comparison and must not be conflated with CI46.

## New controlled regression

`TestNativeDelayedHeartbeatAcknowledgementPreservesExistingFlow` joins the
real HTTP CP, Driver, persisted intent/publication, and managed native stream:

- For heartbeats whose durable intent still has the original lease and no
  pending refresh, wait for the actual first payload on the existing stream,
  then delay 500 ms **before** the real CP handler. Both waits consume the
  existing request deadline. Match the refresh by the actual HTTP 200 and
  pending-grant transition, never by a fixed request number. The publication
  expiry must remain unchanged at issuance. ACKs with pending authority receive
  no artificial delay.
- After the Agent applies that refresh, send a separate negative ACK probe
  within the persisted `ValidationNotBefore` window. Require HTTP 204, unchanged
  pending grant/lease/throttle, and unchanged publication expiry. This supplies
  observable evidence for the controlled early-ACK case without adding a
  production endpoint or branch tag. A test-only request header marks this
  deliberate negative probe in the bounded diagnostic events.
- Require the **Driver's own first** heartbeat carrying the issued timestamp to
  reach the CP handler at or after the throttle boundary, return 204, clear the
  pending grant, and advance persisted policy and manifest expiry before the
  original lease deadline. The marked negative probe cannot satisfy these
  conditions. A later successful ACK cannot conceal an earlier Driver ACK that
  missed the throttle window, even when both arrive before the old expiry.
- Reuse the existing TCP connection across the original expiry, verify unchanged
  native identity, then revoke the entry and require bounded closure. No retry
  is added to actual payload assertions.
- Keep the existing one-second Driver request deadline, two-second socket
  deadlines, original approximately 15-second remaining lease, and the native
  gate's 240-second package timeout. The negative probe also has a one-second
  deadline. No throttle clearing or lease extension is used to force acceptance.
- Log at most eight heartbeat events containing typed timestamps, status, error
  type, and fixture delay/probe booleans. Do not log credentials, identities,
  raw HTTP bodies, or DB records.

The production fix that schedules the next heartbeat after response/application
already exists in the recovered candidate. This change adds regression coverage
and diagnostics only. The old request-start scheduler is expected to miss the
controlled throttle window, but a red/green mutation run has **not** been executed
in this recovered workspace.

## CI59 fixture correction

CI59 remote commit `3c509557ea9e0c5f8d4477e588510e06b62cb0f7`, corresponding
to canonical `ebc114d55ae3488fc0137bfdf2b6e66ee4c941ac`, exposed the original
fixture's fixed-second-request assumption. Its first heartbeat reached the CP
after the initial throttle had elapsed and correctly issued the refresh. The
second request was the intentional negative ACK and the third was the Driver's
successful ACK. The fixture rejected that valid ordering because the artificial
delay had been attached to the negative probe, not the refresh issuance.

The extracted `native-delayed-heartbeat.txt` SHA256 is
`38829e389114ca12c678d9b5dc16beb0432870b993efbad8e03e50f70ce8b3b8`.
This is a fixture preparation failure, distinct from CI46's expiry EOF and
CI55's process-exit cleanup failure. It does not excuse any failed native gate.

The correction is test-only. Additional HTTP-handler fixture contracts cover a
first-request refresh, a synthetic warmup 204 followed by real-CP refresh, a
real-CP early ACK without artificial delay, cancellation before flow readiness
and during the controlled delay, and rejection of an early Driver ACK even if
a later ACK succeeds. The synthetic warmup and synthetic ACK-event cases are
fixture-contract evidence, not native or production acceptance. Native traffic
still uses the real CP for every request and retains the existing-stream and
revocation assertions. No lease, timeout, or throttle was relaxed.

## Verification state

- Passed: `bash -n scripts/managed-runtime.sh` and owned-file whitespace checks.
- Passed: static execution of the embedded Python gate with synthetic result
  records. Its seven required tests match the selector exactly; all seven passes
  are accepted, each missing pass is rejected, and any skip is rejected. The six
  previous required tests remain intact. This is a gate check, not native proof.
- Reproduced and repaired the companion offline gate fixture: its old six-event
  positive fixture failed for the newly required heartbeat test. After adding
  the seventh event, selector assertion, and missing/skipped/failed cases,
  `python3 -m unittest scripts.test_managed_gate` passed all six tests in 1.054 s.
- Not run locally: Go formatting, compilation, focused/race/native execution.
  Go 1.27.3 and the managed executable are absent in the recovered environment;
  the unrelated `/usr/bin/go` was not used. Exact integrated CI remains required.
  This includes the CI59 event-driven fixture correction and its new contracts;
  source review and whitespace checks are not reported as executed Go tests.
- Still separate: production network/client behavior, selected-host capacity,
  operator key custody, restore/RPO/RTO, alert delivery, and authorized rollout.
