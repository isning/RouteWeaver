# A02/A04 effective groups and connection-limit evidence

Scope: RW-03 and RW-14 backend/runtime closure, 2026-10-19. No real VPS, public service or real account credentials were used. UI work and the final full-repository acceptance gates are tracked separately; both tickets remain in progress.

## Red → green evidence

- New pure evaluator test initially failed to compile because PolicyInput/Group/ResolvePolicy and ConnectionLimit did not exist. It now passes one-group selection, conflicting tie denial and individual service/quota/route/connection precedence.
- Repository group preview/apply test initially failed because no effective-group repository interface existed. It now passes preview/result agreement, stale revision rejection and group-derived runtime admission.
- `TestConnectionLimitCountsIndependentStreamsOnSameIPAndRenewsAtCap` initially showed the third same-IP stream incorrectly allowed. It now denies it independently of the one-IP union, allows existing renewal, and admits a replacement after release.
- The real CP native fixture initially lost an existing mux stream when a new stream was denied. `TestMuxConnectionCapDeniesOnlyNewStream` reproduced `EOF` on the retained stream. Returning a closed logical native pipe instead of a carrier-fatal dispatcher error makes the regression pass without dispatching an outbound or admitting denied payload.

- Independent integrated review identified an undefined above-cap transition on cap reduction. `TestConnectionCapReductionRequiresExistingStreamsToFit` reproduced a successful unsafe reduction; the writer-transaction guard now rejects reductions below active stream/IP counts and accepts them once enough presences close.

- A self-review regression found first-group assignment could hide already-settled legacy consumption by assigning a fresh anchor: `TestFirstGroupAssignmentDoesNotEraseSettledLegacyUsage` observed 0 instead of 50 bytes. Historical legacy accounts now retain their implicit no-reset calendar; only unused accounts initialize a new service calendar. Existing live-budget calendars are preserved too.

## Positive focused checks

Executed successfully:

- `scripts/go.sh test ./internal/service ./internal/store -count=1` after the initial policy integration.
- `GOMEMLIMIT=768MiB scripts/go.sh test -race -p=1 ./internal/service ./internal/store ./internal/httpapi -run 'Test(EffectiveAccess|Group|PolicyPreview|ProvisioningPolicy|FirstGroup|Connection|AdmissionStatus|AccessPolicy|PublishedRoutePrincipals)' -count=1`.
- HTTP preview/apply tests verify admin authorization, tenant isolation, individual exact route replacement, paused status, ambiguity blockers and unknown membership rejection.
- Repository tests verify changed-content preview token rejection, a frozen initial cycle anchor, no partial writes on rejected quota/rate/calendar changes, first-calendar legacy usage/budget preservation, independent Store CAS writers, same-IP atomic connection claims, stale provisioning policy rejection and truthful lease status.
- `scripts/go.sh -C runtimes/xray test -run 'TestMuxConnectionCapDeniesOnlyNewStream|TestNativeMuxRetainedAuthenticationCannotResumeAfterRevocation|TestMuxNaturalCloseReleasesPresence' -count=1`.
- Rebuilt the managed executable from the pinned runtime using `scripts/go.sh -C runtimes/xray build -trimpath -o "$PWD/bin/routeweaver-xray" ./cmd/routeweaver-xray`.
- `ROUTEWEAVER_MANAGED_XRAY_BIN="$PWD/bin/routeweaver-xray" ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray scripts/go.sh test ./internal/httpapi -run '^TestNativePublishedManagedPrincipalEndToEnd$' -count=1 -v` passed in 17.38 seconds after the adapter fix; a subsequent focused `-race -p=1` run passed in 22.32 seconds (23.44 seconds including race shutdown). Alice obtains authorization through a real group; Bob retains an explicit individual service. The fixture includes actual principal provisioning, scoped HTTP admission, immutable desired packages, native apply, required real Xray transit, payload and canonical usage settlement.

Native independent-cap evidence: one normalized client IP supports one TCP flow and one mux stream at account cap two; extra TCP and mux streams cannot carry payload; existing streams renew under the same cap; a mux End frees a slot and a replacement stream succeeds. Full logical closure releases the remaining slots. Legitimate one-way TCP EOF is not falsely described as full stream termination.

## Standards and spec self-review

An independent integrated security reviewer separately examined the group/cap implementation and identified the cap-reduction issue above; the remaining review findings are tracked in the integrated report.

Standards: service policy remains transport/storage independent; persistence owns transactions and CAS; HTTP only adapts policy commands. No new external library was introduced for policy. The existing cached YAML parser was propagated into the nested runtime module graph after an unrelated root resource validator began using it. All new product APIs are administrator-authenticated and existing CSRF middleware applies.

Spec: groups are actual membership-based authorization, not CRUD decoration. Limits, routes, provenance, calendar preservation and preview blockers feed the same evaluator as native admission and budgets. Concurrent logical streams are independent of IP and rate limits. The real native mux failure was repaired rather than hidden or weakened in the test.

Limitations: these are focused positive and adversarial checks, not a formal proof or production-VPS acceptance. The terminal full repository gate and feature UI acceptance must be evaluated on the integrated revision. No skipped native invocation is counted as a pass. Existing conservative unresolved-byte-budget holds remain intentional.
