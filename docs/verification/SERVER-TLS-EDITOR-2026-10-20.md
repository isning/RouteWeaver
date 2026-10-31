# Server TLS editor regression verification

## Bounded change

The route editor previously produced different REALITY server material depending on whether the administrator entered the handshake target or private key first. Target-first editing created empty short-ID/name lists that the key editor retained; changing the target also silently reset a configured handshake port to 443. Both controls now use the same initialization/update path. Missing or empty lists initialize from the listener's client-facing parameters, while existing lists and the configured port survive edits.

Certificate package paths and PEM controls are now grouped in certificate mode only. REALITY no longer offers certificate paths that conflict with its server material. The certificate view explains that paths are relative to the delivered configuration package, not references to arbitrary existing server files.

The existing contract stays separate: listener TLS fields also describe client/next-hop connections; private certificate or REALITY material belongs to the server program. This change does not add a security mode, derive or generate keys, validate client/server REALITY consistency, or enable REALITY on the managed-Xray runtime.

## Test seam and evidence

Tests exercise `ServerRoutesPage`: reveal an existing route, open its TLS section, edit visible controls, save, and inspect the submitted server intent. They do not test a private helper.

- Red: target-first editing saved empty `serverNames` and `shortIds`; key-first editing passed.
- Red: the REALITY-mode control test found an editable certificate path.
- Regression cases cover both input orders, preserving an explicit port and multiple accepted names/IDs, recovering earlier empty-list drafts, hiding certificate controls in REALITY mode, and retaining certificate paths/PEM editing in ordinary TLS mode.

- Green: `npm --prefix web run test -- --maxWorkers=1 src/server-tls-editor.dom.test.tsx src/server-endpoint.dom.test.tsx src/infrastructure-model.test.ts` passed 19/19 tests across three focused files, including six TLS-editor cases.
- `npm --prefix web run typecheck` passed.
- Prettier checks, `git diff --check`, and ticket render/check passed.

Full-suite, browser, native-core and deployment checks remain with the coordinator and were not run in this slice. Independent integrated review remains outstanding. All data is synthetic and no external server or account was modified.
