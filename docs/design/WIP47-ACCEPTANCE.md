# WIP47: endpoint configuration and shadcn migration

Status: bounded implementation and source acceptance complete on 2026-10-29. Final frontend 1,796/1,796 tests, typecheck and production build pass; unchanged backend/API stages and native checks are combined as a repaired modular aggregate. See `../verification/WIP47-FINAL.md`. The existing owner-private sample/read-only demo was updated successfully; its receipt is separate. Archive save still requires its external receipt. No production-readiness or blanket feature-parity claim.

## User-directed outcome

Complete the connection endpoint configuration workflow with reference to 3x-ui/s-ui, migrate the complete application to official shadcn/ui design and components, minimize bespoke CSS, and use restrained motion. Notify after implementation, regression and private demo deployment; only material user decisions interrupt work.

## Acceptance boundaries

- Existing tasks remain: subscription delivery, source import and acceptance, routing, publication, inventory, managed entries, user administration, usage, diagnostics and recovery.
- No Ant Design visual imports/dependency remain in production. Official shadcn registry components and semantic theme tokens provide interaction and visual foundations. A mature nonvisual form state engine may remain; do not build a replacement UI framework or an Ant Design lookalike facade.
- Forms preserve values on failure, distinguish shared and per-user credentials, and present protocol, transport and security as related conditional groups. Switching groups must not silently destroy existing data.
- Endpoint configuration distinguishes client dial parameters, listener address, published access address and server-private TLS material. Never project private keys, server paths or transit credentials into delivered subscriptions.
- Each new parameter must survive validation, cloning, persistence, semantic comparison, import/export and supported rendering. Unsupported target/version/role combinations fail explicitly rather than dropping values.
- Keep the custom managed-Xray accounting constraints. Generic-core support is not permission to enable an unverified bypass of metering, quota or revocation.
- Tested protocol/transport matrix is explicit. Panel reference does not imply blanket parity with every protocol, raw configuration feature or multi-inbound lifecycle.
- Dialog focus, Escape, cancellation, pending state, close protection and exact opener restoration remain verified. Table overflow actions, keyboard use, mobile/short-screen layouts and reduced-motion behavior remain covered.
- Animations communicate disclosure, dialog and navigation state without delaying task completion; honor prefers-reduced-motion.

## Verification and delivery

1. Focused tests, then serialized repository checks against final integrated source. Preserve failures and unsupported/never-run stages honestly.
2. Actual desktop and narrow-screen visual review, plus goal-only journeys and interrupted/repeated operations. A model fixture is not live-backend success.
3. Update the existing owner-private test Site only after applicable checks. Demonstration data remains isolated from real infrastructure and credentials. Mutation controls must clearly reflect actual demonstration capability.
4. Save canonical changes and source provenance, retain earlier artifact identities and history. The deployed demo adapter is not the canonical backend.
5. Report final features and remaining substantive limitations, not an unqualified Google/panel parity claim.

## Sources

- https://ui.shadcn.com/docs/installation/vite
- https://ui.shadcn.com/docs/components
- https://docs.sanaei.dev/docs/config/transports/
- https://docs.sanaei.dev/docs/config/clients/
- https://github.com/alireza0/s-ui/wiki/Configuration-Objects
