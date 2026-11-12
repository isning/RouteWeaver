# Personal override preview fixture fidelity

The `cfc491c` synthetic preview originals showed unchanged inherited plan/routes
as extra missing-to-empty-string/null rows. The fixture echoed the request map.
This is not established as a production response defect: the HTTP preview
decodes a typed `PolicyChange`, `policyChangeRecord` returns `Entitlement`, and
`PolicyResourceReview.After.Entitlement` is encoded through `writeJSON`.
The `omitempty` tags on the empty service ID and optional pointers remove those
representations from the real response.

Only the native fixture is corrected. It models the exercised top-level optional
fields without changing exact request assertions. Explicit numeric zero, empty
route arrays (deny all), selected plans/routes and non-null expiry remain intact.
The request object is not mutated. Production comparison code is unchanged.
Both preview phases now require exactly the intended changed personal-setting
row, while preserving their changed-value and affected-user checks.

An independent review verified the typed response path and narrow omission rules.
The isolated pure serialization contract passed without a browser or web server;
targeted TypeScript and discovery passed. Discovery includes eight browser
journeys and one pure contract, not nine browser journeys. Integrated checks are
recorded by the coordinator before publication. The existing failing defensive
component experiments were not integrated because they do not establish current
server-response reachability.

This change does not alter backend validation, request intent, saved policy,
permissions or deployment. New native execution and corrected original-pixel
acceptance remain necessary; prior screenshots describe the old fixture.
