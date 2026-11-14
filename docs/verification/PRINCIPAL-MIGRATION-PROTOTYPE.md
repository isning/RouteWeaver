# Principal migration integration branch (not production acceptance)

This is an experimental, default-off delegated provisioning path. No production
capability has been enabled. It requires existing continuous service on every
instance of a deployment, current inherited authority, no pending policy refresh,
and fresh exact runtime observations. Each new identity is restricted to the
requesting account's entitled routes. Non-principal configuration and all legacy
principals are immutable in an addition.

## Transactions and evidence

Preparation reads candidate deployment/grants through an in-memory overlay.
Compare-and-swap records bind original values and sets; post-commit authority
hashes bind the candidate values. A single writer transaction combines all desired
generations, grants, attribution claims, new service intents, fleet batch, receipt,
provisioning lock, and coordinator state. Failure consumes no generation.

Per-deployment principal-provisioning-locks serialize self-service operations
until final output publication or confirmed compensation. They do not expire
silently; unknown runtime or conflicting administrator changes require recovery.
An administrator operation may still supersede provisioning. No self-service
recovery overwrites administrator changes or assumes a failed process stopped.

Compensation derives only the exact newly introduced subjects from immutable
manifests, removes those subjects from the current configuration, and revokes
only their grants. Other additions and all other settings remain untouched.
Compensation queues a new generation, never reinstalls an old generation ID.
Current inherited service authority and policies remain required. Disabled or
changed authority can therefore require explicit operational recovery rather
than unsafe automatic resurrection. Consumed capability revocation does not
prevent otherwise-authorized exact cleanup or kill existing continuous service.

## Resource/retention limits

Candidate overlay and serialized migration receipt are each capped at 8 MiB.
An over-limit receipt fails inside the writer callback before any record or
counter is committed. Receipts contain encrypted recovery snapshots, including
old artifacts. Evidence is NOT automatically deleted. Storage can grow with
historical operations; this is not an unlimited-scale audit archive. Operational
retention/export/compaction and aggregate evidence budgets need an explicit
policy before a general rollout. Do not delete active receipts, claims or locks
as a shortcut: continuous-service authority and unsettled traffic depend on them.

## Validation

Synthetic tests cover structural confinement, stale-capability CAS rejection,
all-or-nothing multi-generation writes, exact post-commit authority hashes,
serialized provisioning, and precise compensation after capability revocation.

The opt-in native test uses local managed Xray + stock Xray transit and persistent
reconcilers across generations. It checks real old/new-credential forwarding,
output-attributed payload settlement, a real 30-second lease renewal/ACK window,
and old-credential continuity after compensation. Native process restart can
interrupt existing connections; this capability is explicitly restart-permitting,
not advertised as zero-downtime hot user injection.

## Restart admission rate

New-principal migrations consume persistent, CAS-fenced sliding-window records
in the same writer transaction as desired generations: at least 60 seconds
between additions per deployment, and at most 2 additions per owner/deployment
in 10 minutes. Aborted transactions consume neither counter. Replayed plans
cannot overwrite committed records; the migration receipt CAS also prevents
requeueing an already committed operation. Cleanup compensation is exempt so
rate limiting cannot strand removal. Clock rollback fails closed until the
stored timestamps catch up. Rate records are not part of runtime authority.

## Legacy continuous-service digest compatibility

Path-proof dependencies are accumulated separately and appended to transaction
CAS only after historical authorization hashes have been calculated. They must
not enter the standing continuous-authority digest: introducing host/inventory
records there would invalidate older wildcard-transit services on upgrade.
The test fixture freezes refreshFleetPrincipals from baseline commit
68cbef565d728d6c562c3e876bf74b75be0d83b9 (name changed only), exercises a wildcard
transit listener, and reproduces the unsafe mixed-proof hash difference. It
checks the fixed nil-overlay projection equals the old implementation and that
path dependencies still remain CAS-fenced. The native test persists the legacy
implementation's digest into the original fleet receipt and requires a real
30-second service lease renewal/ACK before provisioning any new principal.
No existing production hashes, credentials, or authorizations are rewritten.
