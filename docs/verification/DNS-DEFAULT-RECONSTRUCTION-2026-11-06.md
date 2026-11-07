# DNS default-selection reconstruction (source only)

This is a new reconstruction from baseline a1fbbc301378e47489660791e68f8c50fcf2b93f (v88). It is not the missing b7f3aa9/v136 source and does not establish byte equivalence with that historical version.

## Intended contract and source changes

- Removing the selected resolver retains its final ID. Missing identity remains visible in the default DNS combobox and is marked invalid with an associated warning.
- “重新选择默认 DNS” focuses that combobox without changing the draft or choosing a fallback. A replacement changes final only when explicitly selected.
- Empty inventories explain that a server must be added first; adding one does not silently select it.
- Saving a typed-valid DNS draft with an invalid final reference remains available. This change does not relax server-side preview/export validation or imply successful publication.
- Unknown DNS JSON shapes (containers, inventory, rows, fields, or final) are not interpreted as structured controls. A warning opens the existing configuration-intent JSON editor with the original data; no rows are filtered or values coerced. The notice promises local draft retention, not successful server persistence: typed decoding may reject malformed shapes. Other runtime JSON shapes are outside this narrow reconstruction.
- Mixed-port and DNS-port NumericInput callbacks are unchanged. The known stale numeric-input issue is not repaired here.

## Authored regression contracts

Public seam: ProfileEditor with actual form components, existing HTTP boundary fixture, no replacement UI mocks. This is the repository-defined public seam. Tests were added incrementally before each corresponding source slice, but not executed. This is NOT a completed red/green cycle.

`web/src/profile-content-hierarchy.dom.test.tsx` adds:

1. Delete the selected resolver; retain its identity and save request; focus repair; explicitly select another resolver and save that selection.
2. Apply malformed DNS through the public JSON editor; render a recovery action, reopen unchanged JSON, close without discarding data, attempt an unchanged payload, and retain raw JSON after an HTTP 400 rejection. Cases include null/scalar/array DNS; missing/object inventories; null/scalar/array/missing-ID/mixed rows; object address/port/final.
3. Empty DNS inventories with missing or blank final; preserve values after a rejected save and after adding a resolver; repair focuses the default selection.

The existing new-DNS/default-initialization contract remains unchanged.

## Evidence and remaining acceptance

Independent source review identified that malformed DNS types may be rejected by `internal/httpapi/tenant.go:382` before storage. The malformed-shape notice and regression contracts were corrected to promise local retention/recovery, not server persistence. The typed-valid missing-final test remains the successful-save control. No backend behavior is established by the HTTP fixture.

Only repository/file inspection and `git diff --check` were performed. Diff whitespace check completed without errors. No Node, npm, browser, Go, gofmt, package installation, network, actual DNS, push, or deployment was run. No dependency mocks, bypasses, generated build output, or ticket verification upgrades were added.

Type checking, unit/component execution, backend draft persistence/preview rejection, keyboard focus in a real browser, desktop/narrow layout, accessibility and product comprehension remain UNRUN. Missing shadcn/Tailwind dependencies in the available execution setup are not replaced or bypassed. All behavior above is source intent, not a runtime pass claim. Run the focused public-UI contracts and appropriate normal repository gates only in an authorized, complete environment; then perform real desktop/narrow review before acceptance.
