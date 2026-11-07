# Effective route choice source reconstruction, 2026-11-06

## Scope and source

This is a new source reconstruction on baseline `a1fbbc3`, not recovery or verification of the lost v108 commit `dc1ca855e49f4391d3adba72c8ae371cccb8976a`.

- `internal/service/effective.go:60–158` is the authoritative precedence contract: group priority chooses a service when no individual service is selected; explicit route overrides replace service and direct grants, including an empty override.
- `internal/httpapi/access_policy.go:52–60` exposes that policy at the administrator's user-scoped effective-policy endpoint.
- `internal/httpapi/platform_entries.go:109–149` independently validates the entry and current account/route authorization before a write. No backend files, endpoint access controls, tenant boundaries, or authorization rules change.
- `web/src/UserEntries.tsx:156–174` now reads that endpoint and validates the observed user identity and nonempty string route IDs. Validation is in the query observer selector, so a malformed shared-cache value cannot bypass it. This validates the fields consumed here, not the complete effective-policy schema.
- `web/src/UserEntries.tsx:582–646` guards a retained draft's submission and filters inventory choices using only authoritative IDs. Neither individual service props nor legacy route membership can add an option. Unknown IDs absent from inventory are not synthesized as options or accepted on submit. Refresh does not replace the user's existing draft or selected route.

## User-facing distinctions

A valid empty route list shows that the user currently has no authorized routes in the editor. Failed or malformed reads show a retryable error, not a deny-all claim. Loading/paused reads retain the existing QueryState distinction. A catalog-missing route is reported as unavailable, not as revoked permission. A removed choice is not silently replaced: the existing value remains, and save asks the user to select an authorized route. The service prop remains compatible with existing callers but is no longer used to infer permissions. Existing lifecycle stop-delivery consequence text is unchanged.

These are source-reviewed intent statements, not rendered acceptance findings. Policy reads are advisory UI state; backend current-state enforcement remains authoritative, including status, quota, and concurrent policy changes.

## Regression source and limits

`web/src/user-entry-effective-routes.dom.test.tsx` exercises rendered controls and synthetic fetch responses: override replacement and save payload, group plan selection, explicit deny-all, malformed network data, missing/null/non-string/blank/wrong-user shared-cache data and retry, unknown inventory IDs, draft retention after policy refresh, and HTTP failure recovery. Fixtures expose only the response fields consumed in this view; they are not backend-policy integration proof.

Existing direct UserEntries fixtures in `user-entry-task-ownership.dom.test.tsx`, `rotation-recovery.dom.test.tsx`, and `workspace.dom.test.tsx` now provide user-scoped effective-policy responses. Their ownership, cancellation, credential isolation, and rotation assertions are retained.

Only source/text inspection and `git diff --check` were performed. **All tests, TypeScript checks, formatting/lint tooling, aggregate gates, browser rendering, screenshot/content review, and backend/native integration checks are UNRUN.** No Node, npm, Go, gofmt, browser, server, installation, network, push, or deployment was used. No red/green execution is claimed. Independent runtime and two-axis review remain pending with the coordinating review. The proposed focused runtime gate, when authorized, is the new DOM regression plus the three adjusted suites and secondary-read-loading; then the repository's aggregate checks. Source checks do not establish release readiness.
