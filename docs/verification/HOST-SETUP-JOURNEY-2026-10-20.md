# Task-first host setup

Scope: RW-01 inventory UI; host/core/endpoint IDs and backend semantics are unchanged.

The parent’s cloud-browser walkthrough found that a newly registered host showed large empty resource/quota and diagnostic cards before its first setup action. Host detail now leads with core setup, a primary Add core action, and direct Add listener actions scoped to each existing core. Adding a core keeps the host detail open, so saving returns to the same host and its next listener action. Existing core names, versions, endpoint counts, state/detail access, and technical identifiers remain available.

Resources, provider quota configuration and connection diagnostics are grouped in a secondary expandable section with separate tabs. Their operational panels, error handling and requests are unchanged; no health status is fabricated. Opening operations still exposes real request failures and existing configuration/test actions.

## Evidence

- Public DOM user-task seam with HTTP fixtures, no mocked product modules: new-host regression failed before implementation (missing setup guidance); selected-core listener regression failed before its action existed. Both subsequently pass.
- `npm --prefix web test -- infrastructure-creation.dom.test.tsx --maxWorkers=1`: 11/11 tests passed. Focused suite covers new-host primary setup, same-host continuation after saving a core, populated-host identities and existing View actions, exact host/core preselection and persisted core ID, resource configuration/refresh, diagnostic targets and disabled test preconditions, technical IDs, and real resource errors rather than empty-success states.
- Ant Design's test-only repeated `test-id` breaks accessible names when a drawer and modal coexist. The DOM fixture uses development mode for unique React IDs, rather than changing production dialog markup to accommodate the mock ID.
- Web typecheck and production build passed. Build retains the existing large-chunk advisory.
- Static ticket/architecture gate passed using the existing compiler with isolated writable caches.
- Full web suite is not a pass in this slice: the unrestricted worker run encountered SIGKILL worker exits and timeouts during concurrent worker activity. A bounded retry was stopped on parent request to avoid competing with other tasks. The parent owns the single-worker full-suite run after integration.

## Limits

This is DOM and build/static evidence, not a fresh full-browser acceptance pass. Parent-observed browser behavior motivated the change; post-change browser review remains with the parent. Independent code review was not run in this worker; integration review remains with the parent. No VPS, deployed runtime, native lifecycle, GitHub, credentials, backend/schema, uniqueness or multi-listener semantics changed or verified by this slice. RW-01 remains in progress.

## Browser-discovered overlay correction

The parent's post-merge browser walkthrough found a real layout regression: leaving host detail open beneath InventoryEditor caused the drawer/mask to cover and intercept the editor. The initial DOM tests established mounted content, not visual overlay priority, and did not catch it.

Host detail now retains its selected host in state but is closed while InventoryEditor is active. Save or Cancel clears the editor and restores that same host. This uses the Drawer open state rather than CSS pointer-event overrides or competing z-index assumptions, for both core and listener creation.

Two DOM assertions failed before the correction because the host dialog remained active alongside the editor. The correction requires only one accessible active dialog while editing, then verifies the same host returns after Cancel or successful save. `npm --prefix web test -- infrastructure-creation.dom.test.tsx --maxWorkers=1` passed 14/14, and web typecheck passed; actual visual confirmation remains with the parent browser session. No full suite was launched for this follow-up.

## Managed platform-entry creation preset

The next parent browser walkthrough confirmed the overlay correction and same-host continuation, then found that Add listener from a managed-Xray platform-entry core incorrectly began with SOCKS5 on port 1080. The renderer contract in `internal/render/principals.go` declares VLESS-only inbound support and per-user principals for managed-Xray 26.3.27-rw1. The exposed tenant capabilities API describes client renderers, not server listener capabilities, so it cannot safely supply a server-wide protocol filter.

New listeners opened directly from that exact adapter/version now begin with VLESS TCP defaults and `authentication: principals`, without a shared UUID. The port is blank and required rather than implying TLS by defaulting to 443. Generic/unknown adapters and versions retain the existing generic editor. Changing a draft's core never rewrites its connection or credentials; selecting the known managed target offers an explicit action to replace the draft's protocol/authentication mode, preserving its entered port. Existing incompatible records retain their original protocol/credentials and display a contextual warning instead of silent repair.

The new direct-creation DOM test failed against the old SOCKS defaults before implementation. Focused regressions cover managed defaults and the saved principals contract, required explicit port, no invented TLS, unchanged drafts on core selection, explicit credential replacement, unchanged incompatible edits, and unknown adapter/version preservation. Existing principal rename/legacy UUID tests remain included. No backend/schema change or guessed global capability filter was introduced. Server-side TLS role editing is deliberately outside this slice; a preset is not publication/native validation evidence.

Verification for this preset slice: `npm --prefix web test -- infrastructure-creation.dom.test.tsx --maxWorkers=1` passed 19/19; web typecheck and ticket rendering/check passed. No full suite, post-change browser check or independent review was run in this worker; those remain with the parent integration flow.

## Managed listener transport options

The exact known managed target now supplies contextual restrictions to the listener connection form. New managed settings offer TCP and ordinary TLS, not REALITY, Vision, non-TCP transport or packet wrappers. The restriction is not inferred from `authentication: principals`: stock adapters can also use principals and retain their existing transport choices. No server-capabilities API or global adapter enum was added.

Previously saved unsupported REALITY, Flow, transport and packet-encoding values remain visible, with an explicit warning. They remain intact on an unchanged save; correction requires selecting TCP or explicitly removing the unsupported setting. The public client connection template keeps SNI, client fingerprint and ALPN. Help points server certificate configuration to the route's TLS certificate/security section. Principals help no longer promises Flow management, and preset instructions use the actual page label `公开线路`.

The new known-target DOM test failed on the previously offered REALITY fields before implementation. Focused tests cover restricted new options, actual host-to-editor target propagation, unchanged unsupported values, explicit correction preserving ordinary TLS/client fields, and stock-principal options remaining unrestricted. DOM test setup includes ResizeObserver for the newly opened tagged ALPN select. Full-suite/browser validation remains with the parent; no runtime behavior or TLS schema was changed.

Verification: `npm --prefix web test -- connection-fields.dom.test.tsx infrastructure-creation.dom.test.tsx --maxWorkers=1` passed 24/24; web typecheck passed. Ticket render/check and diff whitespace checks passed. No independent code review was run in this worker.
