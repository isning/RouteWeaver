# Continuous agent recovery — scoped design

Status: implemented in paired agent/CP changes; see [acceptance evidence](../verification/CONTINUOUS-SERVICE-CP-2026-10-31.md). This is not unattended production
deployment or soak acceptance. Manual behavior remains the default.

## Existing constraints

- `RunDriver` now has explicit foreground `Continuous`; cancellation stops only
  verified owned runtime and retains journals. `Submit` never repeats a generation.
- Current reports use `Observed=nil` for absence *and other cases*. Nil alone is
  not proof. Pending launch, identity mismatch and descendants remain unknown.
- `recordAgentObservation` CAS-fences desired, enrollment and operation history.
  `prepareFleet` and `queueFleetTarget` already recompile current inputs, refresh
  principals, fence ownership/enrollment and generate new desired identities.
- Fleet policy leases last 30–3600 seconds. The baseline had no ongoing lease producer.
  A changed lease conflicts with the same-generation RequestDigest; a new desired
  generation currently activates again. Neither must be silently weakened.

## Opt-in and desired running state

Use a reviewed, fingerprinted recovery option on an existing fleet start/configure
plan, absent by default. Limit the first implementation to these actions; no
implicit upgrade, rollback, installation, enrollment or ownership transfer.
Persist per-instance service intent atomically with the queued desired generation:
source reviewed batch, exact current desired identity, enabled/running intent,
originating administrator, attempt count, next eligible receipt time and block code.
The initiating administrator must remain authorized; current principal grants,
credentials, quota, enrollment, routes and artifacts are revalidated before work.

Any later explicit stop or non-opt-in replacement supersedes/disables the service
intent in the same desired-generation transaction. Operator maintenance means
queue a stop/disable intent first, then terminate the agent. Stopping the agent
alone drains it but does not revoke a previously explicit running intent.
A clean shutdown report never itself schedules a restart. Only a newly active
service driver with fresh known absence may request recovery after startup.

## Facts and freshness

The service heartbeat adds a narrow credential-free observation fact, not a new remotely callable
mutation primitive: service driver active/draining plus last bounded runtime
observation (known, quiescent, absent, observation time, exact desired identity).
It is set only from the actual adapter observation in the serialized lane, never
inferred from cached State fields. Unknown observation clears eligibility.

CP accepts it only under the existing scoped agent authentication and exact
current identity. Persist server receipt time; do not treat agent wall time as
freshness authority. Only the current active service report may trigger work,
not historical successful operation archives or delayed final shutdown reports.
Fences include the exact freshly received observation and service-intent record.
Older/unknown agents without explicit facts remain manual.

## Recovery operation

For active service + proven absence + current running intent:

1. Read the durable attempt budget; honor its server-time backoff. Repeated reports
   of the same failed generation cannot spend multiple attempts or queue duplicates.
2. Re-run the existing compiler/authority checks for the reviewed deployment. Do
   not clone the old rendered bytes or PolicyLease. A changed authorization,
   enrollment, owner, reviewed configuration, or unsupported adapter blocks and
   requires administrator review rather than broadening consent.
3. In one CAS/generation transaction fence current desired, latest observation,
   service intent, enrollment, authority/input records and relevant record sets;
   persist new generation, fresh bounded lease, publication manifest, audit record,
   attempt increment and next eligible time. Reuse existing queue-generation logic
   rather than introducing a second unsafe compiler path.
4. Bound retries (3 automatic attempts per reviewed intent;
   5/10/20-second server-time delays). Persist all state across CP/agent restart.
   Failure cap produces visible `crash_loop_blocked` in existing instance/fleet
   inspection; GET is read-only. No worker process endlessly retries unknown work.
5. Successful activation does not automatically erase the attempt budget. A new
   administrator-reviewed plan explicitly resets the budget; this prevents an
   oscillating core from generating unbounded journal/history growth.

Polling observations can drive eligibility, avoiding a new daemon/scheduler.
CAS conflicts cause a fresh future observation/review, not blind mutation replay.
When CP is unavailable, bounded existing authorization expires and runtime closes.

## Independent lease renewal

Recovery alone does not establish continuous service: a healthy runtime otherwise
stops at its instance lease expiry. Do not hide this with a larger lease or repeated
native restarts. The implemented extension is a current-identity-bound monotonic
policy refresh, separate from immutable activation Desired, journaled before use.
The authenticated CP re-runs current compiler/authorization fences and may renew
only unchanged authorized active intent. Refresh must never activate an absent or
unknown runtime, resurrect a stop/denial, reset clock high-water, or change artifact
identity. An expired/offline lease still fails closed. POST `/api/agent/instances/{instanceId}/service-heartbeat` uses the existing
scoped enrollment bearer and strict protocol decoding. CP persists a monotonic
sequence and pending grant before responding; lost-response retries return the
same grant while old authority remains valid. Manifest expiry advances only on
actual-live acknowledgement of the durably applied grant. Original Desired and
RequestDigest stay unchanged. Agent policy timestamps only identify a receipt;
CP server time issues authority. Compiler work is durably throttled to five
seconds per intent. Atomic writer guards recheck canonical current policy, routes,
quota and holds alongside input CAS and commit-time freshness/lease deadlines.

## Public-seam acceptance tests

- Default/manual unchanged; opt-in must appear in preview fingerprint and execution.
- Real service restart/proven child death obtains one newer generation, not replay.
- Unknown, unquiescent descendants, missing evidence, stale identity/receipt,
  draining shutdown, explicit stop/maintenance, revoked actor/principal/enrollment,
  changed ownership/configuration and quota uncertainty cannot auto-activate.
- Concurrent CP handlers and restarted DB handles cannot duplicate an attempt;
  pending desired remains pending until observation, not another recovery trigger.
- Backoff and cap survive reopen; crash-loop status visible; only fresh reviewed
  admin action resets it. Audit associates automatic attempt with standing intent.
- Lease renewal under unchanged valid intent preserves native process identity;
  old/duplicate/out-of-order refresh cannot revive denial or unknown mutation.
- Isolated end-to-end CP/driver tests plus bounded soak precede any readiness claim.
  Real host/reboot/network/production enrollment and sing-box host restrictions
  remain external acceptance gates, never bypassed by this implementation.
