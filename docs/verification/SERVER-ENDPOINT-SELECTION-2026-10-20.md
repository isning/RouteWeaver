# Server-first endpoint selection, 2026-10-20

## Delivered scope

- The ordered server-route editor chooses a server and then one of its endpoints, with no mandatory instance-selection layer. Server changes clear the displayed incompatible endpoint, and saving waits for an explicit endpoint choice. The stored draft is preserved until a complete replacement is successfully resolved.
- Public-route path selection uses the same adjacent controls, limited to the selected deployment's endpoint and instance snapshots. It does not broaden endpoint eligibility; preview continues to validate the actual forwarding order.
- Endpoint configuration chooses a server and then its running core. It clears incompatible core selection when the server changes. Adding a core from server details keeps that server rather than silently defaulting to the first inventory server.
- Existing multi-instance endpoint IDs and credentials remain intact. Ambiguous endpoint labels include instance names (identity only when names still collide); absent or ineligible current selections stay visibly unavailable rather than being silently replaced. Existing unknown adapter IDs and versions round-trip unchanged.
- Fleet remains an instance-targeted maintenance workflow; graph routing and the legacy client route editor are unchanged. No backend schema, credential, deployment, or migration operation is included.

## Verification

Public seams: DOM user tasks through the existing React/Ant Design editor, route save HTTP requests, and existing route compilation model tests.

- New DOM regressions: `server-endpoint.dom.test.tsx` (7) and `infrastructure-creation.dom.test.tsx` (7). They cover server change/no silent remap, exact edit preservation, same-core disambiguation, unavailable/filtered selections, inventory-owner changes, selected endpoint reveal plus save, deployment-only public selection, host-scoped core creation, empty servers, orphan cores, and unknown adapter/version preservation.
- Failing-before-passing evidence: the host-detail Add core test submitted the first host instead of the opened host; the endpoint creation test could not find the server-first control before implementation. The reusable picker test initially failed because the new control did not exist.
- Web typecheck, full Vitest suite, and production build passed; build retains its existing large-chunk advisory. jsdom emits an existing canvas getContext unsupported warning in the full suite, not a failed assertion.
- `scripts/verify.sh static` passed using the relocated official Go compiler and writable workspace cache: private-file guard, 24-ticket/35-story DAG, 9 ticket negative fixtures, architecture negative fixtures, and production import direction.
- A separate reviewer performed a limited source review of the picker/integration and reported no blocking finding; they did not rerun tests.

## Retained constraints and unrun evidence

One listener per instance per server intent remains the compiler/runtime contract. Multiple same-core instances still have valid isolation and concurrent-listener uses, so this change does not hide or prohibit creating them, consolidate identities, merge listeners, or claim default singleton support. Stock and managed Xray retain distinct capabilities.

DOM tests are not rendered-browser visual or keyboard/graph acceptance. This change did not run the full Go race/native/browser/package gate, access live VPS hosts, publish to GitHub, or validate real runtime behavior. Existing ticket status and incomplete acceptance gates are unchanged.
