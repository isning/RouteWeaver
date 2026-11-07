# Published-route client port reconstruction

Source reconstruction of missing v122 intent (historical 073df2fe9eb37af5580226fff12cd5d4bb0d87c8), not original byte recovery. Depends on the scoped OperationalIntegerInput adapter from Fleet reconstruction.

Client-facing port retains raw edits separately from saved route data, with exact integer validation in 1–65535 at both preview and save payload boundaries. Backend contract: internal/httpapi/published_routes.go publicPort integer and domain.ValidateConnection. Blank, zero, malformed, fractional and rounded values are never replaced by 443. Existing defaults on new routes/deployment selection are unchanged, including the selected listener port and fallback 443. Switching deployments remounts only this input to show the selected default even after incomplete input.

Every raw edit participates in unsaved-change/cancel protection and invalidates the existing preview revision; stale completions cannot restore a save action. Repair requires a new preview. No listener, credential, server TLS, backend or generic NumericInput behavior is modified.

Public DOM regression source: web/src/published-route-port-intent.dom.test.tsx, using rendered PublishedRoutesPage and HTTP boundaries. All behavioral checks, typecheck/build, browser/backend and aggregates are UNRUN. Historical validations are not current evidence. This change has only source inspection and git diff --check evidence.
