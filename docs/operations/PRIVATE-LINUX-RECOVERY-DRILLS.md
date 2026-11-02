# Private Linux service: recovery checks

For the selected single-control-plane, invitation-only Linux profile. These are
owned-loopback reference drills and an operator checklist, not permission to
change a real host or a deployment RTO/SLA. No stock core, browser, real provider,
external destination, firewall, sysctl or host security setting is involved.

## 1. Notification failed or retrying

- Read the authenticated administrator endpoint
  `GET /api/admin/notifications/outbox`. Record event ID, status, attempts,
  sanitized last error and next-attempt timestamp. Saving settings is not delivery.
- For a retryable failure, observe the recorded backoff rather than repeatedly
  creating test events. After a worker restart the same event ID must be retained.
  `accepted` is transport acceptance, not evidence that a human read a message.
- If retries reach terminal failure, review configuration and the bounded retry
  policy; use a separately authorized explicit test after correction. Never expose
  provider passwords/signing keys in incident notes or infer delivery from silence.
- Evidence: `TestOperationalNotificationFailureVisibleAndRetry` joins a synthetic
  failing transport to the real persisted outbox and real HTTP read endpoint.
  It then advances the logical retry clock and verifies accepted status and no
  resend. `TestDurableOutboxRestartStableIdentityAndBoundedRetries` separately
  closes/reopens storage and verifies stable identity/bounded terminal failure.
  No provider network delivery is claimed.

## 2. Node/control-plane link is interrupted

- Inspect `GET /api/agent/instances/{instanceId}/state` with administrator access.
  Compare desired/observed identity and the observation timestamp. A retained
  last observation is not a fresh health report; do not promote intent to health.
- Preserve the agent's private state and generation fence. Restore the authorized
  connection, then require a newer observation and actual fresh admitted payload.
  Do not delete journals or lower the generation to make a stale node look ready.
- Existing admission leases are bounded to 30 seconds; loss of authority cannot
  grant new rights or extend a lease. Network recovery and accounting recovery
  are separate: an expired flow can leave a still-held byte reservation.
- The reference fixture injects HTTP 503 only in its own transport. A request
  barrier drains admitted calls before disconnect, avoiding timing-based drains.
  Tests distinguish a brief reconnect from actual native lease-expiry restriction.

## 3. Interrupted metering or unresolved quota

- Preserve the native baseline/final journals, meter spool, exact receipts,
  control-plane database and encryption key under existing private custody.
  Missing final acknowledgement is **not** permission to refund the reservation.
- Inspect `GET /api/agent/instances/{instanceId}/admission-budgets` and
  `/admission-anomalies`. Keep raw entry-payload bytes separate from provider NIC
  bytes and weighted billing. Never invent a zero baseline or reset an epoch.
- Explicit `/admission-budgets/finalize` is an operator attestation: require an
  actually stopped owned runtime, reviewed final measurement, current digest,
  reason and evidence. Preserve the resulting audit record. Do not assert
  `runtimeStopped` while the core is still running, and do not blindly replay a
  conflicting resolution. This checklist is not authorization to finalize a
  real account's quota.
- The EOF drill uses real native payload/final counters and checks identical
  baseline/final meter batches after spool reopen/recollection. Matching receipts
  in that spool-only portion are synthetic, not proof of CP delivery. The joined
  managed drill separately compares actual traffic with CP raw/weighted usage.
- The encrypted-restore obligation regression reserves 100 bytes, preserves the
  pending hold through restore, settles 30 once despite replay, makes exactly 70
  available, and leaves the original live database unchanged. Counter replay and
  new-epoch anomaly tests run separately; they are not fabricated native traffic.

### Closed-runtime evidence custody

Both the control plane **and node agent** must support terminal custody. A live
meter ACK, even with the same byte count as a later final, is not proof of closure.
The agent sends a separate terminal-only meter envelope after prior counters are
ACKed. It contains the genuine zero baseline and quiescent final, scope and native
epoch, and a canonical SHA-256 evidence digest. The CP verifies historical meter
bindings and already-durable cumulative values, then stores the original envelope
and receipt atomically in the existing encrypted meter history. This operation
changes neither usage counters nor admission budgets.

Local journal GC requires the explicit version-1 custody ACK for that exact proof.
Pending proof and acknowledged-but-not-yet-retired custody survive restart; the
existing retirement WAL removes files durably before cursors and its bounded
custody entry. No terminal tombstone history accumulates on the agent. Limits stay
at 1 MiB per envelope, 1,000 counters per snapshot, 128 pending batches/custody
entries and 8 MiB spool state. The 1,000 count is a ceiling, not a promise that
all 1,000-binding metadata combinations fit. Managed rendering, agent native
validation (before executable probing/replacement), and runtime configuration
validation reject a conservative final-evidence upper bound above 1 MiB. The
bound uses actual binding metadata, both snapshots, future uint64 counter growth,
35-character timestamps, shared native epoch lengths and escaped scope/wrapper
headroom. An initially small zero snapshot is not sufficient. On
`MANAGED_TERMINAL_CAPACITY_EXCEEDED`, reduce the principal count or metadata before
activation; bindings are never silently dropped and an otherwise healthy previous
configuration is not replaced just to discover the capacity failure at shutdown.
Oversized or undeliverable proof retains the local
journals and backpressures collection; do not delete evidence to restore service.
The capacity preflight applies to activation, not withdrawal: explicit agent
stop/revoke and Fleet stop remain available for legacy oversized configurations.
Manual publication with explicit `accessAllowed: false` uses restriction-only
rendering that skips only this new capacity check; all existing
structural/capability/credential validation remains. Normal review/render and
any subsequent activation still enforce capacity. Manual denial still needs the
exact previously reviewed fingerprint; a new oversized review does not issue one.
If unavailable, use dedicated Fleet stop or owned agent stop, not a review bypass.
Denial is carried by the
existing authenticated desired-policy lease and publication-intent binding, not
by a new signature or custody protocol.

