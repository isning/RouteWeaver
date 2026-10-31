# WIP47 source-bound verification

Status: **accepted bounded source checkpoint**, 2026-10-29. Owner-private sample-only demo publication completed at 18:13 UTC; see `CHECKPOINT-EVIDENCE/WIP47/private-demo-deployment.json`. Archive saving remains a subsequent operation with separate receipts. This is not production-readiness or blanket panel/Google equivalence.

## Final aggregate

Acceptance is a **repaired modular aggregate**, not a claim that one invocation of `scripts/verify.sh quick` completed green.

- Final repaired frontend: **1,796 / 1,796 tests passed in 157 physical files**, zero failures/pending; TypeScript and production build passed. The 379-file frontend source/configuration manifest stayed unchanged throughout and after these checks.
- Main Go and managed-runtime **vet, race tests and build passed** in quick R2. After the seven narrowly scoped frontend repairs, 542 backend/API/test-harness files were compared with that run's freeze: no content or mode changes. These backend passes are reused only for that unchanged scope.
- `scripts/verify.sh static` passed after the frontend repairs: tracked private-file guard, ticket DAG, nine Python guard negatives, architecture negative fixtures and production import policy.
- Real local API request project: **17 / 17 passed**, zero skips/flaky/errors. The strict secret-update DTO and If-Match regression retains missing/stale-token 409 assertions and unchanged draft/revision checks. This is request-level backend evidence, not browser UI testing.
- Pinned native parser matrix: **112 configurations passed** for Mihomo 1.19.32, sing-box 1.14.3 and Xray 26.3.27. These are configuration parses, not 112 traffic tests.
- Canonical Xray-only runtime fixtures passed, including **eight new VMess/Trojan × TCP/WS/HTTPUpgrade/gRPC localhost echo cases**. Each new case also stops the exit and requires a fresh request to fail while the echo service remains available. This bounds the no-direct-fallback claim; it is not remote-network, throughput or live quota proof.

Public receipts are under `CHECKPOINT-EVIDENCE/WIP47/` relative to the repository root. `aggregate-acceptance.json` binds the independent stages. `local-evidence-index.json` records hashes/sizes of raw diagnostic evidence retained locally, deliberately not included as archive attachments. Backend final manifest: `docs/verification/wip47/backend-parity-final.sha256`.

## Last repairs and historical attempts

Quick R2 remains **failed**: 1,783 passed and two failed out of 1,785 frontend tests after all backend stages and frontend typecheck passed. Its frontend production build was not reached. The two failures were repaired rather than waived:

1. Metadata-only edits of an existing unsupported managed endpoint are allowed only when the full connection, authentication and core target identity are unchanged. Creation, altered parameters and apply-time validation stay strict. The original incompatible protocol/credentials are not silently rewritten.
2. A queued focus-restoration callback could steal focus from a newer read-back action. It now checks connected node ownership and only restores genuinely lost focus. Held-Enter regressions continue asserting one GET, no implicit acceptance and a fresh separate use gesture.

Independent bounded source review found no blocking defect in these seven changed files; this is distinct from browser testing. The final full suite includes new negative coverage. Earlier frontend R1 (1,465 passed / 243 failed; readability import prevented collection), frontend R2 (1,774 passed), interrupted quick R1 and backend bootstrap/resource attempts remain historical, not rewritten as final passes.

## Actual UI review and remaining verification limits

Actual cloud-browser review covered desktop 1180×757 and actual child CSS viewports 390×568 / 1024×568. It found and rechecked source-cell hierarchy, mobile breadcrumb separators, short-dialog outer overflow, dynamic header accordion clipping and header-row deletion focus. Desktop and narrow screenshots document the corrected UI. Review also exercised conditional endpoint fields, draft retention, collapse/reopen, cancellation and exact opener restoration.

This is not a physical mobile device, touch, browser zoom, human usability study or full assistive-technology/WCAG audit. The detached demo review uses synthetic fixtures, not live infrastructure.

Native Chromium automation was blocked at launch by the environment before UI assertions. **179 collected cases are not passing tests**; three attempted smoke cases ran no UI assertions. No sandbox/security bypass was used. sing-box runtime remains unrun because of the known host netlink restriction; its native parser checks did run. These limits are disclosed rather than converted into passes.

## Product and delivery boundaries

Official shadcn/ui components, semantic Tailwind tokens, Geist/Lucide, restrained transitions and reduced-motion support replace the old Ant Design visual layer. The existing nonvisual form state engine remains deliberately. The new typed endpoint matrix supports bounded SOCKS5, Shadowsocks, VLESS, Trojan and VMess AEAD roles, with explicit transport/TLS/REALITY and target restrictions. Request headers and gRPC authority remain outbound-only; managed-Xray metering restrictions are unchanged.

Hysteria2, TUIC, XHTTP, legacy VMess alter IDs, arbitrary inbound fallback/sniffing/multiplex/socket settings and multi-inbound lifecycle are not implemented by this checkpoint. See `ENDPOINT-CAPABILITIES-2026-10-29.md` for the full matrix.

Canonical source retains its actual backend. The separately deployed owner-private test Site uses isolated sample data and read-only mutation responses. No real nodes, credentials, subscriptions, public sharing or production network settings were changed. All prior artifact identities/history must be retained; final archive hashes and successful save/deploy metadata are external receipts, not self-asserted inside the archive.

## Private demo publication

The same owner-private Site was successfully updated at 2026-10-29 18:13:11 UTC, commit `75986f2d3382834aa5555db2e88227dca66c53d0`. Its production build and 11 demo-containment checks passed. The canonical backend-capable source and isolated read-only demo remain distinct. This is not a live infrastructure deployment.
