# Template endpoint catalog source reconstruction

Base: a1fbbc301378e47489660791e68f8c50fcf2b93f.
Historical references: v118 52e2876 and v119 772dae1 were described in recovery context; their source objects were unavailable. This is a new bounded reconstruction, not a recovered identical patch. The historical aggregate failure is not a pass.

## Contract and implementation

- `internal/httpapi/tenant.go:204-220,223-240,267-282`: owner-scoped collection preview resolves enabled accepted source snapshots, runs server processing and returns redacted endpoints. The saved collection preview takes its collection from storage, not the POST body.
- `internal/httpapi/tenant.go:310-328,346-373`: collection ID overrides source IDs and inline endpoints; source-only profiles also replace inline endpoints through processing. Only imported inline endpoints are accepted. Platform entries must be referenced grants and are resolved separately.
- `internal/httpapi/tenant.go:79-100` and `internal/httpapi/platform_entries.go:202` onward: the tenant platform listing omits grants that cannot resolve, including revoked/unavailable grants. The frontend does not construct permissions from embedded entries.
- `internal/conversion/pipeline.go:24-82`: collection result endpoints are the processed output, including per-source and aggregate steps.
- `docs/design/template-reuse.md`: endpoint bindings refer to materialized user-profile records; changing a replacement slot must not silently apply or replace personal configuration.

`web/src/Templates.tsx` shares one catalog between initial selection and update replacement controls. It reads saved collection previews or the equivalent source-only preview, then resolves all referenced grant IDs from the platform listing. It validates result identities/names, duplicate IDs, processed endpoint origins and inline origin handling. A query selector validates cached option shapes too. No raw source snapshot contributes options.

Pending, fetching, paused, error and malformed responses expose no available options. Selected initial bindings remain visible as unavailable without rewriting their value. Update controls remain disabled when the profile/catalog is unresolved; existing update binding values and server preview/apply behavior are preserved. Catalog notices expose read failures and retry. Profile identity/content belongs to the query key, so a different profile does not reuse an old profile's response. Sources, collections and platform-entry cache invalidations or successful cache changes invalidate the mounted endpoint catalog.

## Regression source

`web/src/template-selection-recovery.dom.test.tsx` exercises TemplatesPage plus the fetch boundary: preview request body, collection precedence, processed identities/names, ignored raw inline choices, grant failure/removal, malformed origins and cached identities, paused/held/failed reads, retries preserving version/mode/selection, upstream invalidation, no-slot/preset independence and update replacement without apply.

`web/src/template-update-review.dom.test.tsx` corrects imported inline fixture origins to match server-accepted records. It does not weaken preview or apply assertions.

## Verification and limitations

- `git diff --check`: passed on the candidate text before commit.
- Node/npm, TypeScript, formatter, Vitest, Go/gofmt, browser, server, install, network, push/deploy and full/static/quick/native harnesses: UNRUN by task restriction. No red/green runtime claim or rendered UI claim is made. Tests were revised as source-only regressions.
- Independent source review checked materialization precedence, response/cache shape validation, known-input invalidation and retained selection behavior. Runtime confirmation remains pending.
- This catalog is a read observation, not an authorization token. Preview and grant listing are separate reads; remote changes not observed by this client's cache can happen afterward. Server template selection, update preview and digest-bound apply remain authoritative.
- Cache invalidation is observed while the component is mounted. A later mount performs the ordinary stale-query refresh. A source mutation's own cache lifecycle is not a server-side atomic fence.
- This patch does not alter server materialization/validation or invent a new endpoint. It does not prove every existing template/UI fixture, compiler or aggregate test passes. The final integration gate and browser lifecycle review are still required.
