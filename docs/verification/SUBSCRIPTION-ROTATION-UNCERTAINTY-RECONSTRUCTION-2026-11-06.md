# Subscription rotation uncertainty reconstruction

## Identity and scope

New source reconstruction from baseline `a1fbbc301378e47489660791e68f8c50fcf2b93f` (v88). This does not recover the missing historical v129 commit or assert equivalence to its source. The accepted boundary for regression source is the public subscriptions UI with fetch stubbed at HTTP, not mocked internal hooks or services.

Changed source:
- `web/src/Subscriptions.tsx`: guarded rotation dispatch/result, response identity checks, unknown-state decision closure and explicit current-access UI.
- `web/src/subscription-rotation-state.ts`: ephemeral per-account-QueryClient pending/unknown marker, keyed by exact Output ID.
- `web/src/subscription-rotation-uncertainty.dom.test.tsx`: public UI/fetch-boundary regression source.

No backend, persistence schema, network API, or deployment changes.

## Contract inspected in actual baseline source

`internal/httpapi/outputs.go` loads the authenticated account's Output, replaces its token through `CompareAndPutWithToken`, then emits a response. A lost response can therefore follow a committed change. Rotation does not change the publication revision. GET `/api/me/outputs/{id}/access` checks current tenant-owned publication/readiness and returns current access, not a receipt for an earlier rotation. There is no request idempotency key or durable operation-recovery contract in this route. No backend code is changed here.

`SessionBoundary.tsx` creates a separate QueryClient per account epoch. `useWorkspaceViewEntry.ts` and `workspace-history.ts` supply a mounted/view/account lease. This patch checks that captured lease before submission, again after mutation preparation, and before result-driven UI. Standalone embeds must likewise use separate QueryClients for different actors; the marker cannot identify actors independently of its provider.

## Intended behavior (source review, not runtime acceptance)

- Rotation cannot auto-retry or wait offline for automatic submission. The exact Output receives a pending marker before the POST. Duplicate invocations cannot issue another POST while marked.
- Transport failure, body-read failure, malformed JSON, malformed/wrong-target 2xx, HTTP conflict, and other failure responses retain unknown state. This deliberately does not infer non-commit from an HTTP error.
- A successful HTTP response matching ID, profile, client target, mode and published status acknowledges rotation. This is a deliberately minimum metadata acknowledgment, not full response-schema validation. The endpoint currently also emits `feedPath` and `bundlePath`; this guard intentionally permits their omission. Those credential-bearing fields are neither consumed as acknowledgment evidence nor used for delivery: access is fetched separately through the authenticated current-access endpoint. Requiring their shape would couple acknowledgment to secret delivery fields without supplying a durable operation receipt. Returned credential paths are not kept as mutation results. Consequently, “malformed success” coverage here means invalid JSON, missing required identity/status metadata, or mismatched metadata, not rejection of every response that differs from the complete backend payload.
- A failed rotation closes the original confirmation, removing its now-misleading old-link cancel choice and repeated submit. The detail displays that the old link may be invalid and disables rotation.
- The explicit current-access action opens the existing authenticated GET task. Failed GET and retry cannot POST. Successful GET does not clear uncertainty or claim historical completion, old-link validity or safe repeat.
- Marker state survives closing/reopening details, navigation, and page remounts using the same account QueryClient. A different account QueryClient has independent state. Late responses do not reopen old tasks or show stale success notifications.

## Source-authored regression scenarios

The first failure/current-access regression was written before production edits. Subsequent source cases extend it to conflict and body-read errors, retained confirmation after page unmount, same-client remount continuity and separate-client actor isolation. Existing `replacement-access.dom.test.tsx` contains successful rotation, cancel, read-only access retry and pending navigation coverage; those existing cases were inspected, not executed. Tests observe visible text/actions, credential delivery and actual HTTP paths. They do not assert internal marker storage.

No red or green execution is claimed. Every new/existing behavioral test, typecheck, lint/format check, build, Go suite, browser/server flow, and aggregate verify gate is **UNRUN**, under the source-only restriction. `git diff --check` is only a textual whitespace check, not application validation. Independent runtime review remains **UNRUN**.

## Remaining limits and next acceptance

This is an in-memory safeguard, not durable recovery. Full reload, browser restart, logout/new account epoch, or a replacement QueryClient loses the marker; the backend cannot reconstruct the uncertain attempt. No local/session storage, URL, clipboard or persisted credential recovery journal is added. A never-settling request remains pending; there is no invented timeout receipt. This patch does not create a safe repeat path after uncertainty, and no general all-write safety claim applies to revoke, publication or other flows.

Access response validation and external-client behavior remain the existing implementation; this change does not prove links work in clients. Visual layout, focus after confirmation failure, desktop/narrow screens, session integration and actual backend authorization remain **UNRUN**. A separate-client DOM fixture is not end-to-end authentication evidence.

When execution becomes authorized, follow page-by-page acceptance: confirmation target/consequence and cancel; pending/double submission; each uncertain failure and no automatic access/repeat; explicit access failure and success with warning retained; close/reopen/navigation; account departure before dispatch and during response; full reload limitation. Review actual rendered copy and focus, then the applicable focused tests/typecheck and serialized aggregate gate. Do not substitute test totals for those acceptance decisions.
