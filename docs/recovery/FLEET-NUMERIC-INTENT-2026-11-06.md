# Fleet numeric intent reconstruction

Source reconstruction of missing v120, not recovered original bytes. Starting integration commit: 2a7f5cc5838f165294fd3ed476f1436f69ab3213. Historical reference: 592fee4ecc33a7d9c0ea65b7672fdedcf594175c in recovery-inventory.json outside this worktree.

Fleet lease is a 30–3600 integer number of seconds (internal/httpapi/fleet.go). The default remains 300 only on initialization. Custom stage defaults remain 1 for untouched instances, with integer bounds 1–20 and existing contiguous-stage requirements. Blank, zero, malformed and fractional edits are retained and rejected rather than replaced or rounded. Only selected custom stages are validated; generated strategies and stagesFor are unchanged. Every edit retains existing revision invalidation and review ownership. Parsed lease is captured with the reviewed input before asynchronous preview completion.

OperationalIntegerInput is a scoped UI adapter, not a generic NumericInput change. Decimal and exponent spellings of exact integers, bounds, stepping and raw spelling are retained. UI guards supplement existing backend validation. No backend, new protocol or Fleet-create uncertainty changes are included. The separate missing Fleet-create contract remains unresolved.

New public DOM regression source: web/src/fleet-numeric-intent.dom.test.tsx. Boundary is rendered FleetPlanForm interaction and outgoing HTTP payload, not private helper tests. All behavioral tests, typecheck, build, browser and backend checks are UNRUN under the source-only constraint. Historical pass counts are not current evidence. Only source inspection and git diff --check are performed here; no claim of red/green execution.
