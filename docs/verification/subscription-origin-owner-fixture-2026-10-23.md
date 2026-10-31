# Subscription-origin owner fixture verification — 2026-10-23

## Model and correction

Bearer authentication provides an operator principal, but does not create a persisted subscription owner. The access endpoint requires both a persisted, non-disabled Account and an enabled User before returning subscription access URLs. This matches the existing feed authorization requirement; authentication alone is not subscription eligibility.

The origin-header test previously stored only an Output, so the new readiness guard correctly returned generic HTTP 409 before origin construction. The test fixture now persists the synthetic operator Account and enabled User with checked writes. No production code, authorization rule, publication rule, credentials, or feed assertion changed. Original host-header resistance and member HTTP 403 assertions remain intact.

A separate public `/api/me/outputs/{id}/access` test verifies missing account, missing user, disabled account, and disabled user each receive exactly the generic HTTP 409 response without subscription URLs or tokens. An enabled persisted owner receives HTTP 200 and the expected access URLs. These dependency-free outputs require no platform entitlement.

## Observed verification

The aggregate run supplied the failing-before evidence: `TestSubscriptionOriginUsesOnlyExplicitDefaultAndAdminMayMaintainIt` failed with HTTP 409 instead of 200 at the origin access assertion.

An isolated candidate containing exactly the two approved test-file changes passed:

- `TestSubscriptionOriginUsesOnlyExplicitDefaultAndAdminMayMaintainIt`
- `TestOutputAccessRequiresPersistedEnabledOwner` — five owner-state subcases
- `TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility` — exhausted and expired subcases
- `TestOutputRotationRecoveryDoesNotMisclassifyRevocationOrPlatformSuspension`

Command:

```sh
scripts/go.sh test -race -p=1 -count=1 -timeout=20m -v ./internal/httpapi -run '^(TestSubscriptionOriginUsesOnlyExplicitDefaultAndAdminMayMaintainIt|TestOutputAccessRequiresPersistedEnabledOwner|TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility|TestOutputRotationRecoveryDoesNotMisclassifyRevocationOrPlatformSuspension)$'
```

Result: exit 0, HTTP package 11.471 seconds; four top-level tests and seven subcases passed. Concurrency and memory settings remained `GOMAXPROCS=2`, `GOMEMLIMIT=768MiB`, and `GOFLAGS='-buildvcs=false -p=1'`. Canonical and candidate source manifests remained unchanged during verification. The runtime lock was released at 23:39:46 UTC.

The first candidate preparation stopped before any tests because its copy filter omitted a source symlink included in the freeze manifest. Preparation was corrected to preserve symlinks; the failed attempt remains recorded separately. No test budget or source-invariance check was relaxed.

This is aggregate RED → focused GREEN evidence for the fixture correction and selected guards, not a pass of the whole HTTP package suite, aggregate gate, browser journey, native runtime, or deployment.
