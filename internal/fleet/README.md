# Fleet rollout contracts

`fleet` is the pure planning/outcome module. It imports domain and the control
protocol, never HTTP, persistence or process adapters. HTTP orchestration uses
the existing encrypted SQLite repository and generation-fenced agent protocol.
There is no remote shell, job interpreter, automatic exit substitution or K06
server-side automatic failover.

## Administrator workflow

- Hosts retain a group and up to 32 unique tags. Batches still name every exact
  Core Instance; a changed tag query cannot silently add execution targets.
- `POST /api/admin/fleet-batches/preview`: action, deploymentId, targetIds,
  optional explicit stages, rollback sourceBatchId, and install/upgrade
  targetReleaseId. It returns target node/adapter/current and target versions,
  affected route IDs, distinct assigned-user count, bounded redacted before/after
  artifact previews, disruption, support diagnostics and a full-input fingerprint.
- `POST /api/admin/fleet-batches`: same input, expectedFingerprint and an explicit
  leaseSeconds in 30–3600. Input and secrets are retained in encrypted storage;
  the response/listing contains only the safe plan and attempts, not raw IR.
- `GET /api/admin/fleet-batches` and `/{id}` return historical operations and
  per-target observations. A successful action is not a permanent health claim.
- `POST /{id}/execute` with stage and stable requestId explicitly advances one
  stage. Prior stages must still have the expected current desired identity,
  observed result and unexpired policy, not merely historical success.
- `POST /{id}/retry` with exact targetIds and a new stable requestId retries only
  known failed targets. The same key/body is idempotent; a different body using
  that key conflicts. Successful, pending, uncertain and superseded targets are
  not silently replayed.

Each queued target atomically commits its new generation, desired package,
immutable published manifest (activation actions only), batch attempt and audit.
Comparisons fence draft/inventory/enrollment/authority/dependency inputs and the
previous desired identity. Partial failure retains all inputs and earlier
successes. A process crash between targets can resume the same request key.

## Meaning of results

- Configure/start/rollback/upgrade succeed only with native-checked, known,
  quiescent observation matching every desired identity field.
- Stop uses the accepted artifact package even if the mutable draft is invalid.
  It creates a new denied-policy generation and succeeds only after the scoped
  agent reports its owned runtime was actually restricted. It does not publish
  an active-route manifest and does not modify unrelated services.
- Install uses only a catalog ID from `GET /api/admin/core-releases`. Its result
  must match the exact adapter, version, platform and executable digest. This
  is installed evidence, never an active-runtime observation or route manifest.
- Missing reports remain queued while the bounded lease is valid. Expiry without
  an outcome is unknown (`lease_expired_without_observation_reconnect_agent`),
  not a guessed failure/success. Reconnect and reconcile before retrying.
- A newer desired identity marks uncompleted older attempts superseded. Exact
  historical success is retained separately from latest runtime state; later
  process shutdown cannot erase it. Later stages nevertheless check live state.

Rollback requires a successfully observed historic configuration for the exact
selected targets. It starts a new generation, copies historical configuration
but rebuilds principals from the current draft/current grants, excludes revoked
or inactive grants, uses current credentials, and rechecks current permissions,
scoped enrollment and a fresh lease. It cannot resurrect an old grant, credential
or allowance. Listener/inventory changes require explicit review; this is not an
automatic inventory or binary-version rollback.

## Bounded evidence

`model_test.go`, store compared-generation tests and HTTP fleet tests exercise
stage order, exact identity, no-report expiry, CAS races, authorization, stale
review, per-target enrollment failures, successful-result retention, credential
rotation/revocation, upgrade transition envelopes and catalog evidence.

`TestNativeFleetConfigureStopStartAndRollback` additionally runs two real pinned
Xray instances in private temporary directories. It verifies official cached
archive installation and native validation without activation, real scoped
CP→agent rollout, HTTP-over-authenticated-SOCKS loopback traffic, stop/start,
forwarding rejection and fresh-generation configuration rollback. It demonstrates
that unreported local completion remains pending at the control plane.

This does not establish real-VPS rollout, browser acceptance, sing-box runtime
startup on this restricted host, or a native upstream-to-upstream version upgrade.
The catalog currently has one reviewed version per stock adapter; distinct-version
migration process tests are explicitly synthetic. There is no fabricated official
managed-Xray artifact or same-version upgrade success. UI and full acceptance must
remain open until their separate required gates have actually run.
