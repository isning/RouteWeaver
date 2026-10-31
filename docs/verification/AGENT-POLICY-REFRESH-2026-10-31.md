# Identity-bound agent policy refresh — 2026-10-31

This is the agent/protocol half of the explicitly opted-in continuous-service
work, not independent authority to run indefinitely. The CP half must persist
administrator opt-in, revalidate current authority/configuration with CAS and
bound recovery attempts before the feature is usable end to end.

## Contract

`POST /api/agent/instances/{id}/service-heartbeat` uses the existing scoped bearer,
TLS, request/retry bounds and strict decoder. Only `DriverOptions.Continuous`
uses this optional transport, at most once every five seconds. A bounded driver
never requests a refresh. Actual adapter observations are captured in the same
serialized lane as mutation; absent, unknown and draining are not renewal proof.
No heartbeat is emitted from shutdown. A startup heartbeat can carry proven
absence for CP-issued **new generation** recovery, never a lease activation.

`PolicyRefresh` binds the entire current Desired/active Identity, stable intent
ID, monotonic decimal-string sequence and bounded PolicyLease. Agent-provided
heartbeat time is not CP authority. The original Desired and RequestDigest never
change. The refresh is separately persisted in the agent journal; its high-water
sequence and issued time survive reopen. Reopening an invalid refresh fails closed.
Older binaries cannot be assumed to understand the optional new journal field;
coordinate package rollback rather than delete a journal to force compatibility.

Acceptance requires still-current unexpired effective authorization and a real
conformant runtime with the same identity, then a valid newer issued lease.
Expired, unknown, absent, changed intent under the same identity, superseded,
wrong-scope, revoked or uncertain authority cannot be renewed. Exact retries are
idempotent while authorization is valid. Persistence failure restores the prior
in-memory policy and retains uncertainty. No code stages/starts/replays a native
command on refresh; network delay cannot stall the independent local lease timer.

## Tests and boundaries

The initial public-seam test failed because the new contract/methods did not
exist. `TestPolicyRefreshExtendsOnlyObservedIdentityWithoutActivation` now checks
unchanged runtime bytes/identity, extended bounded lease, durable reopen, and
retry of the original immutable Desired. Negative tests cover late/old/future
issuance, wrong identity, stale sequence, intent substitution, denial, quota
uncertainty, expiry, actual absence, unreadable observation and unwritable storage.
The write-failure test is filesystem fault injection at the persistence seam.
It fails the preliminary recovery write; it does not directly exercise the final
refresh-write rollback branch or post-rename directory-fsync failure. Those
branches are source-reviewed, not fault-injection proven. This is not a claim to
simulate all device/fsync/power-loss failure modes.

Driver tests verify successful renewal and independent expiry during a blocked
heartbeat, plus no implicit heartbeat in bounded mode. HTTP tests verify scoped
request and strict response/identity rejection. These are isolated loopback and
filesystem fixture tests, not a production certificate or real account grant.
CP authority/CAS/lost-response/manifest-ack and automatic recovery tests belong to
the [paired CP implementation](CONTINUOUS-SERVICE-CP-2026-10-31.md), including a
real managed payload crossing original instance/manifest expiry and revocation
negatives. Native/host deployment, power failure, production
clock skew, long soak and restricted sing-box host behavior remain separate gates.