CP raw history remains subject to existing capacity monitoring and encrypted
backup limits, not an automatic deletion policy. Orderly shutdown may first send
new final raw samples; terminal custody can require a subsequent collection after
restart. A successful stop is not a promise that custody was already delivered:
check the explicit receipt or retained journal, never infer it from process exit.

An administrator can retrieve one retained proof with
`GET /api/agent/instances/{instanceId}/meter-terminal-evidence?enrollmentEpoch=...&streamEpoch=...&sequence=...`.
If the stream or sequence is no longer in the local spool, discover locators with
`GET /api/agent/instances/{instanceId}/meter-terminal-evidence/receipts?enrollmentEpoch=...&cursor=...`.
Use the enrollment from the unresolved budget's scope; the stream need not be
known. Pages follow lexicographic receipt-key order, not chronological order.
Start without a cursor, then follow the returned signed `nextCursor` while
`hasMore` is true, even when a page contains no terminal items. A page examines at
most 16 indexed rows (including lookahead), decrypts at most 15 rows / 2 MiB,
returns summaries only, and has a two-second deadline. Cursors cannot cross scopes.
Malformed or oversized records fail closed rather than being silently skipped.
The exact-proof response revalidates the stored scope, sequence, batch digest and
receipt and is bounded to 1 MiB. The returned proof is agent-reported runtime evidence: account/subject/
route/policy/cycle are checked against immutable meter bindings; entry/tag/
credential context is not an independent per-flow settlement attestation.
A runtime aggregate cannot assign final totals among several unresolved presence
budgets. Review that attribution separately; custody never authorizes a refund.

Compatibility and recovery boundaries:

- New agent + old CP: unknown terminal fields are rejected, or a response lacking
  the explicit custody ACK is refused. Journals remain; restore compatible CP
  service instead of treating an old ACK as terminal custody.
- New CP + old agent: legacy metering still works, but the old agent does not send
  terminal evidence. CP upgrade alone does **not** fix its local retirement.
- Spool schema 1 is durably upgraded to schema 2 before collection. Old agents
  reject schema 2; do not manually reset it for a binary downgrade. Preserve a
  compatible binary and state copy for reviewed recovery.
- A legacy retirement WAL without terminal custody, including a partially deleted
  journal pair, fails closed for explicit investigation. Already-erased legacy
  final evidence cannot be reconstructed from equal live counters.
- Canonical encrypted backups preserve the full original terminal envelope as raw
  data. Fresh restore/reopen must still return the same scoped digest and proof;
  never rewrite retained envelopes through a legacy typed meter projection.

## 4. Backup while service is running; restore safely

- Keep normal traffic and authoritative state checks running during the reviewed
  backup operation. Require a complete authenticated archive; discard incomplete
  output. Measure both export and fresh validation/restore/reopen time.
- Restore only to a separate private destination with the correct key. Verify
  identities, configuration and outstanding accounting obligations. A successful
  restore does not activate the new database or authorize a live inode swap.
- Stop all writers before any separately approved activation. Keep the original
  database and recovery path; do not assume in-place schema downgrade is safe.
- The joined drill performs encrypted backup while real native echo exchanges
  continue, authenticates/restores a fresh copy, checks exact desired identity,
  and verifies the original runtime/flow remains usable. Separate streamed-export
  concurrency tests hold the snapshot emitter while admission/config writes
  finish; the small traffic fixture is not backup-under-production-load evidence.

## Execute the bounded reference drills

Use the repository's real Go toolchain and its already approved local workspace.
The core is built from this source; no upstream executable download is needed.

```sh
scripts/go.sh -C runtimes/xray build -trimpath \
  -o "$PWD/bin/drill-managed-xray" ./cmd/routeweaver-xray
export ROUTEWEAVER_MANAGED_XRAY_BIN="$PWD/bin/drill-managed-xray"
export ROUTEWEAVER_OPERATIONAL_DRILL=1
unset ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS
GOMAXPROCS=1 GOMEMLIMIT=256MiB scripts/go.sh test -json -race -p=1 \
  -count=1 -timeout=180s \
  -run '^TestNativeManagedOperationalRecovery$|^TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal$|^TestOperationalNotificationFailureVisibleAndRetry$' \
  ./internal/httpapi ./internal/agent
```

All three named tests must pass; a missing test or skip is not evidence. The
existing default native continuous/revocation test remains separate. Go scheduler
and soft-memory settings above apply to the parent test/CP, **not** to the native
child (the supervisor sanitizes its environment). Hard CPU/RSS limits are unknown.
The test timeouts bound fixtures; measured durations are not target recovery SLAs.

See [the companion verification record](../verification/OPERATIONS-DRILLS-2026-11-01.md) for exact source/binary binding, executed
race tests, measured timings and limitations. A real service still needs its own
provider delivery, target storage/key/TLS configuration, representative traffic,
OS/power-loss recovery, retention/capacity and explicit RTO/RPO acceptance.
