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

## Exact-head native and original-pixel follow-up

At review head `75c695e223cfda2ff0f10936e6b45ae1734a7abf`, all eight light journeys and the pure serializer contract passed in supplemental run [43133876607](https://github.com/isning/RouteWeaver/actions/runs/43133876607). Artifact `13905744729` has SHA-256 `da051c439e1d7e5496f25e882fe2858087d32f5cae33b6c30db716e25afbe443`.

An independent reviewer inspected all 16 original correction/inheritance PNGs: quota, IP, connections and rate at 390×560 and 1440×900. Each personal-settings table contains only the intended changed row. The target, saved values (50 GiB, 17, 9 and 1 Mbps), corrected three-unit values and explicit inheritance remain readable without horizontal clipping. Irrelevant empty service/route rows are absent.

This is fixture-response fidelity acceptance, not a production comparison change. On mobile the affected-user details lie below the captured initial fold, so this review does not establish their readability. Desktop affected-user provenance captions still say “未单独设置” beside personal overrides because the sampler supplies an empty provenance map; this remaining fixture limitation is not evidence of a production provenance defect. Privacy masks cover some lower regions, not the reviewed change row. Native request-ledger assertions, rather than pixels, establish outgoing command ownership and exact values.
