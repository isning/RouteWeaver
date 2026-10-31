# Principal listener editing

## Defects and change

After the first public-route principal assignment, the server marks the endpoint `authentication: "principals"` and removes shared credentials. The endpoint editor nevertheless required a shared VLESS UUID, blocking even a name change. It now carries the authentication model into the connection form, explains where per-user credentials are managed, hides shared UUID/Flow controls, and fixes the principal listener protocol to VLESS. Existing UUID-based listeners remain editable and retain UUID validation. No credentials are generated, authentication model changed, or server validation relaxed.

A second defect appeared once submission was enabled: untouched, unopened TLS/transport fields were missing from the registered form payload. Endpoint saves now overlay edited connection fields on the original connection before normalization, retaining unopened advanced settings without preventing explicit edits.

## Evidence

- Red: actual `ServersPage` → endpoint edit → rename → save DOM test made zero writes because of the required UUID.
- Intermediate red: removing the shared UUID control allowed submission, but the payload assertion caught dropped TLS and WebSocket transport settings.
- Green: infrastructure DOM suite passed 9/9, including principal rename with the exact authentication/TLS/transport-preserving payload and normal VLESS UUID editing with required validation.
- ConnectionFields DOM suite passed 2/2: principal controls omit UUID/Flow even after expanding advanced settings; ordinary listeners retain valid-UUID enforcement and editable Flow.
- `npm run typecheck` and `npm run build` passed. Build retains the existing large-chunk advisory.
- `scripts/go.sh test ./internal/domain` passed using the existing official Go toolchain. Added guard coverage verifies credential-free principal VLESS is accepted, shared UUID/Flow/username/password/method or another protocol are rejected, and legacy VLESS still requires UUID.
- The default parallel full web suite encountered 5-second DOM timeouts and SIGKILL worker exits under shared resource contention. A subsequent serial full run was deliberately interrupted at the parent coordinator's request to avoid concurrent full-suite runs. Neither run is claimed as a pass; centralized full-suite verification remains with the parent.

## Limits

These are DOM/user-task and domain checks, not browser-layout, native-core, deployment, or real-VPS proof. Actual browser verification and independent integrated review remain with the parent. No external service, credential, or live server was changed.
