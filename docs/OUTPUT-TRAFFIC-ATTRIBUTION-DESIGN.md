# Per-output traffic attribution: safe implementation boundary

This is an implementation design, not an enabled feature. No existing credentials
are migrated or rotated by the fetch-history or IP-metadata changes.

## Why current totals cannot be split

Existing profiles select platform entry IDs and can share the same credential
across outputs. Downloading a subscription records configuration delivery, not
proxy traffic. A counter's route or client IP does not identify its output.
Managed admission-budget ledger rows use the meter ID "admission-budget" and
carry a budget ID: grouping only MeterBinding cannot attribute this traffic.
Historical shared-credential traffic must remain explicitly unassigned.

## Opt-in flow for new outputs only

1. Reserve a draft output ID and an idempotency key before allocating principals.
   Store a lifecycle state, ownership, selected entry snapshot, and intent.
2. Create fresh principal/credential per output and entry. Bind an immutable
   output ID to principal, grant, admission binding and budget snapshot.
   Credentials must never be reused across independent outputs.
3. Prepare deployment configuration using existing revision/review mechanisms.
   Output remains unpublished while deployment is pending.
4. Require confirmed applied runtime revision before generating the new output
   from its frozen credential mapping. A successful render alone is insufficient.
5. Counter/budget ingestion resolves the immutable output attribution snapshot,
   validates account/entry scope and posts exactly-once ledger records. Reject
   conflicting mappings. Revocation must not destroy historical attribution.
6. Aggregate daily bytes by output ID and time window, retaining an unassigned
   bucket. A copied credential still represents one output, not one device.

## Transaction and failure handling

The database reservation, grant/binding creation and idempotency record need one
transaction. External runtime deployment cannot join that transaction, so use a
durable state machine and retries: reserved -> provisioning -> applied ->
published, or failed/revoked. Retry the same intent, never issue duplicate
credentials. Failed provisioning leaves the old output working. Cleanup must
wait until no published output references the new credential. Output edits need
new immutable dependency revisions, not retroactive remapping of old budgets.
Deleting an output hides it but retains ledger attribution required for totals.

## Cost, migration and acceptance

Runtime principal cardinality increases from roughly users x routes to outputs
x routes; cap outputs and fan-out, benchmark representative runtime reload and
counter volumes, and enforce lifecycle cleanup. Database schema, backup/restore
compatibility, ingestion, provisioning, output rendering and UI must be delivered
as one coherent flow. Existing output creation and all legacy credentials stay
available. There is no safe numerical estimate for historical reassignment.

Before enabling: concurrent/retried create transaction tests, interrupted deploy
and rollback tests, real runtime applied-revision/credential-counter round-trip,
cross-account rejection, duplicate sample handling, revoked credential handling,
and backup/restore with immutable attribution are required. Use disposable local
runtimes and synthetic credentials; never migrate production to prove the flow.
