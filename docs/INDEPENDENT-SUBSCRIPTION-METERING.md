# Independent metering for managed platform subscriptions

Default-off backend capability, not a production rollout or migration of existing
users. Lifecycle, failure recovery and native upgrade compatibility are covered
by loopback tests. UI integration must be accepted separately before presenting
this as an available end-user workflow.

## Scope and honest semantics

Only newly created independent subscriptions using 1–16 existing managed
platform entries are eligible. Imported subscription sources, user-uploaded
endpoints, and stock core entries cannot be attributed by this control plane.
Existing outputs and all shared credentials remain unchanged. Historical shared
traffic remains unassigned; separate download links do not prove separate traffic
identities. Copying an independent credential still counts against its output,
not a physical device. Raw bytes use the existing managed payload meter, including
both directions, not an invented upload/download split.

## Default-off delegation

A platform administrator explicitly configures one principal delegation per
server deployment. GET/PUT /api/server-deployments/{id}/principal-delegation uses
an expectedRevision CAS. Enabling requires a supported confirmed managed entry,
allowed routes, 1–64 principals per user, 1–4 pending intents per user, an expiry
within 30 days and allowRuntimeRestart=true. Adding a principal reloads related
instances and can interrupt existing connections. It is not a zero-downtime claim.
No real environment is enabled by installation, tests, or a user creating a normal
subscription. Ordinary users cannot create or change a delegation.

The capability authorizes only additions for the requesting user's currently
entitled routes. It cannot publish unrelated drafts, change topology, alter old
principals, or impersonate the administrator. The tenant remains the operation's
audit actor. Continuous service retains its original authority reference with an
immutable migration receipt recording the limited delegation consumed.
Revocation/expiry prevents new provisioning; it does not revoke already published
independent outputs or implicitly disable unrelated continuous services.

## Durable creation

POST /api/me/outputs/independent reserves an output ID and encrypted principal
plan. Replaying the same ID and payload is idempotent; changing the payload
conflicts. Reservation does not write a grant, alter a deployment, or reveal a
credential. Normal output creation cannot steal a reserved ID.

The recovery worker advances a persisted, paginated queue. The prepare phase uses
an overlay: candidate grants/configuration are evaluated without changing the old
service's view. The final SQLite writer transaction verifies original records,
sets, entitlement, capability/deadlines, ownership and current observations, then
writes new grants, immutable attribution claims, budget bindings, all target
configuration generations, continuous-service transitions and the receipt.

A per-deployment provisioning lock prevents two independent requests from
superseding each other before final publication. It has no unsafe timeout unlock.
Only matching final publication or confirmed compensation releases it. Explicit
administrator edits take precedence and may require recovery rather than being
overwritten. Every target must already have stable continuous service and fresh,
known native evidence. Pending refreshes cause a retry, not a forced transition.

No feed is published until all migrations are exactly confirmed applied and the
isolated configuration renders successfully. Output, token and published intent
are committed together. New admission requires the published attribution intent;
a partial or failed creation cannot consume traffic under an exposed output.

GET /api/me/outputs/independent returns a bounded owner-scoped {items:[...]}
metadata list for recovering unfinished work across sessions. Capacity or invalid
records returns 503, never a partial list.
GET /api/me/outputs/independent/{id} returns owner-scoped lifecycle metadata, never
the private plans or credentials. States are reserved, provisioning, published,
cancelling, recovery_required and cancelled. Waiting for confirmed service is not
a successful deployment. The worker resumes after restart from persisted facts.

## Cancellation, partial failure and recovery

POST /api/me/outputs/independent/{id}/cancel removes that independent output and
its feed token atomically, denies new admission and enqueues cleanup. Already
issued budgets still settle exactly once. This is distinct from the existing
normal subscription link-revocation operation.

Compensation issues higher configuration generations. It removes only the exact
fresh principals identified by the migration receipt, preserves later unrelated
principals and every non-principal field, and revokes only their grants.
It never restores an old generation or overwrites the complete old deployment.
An already published output reacquires the same deployment lock before cleanup.
Capability revocation does not prevent precise cleanup of an accepted operation.
Unknown runtime state, changed ownership/authority, or unpublished administrator
edits are not guessed away: recovery_required retains evidence and the lock until
safe continuation is possible. Successful compensation and cancelled state must
be confirmed before the final lock/queue cleanup transaction.

## Ledger and UI data

Only trusted admission bindings may claim OutputID/OutputRevision. A budget pins
that attribution at issue time; settlement reads the snapshot, not mutable grants
or an agent-provided output ID. Generic counter submissions cannot forge it.
Deleted outputs retain their historical ledger attribution.

GET /api/me/output-usage returns asOf, windowStart, windowEnd,
period="current-cycle", outputs[{outputId,rawBytes,weightedBytes}], unattributedRawBytes,
unattributedWeightedBytes and complete. The window is the actual effective current cycle (including a manual reset)
through asOf, matching account insights. An unbounded cycle is not silently cut
to 14 days; if it exceeds scan capacity the result is unavailable. Aggregation
uses canonical owner-scoped ledger rows and retains unassigned history. It never
allocates account bytes according to downloads or IP addresses. Capacity, invalid
records, untrusted index or integer overflow returns 503, not partial totals.
Weighted sums round once per bucket, so the sum of buckets can differ slightly
from one aggregate's rounding. The UI must label missing source data unavailable,
not zero; it must not invent a per-IP subscription or last-active timestamp.

## Operational limits

New principal migrations have a persistent 60-second deployment cooldown and
a maximum of two per user/deployment in ten minutes. Failed transactions consume
no quota; exact compensation is exempt so cleanup cannot be trapped by throttling.

The optional path adds principals per output and route; it does not magically
scale like one shared credential per account. Apply/reload cost and retained
migration snapshots grow accordingly. Recovery evidence, grants and immutable
claims are retained; this implementation does not promise automatic historical
credential-data purging. The recovery queue is read in pages, and cancellation
is never refused solely because cleanup work is pending. No production hosts,
credentials or policies are changed by the synthetic/native loopback tests.

Reservation history reads are bounded to 1,000 records and 8 MiB per user;
capacity exhaustion refuses new creation instead of scanning unbounded history.
Completed history is not automatically purged by this feature.
