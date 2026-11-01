# K04 opt-in managed provider suspension

Scope: single control plane, existing managed-Xray connection-admission path. This implements configurable provider exhaustion behavior without automatic route/exit changes. Default `advisory` is unchanged. It does not stop stock core traffic, downloaded external credentials, other host programs, or provider billing itself.

## Operator contract

- `suspend-managed` is explicit opt-in, only with limited quota and an explicitly selected `provider_statement` or `nic_estimate` source. Saving it requires a confirmation explaining affected host, new connections, renewals, unknown/stale evidence, and stock limitations.
- A host must contain a managed-Xray instance to configure this mode. Other stock/inactive instances do not invalidate the host's managed capability; their traffic is not controlled by this policy.
- The manual statement source is an operator-entered record, not an automatic provider API. NIC data must have a reconciled baseline. Missing, partial, wrong-cycle or older-than-15-minute selected evidence fails closed; the policy never substitutes another source or pretends missing data means zero.
- Known exhaustion returns `provider-exhausted`; unavailable evidence returns `provider-usage-unknown`; configured service expiry returns `provider-expired`. The operator view exposes the same reason. Advisories remain non-enforcing, even when evidence is stale.
- Entry and every exact applied route hop are checked within the admission transaction. An unrelated host cannot block that route. Current immutable manifest node identities, not arbitrary current inventory placement, select the hop policy.
- Acquire and renewal are denied under pause. Existing short leases remain bounded by the existing runtime mechanism; issued expiry is additionally clipped to evidence freshness, cycle end and provider service expiry. This is not an instantaneous kill or zero-overshoot guarantee.
- Updating selected current evidence to an available state, or explicitly choosing advisory, permits later admission after all other policies pass. It does not resurrect old connections or waive unfinished accounting. Final reports and budget closure are processed before this guard, preserving settlement obligations.
- User quota, charging multiplier, selected route, public credentials and provider raw measurements are not modified by this policy.

## Verified public seams

- `observability.ManagedAdmission` and `ViewOf`: explicit source, unknown/stale/partial coverage, cycle mismatch, exhaustion, expiry, recovery and freshness lease ceiling. Compile-red tracer preceded implementation; subsequent cases verify the completed policy. No claim of all-state formal proof.
- Store public configuration, statement recording and `AcquireAdmission`: a two-hop applied fixture checks transit policy, unrelated host isolation, renewal denial/recovery and final closure. Two Store handles exercise concurrent policy write/admission and subsequent committed denial. Stock-only rejection leaves settings unchanged.
- Real HTTP configuration: anonymous 401, ordinary tenant 403, administrator save, stale revision 409, visible unknown/exhausted reason from operator-entered statement. Initial test used an incorrect route and returned404; corrected to existing `/provider-statement`, no production route changed for the test.
- Real rendered-component DOM: explicit consequences/host, cancel without writes and exact focus return, then one confirmed save preserving the selected action/source. Source typecheck passes; no native browser geometry claim.
- Focused race tests for provider, existing node observation, managed manifest and renewal behavior pass. Static gate and seven tests across observation footer/model pass.

Actual provider-policy-to-native-flow closure/recovery is still a separate pending joined runtime case at this checkpoint; existing generic lease tests do not substitute for it. No real provider API, host settings, VPS, CI or publication was used here.

## Joined native follow-on

`TestNativeManagedProviderSuspensionAndRecovery` now passes with `-race` against the actual locally built managed-Xray executable, owned loopback only, 46.49 s, zero skips. It reuses the continuous-service fixture after the original instance lease has expired, then:

1. Applies a fresh provider statement and explicit suspension mode, then records exhaustion. The active native flow closes in 3.041 s; a new native flow is denied.
2. Records available current evidence and proves a new actual payload connection succeeds.
3. Requires an explicit second exhaustion decision and actual closure before checking final obligations. An initial attempt incorrectly assumed manually closing client TCP implied managed-flow closure within 5 s; that run failed (exact114-byte totals matched, but one flow was still active). The corrected scenario preserves all final closure/accounting assertions and uses the operation being accepted, not a larger arbitrary cleanup timeout.
4. Starts an explicit new provider cycle and records a statement with about four seconds of freshness remaining. A real new reservation is no later than the statement freshness boundary, and its native flow closes in 3.872 s. Stale evidence denies new flow; fresh evidence restores admission.
5. Confirms142 exact raw and weighted payload bytes agree in native counters and control-plane usage; corresponding budget records all have closed state, no unresolved obligation, and settled totals sum to142. Runtime identity is unchanged. Existing mandatory credential revocation and cleanup then pass.

Receipts: [source/binary binding](evidence/PROVIDER-NATIVE-2026-11-01.json), [raw test events](evidence/PROVIDER-NATIVE-2026-11-01.jsonl). They establish this finite synthetic flow, not whole-provider billing accuracy, all network topologies, stock enforcement, zero overshoot, or production SLA.

The existing managed CI gate now requires this fifth named native case. Offline gate tests reject missing, skipped and failed provider results. Its per-package timeout is240s to accommodate the additional bounded sequence, rather than weakening runtime lease deadlines; no new job or external CI was triggered here. The initial real browser-layout limitation remains open.

## Downgrade and restore boundary

Enabling `suspend-managed` atomically records semantic migration 3 with the policy, without physical DDL. Advisory-only databases remain at migrations 1–2. Switching back to advisory deliberately does not remove the marker. A pre-feature control plane must not open this data: otherwise it could silently ignore the enforcing policy. Rollback to an unaware binary requires an appropriate **pre-enablement backup**, stopped service, and the documented restore/reconciliation procedure; disabling the switch is not a database downgrade. Portable backup envelope version 2 remains unchanged, but does not imply old-reader semantic compatibility.

Current readers reject enforcing records without their migration marker on database open, snapshot import and streaming import. Failed imports leave the target unchanged. Focused race tests cover persistent marking, fresh restore, missing-marker rejection and unchanged encrypted metadata on refused open. Full store and backup suites pass. The actual pre-feature `eafb493` store executable, built against its original code with the small committed synthetic probe, rejects the physical database, plaintext snapshot and valid encrypted streaming archive. Its streaming decoder intentionally exposes a generic invalid-backup error; the rejection is not presented as a detailed migration diagnosis. New-reader preview first verifies that archive is valid. The probe uses only generated fixtures, not production backups or secrets.

Probe source: `scripts/testdata/provider-downgrade-probe/main.go`. Reproduce by running `generate DIR` against this source version, then `reject DIR` using the same probe compiled against `eafb493`. The native receipt binds probe source and old binary hashes. The final native run above includes the migration fence.
