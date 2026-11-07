# Bundle access and rotation source reconstruction

This is newly authored source based on recovered contracts, not restoration of v116 or historical test parity. The missing historical commit is `93a0f73bc2456fba3234b37ad1e1a0efd93bc20b`. Base: `2a7f5cc5838f165294fd3ed476f1436f69ab3213`.

## Contract and changes

- `internal/httpapi/subscription_origin.go` advertises the authenticated `/api/me/outputs/{id}/bundle` endpoint. `output_bundle.go` serves `application/zip` and performs tenant lookup and delivery authorization. These contracts were read, not executed.
- Cookie-mode access retains a native download link. Token-mode access uses the existing authenticated API transport, a fixed output-ID-derived endpoint, same-origin credentials, and rejects redirects. Access metadata cannot select a credential-bearing fetch destination.
- A token revision (including change-away-and-back), session transport identity, and actual session generation guard fence results after body consumption and again immediately before initiating download. Task closure/unmount, changed output identity/revision, and nested review ownership suppress obsolete download effects. An in-flight latch prevents repeated clicks. Blobs are not put in query caches or persistent storage; the temporary object URL is revoked.
- Response errors, unexpected media types, and body-read failures do not initiate downloads. The user can explicitly retry. No download-complete or client-import-success claim is shown.
- Confirmed bundle credential rotation says the existing bundle content is unchanged and does not require reimport solely because of rotation. Feed rotation retains its client-link replacement consequence. Existing uncertain-rotation state, session scope and mutation handling were not changed.

## Newly authored public DOM regression source

`web/src/bundle-access-recovery.dom.test.tsx` covers conditional cookie/token delivery, ignored external metadata destination, synthetic authenticated requests, repeated pending clicks, token ABA, actual SessionLifecycle account change, closure, output revision changes, uncertain-vs-confirmed rotation copy, and network/auth/media/body failures. The fetch boundary and browser download boundary are synthetic; internal modules are not mocked. Tests contain only fabricated operator values and synthetic archive bytes. Native saving is not exercised.

## Evidence and limitations

- Git whitespace validation and manual source/contract review only. No red/green claim: tests were authored but never executed.
- Behavior tests, typecheck, build, browser, native-save, real authentication, backend and client-import checks: **UNRUN**. No Node/npm/Go/gofmt/server/install/network/push/deploy/upload or native save was used.
- Historical v116 pass counts are not evidence for this candidate. This is not whole-product acceptance and does not close backend, native-runtime or live-node gaps.
- No source secrets, real accounts or real bundle contents were accessed. Token strings in tests are synthetic. Runtime operator credentials are used only by the existing API header transport; no new persistence or credential-bearing URL is added.
- Residual verification includes actual cookie/native download behavior, browser object URL/save lifecycle, session recovery during body reads, UI accessibility and visual review, and focused plus aggregate checks on the final integration.

## Independent source review follow-up

Review identified a passive-cleanup unmount window and an ABA case: cancelling nested review does not advance `readGeneration`. Download ownership now uses a monotonically increasing layout-lifetime epoch, revoked synchronously during commit on close, unmount, nested review, or identity/read-generation change. Returning to identical inputs cannot restore ownership of a previous download. The existing query and rotation lifecycle is unchanged. Additional source-only deferred-body regressions cover direct unmount and reconnect/readiness change followed by nested review cancellation before settlement. The API helper's two `beforeRequest` captures were inspected: both are synchronous in the same dispatch turn, and the original session/token fences remain checked after the body and before native handoff. No runtime validation was performed.
