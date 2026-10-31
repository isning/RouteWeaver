# RouteWeaver

Route-oriented multi-core control plane and thin node agent, with private subscription conversion and complete client configuration management.

## Status

Active local implementation, not a production-ready release. The target is all **35 confirmed stories** in [the capability register](docs/product/CAPABILITY-REGISTER.md), not the earlier prototype. [Local delivery tickets](docs/tickets/README.md) track the entire scope and acceptance dependencies. Partial implementation or passing unit tests do not close a story.

The engineering guards are executable and include rejecting fixtures. Native target pins are Xray 26.3.27, sing-box 1.14.3 and Mihomo 1.19.32, with per-target capability differences. Native syntax validation is not runtime activation or traffic evidence. The current restricted host rejects sing-box process startup at netlink initialization; no full native-runtime pass is claimed. Xray local lifecycle/traffic evidence is separate.

The owner-created private repository is [isning/RouteWeaver](https://github.com/isning/RouteWeaver). Source import and actual GitHub Actions results must be verified for the exact remote commit; local test results or workflow files are not remote CI evidence. No live VPS changes, persistent external credentials or real notifications are authorized by these development commands.

## Requirements and run

Go as declared in go.mod, Node as pinned in `scripts/node-version`/npm, Python 3.12+, Bash 4+ and a C compiler for race tests. Pinned native binaries currently target Linux amd64. Dependencies use go.sum/package-lock.json; native archive and executable hashes are in scripts/core-lock.json.

```sh
# Only if a suitable official Go compiler is not installed:
scripts/bootstrap-go.sh
scripts/go.sh version
scripts/go.sh mod download
npm --prefix web ci
scripts/build.sh
scripts/dev.sh
```

The disposable demo binds only loopback: frontend http://127.0.0.1:5173, backend 127.0.0.1:8080. Read startup output for the demo account. Do not expose demo mode publicly. The server binary is bin/routeweaver-control-plane; use --help for current flags. scripts/go.sh rejects unrelated executables named go, uses writable caches and defaults to GOTOOLCHAIN=local. ROUTEWEAVER_GO selects an explicit compiler path.

## Reproducible verification

```sh
# Ticket scope/DAG and production architecture, including negative fixtures:
scripts/verify.sh static
# Formatting, guards, vet, Go race/tests/build, web type/tests/build:
scripts/verify.sh quick
# Current content + staged content + all reachable restored Git history:
scripts/verify.sh secrets
# Real HTTP integration, with no Chromium or Vite dependency:
scripts/verify.sh api
# Fetch official pinned native assets, without installing services:
python3 scripts/bootstrap-cores.py
scripts/verify.sh native
# Browser tasks; fixture-backed tests are not real-backend integration evidence:
(cd web && npx --no-install playwright install chromium)
scripts/verify.sh browser
# Explicitly selected isolated process tests:
ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray scripts/native-cores.sh runtime
# Full configured gate, only on an authorized compatible host:
ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray,sing-box scripts/verify.sh full
```

CI runs independent `static`, `secrets`, `backend`, `web`, `api`, `browser`, `native` and `package` jobs; **Required repository gates** rejects any missing, failed, cancelled or skipped job. All jobs use the same `scripts/verify.sh` commands as local development. Native CI also requires both stock process targets and the managed loopback gate. Go caches include both module lockfiles; npm uses the checked-in lock. Actions are pinned to full commit IDs with read-only permissions and no persisted checkout credentials.

The Ubuntu 24.04 browser job uses the runner's **evergreen Google Chrome Stable**, not a pinned Chromium build. [Playwright supports Chrome Stable](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge), and [Ubuntu's shipped Chrome AppArmor profile](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) covers the vendor-installed `/opt/google/chrome/chrome` binary. CI verifies package ownership and the installed package checksum, preserves Chromium sandboxing, and records the actual runner image, browser/package versions and executable SHA-256 in `browser-diagnostics`. Both normal Playwright tasks and native-focus tasks use that same installed browser. No sandbox or host-policy setting is disabled. Local pinned Chromium remains available on compatible hosts; a denied launch is not product-test evidence.

The full gate fails when a requested prerequisite/test/runtime target is missing, skipped or denied. Do not retry a host-denied runtime operation using a privileged workaround. Run unaffected checks separately and report their scope. Native reports are written under bin/verification. Format changes are explicit: scripts/format.sh --write.

Native parser checks validate real generated configurations. Owned-process lifecycle/restart tests do not by themselves establish reachability or actual traffic. An isolated traffic fixture does not establish multi-VPS behavior or live quota enforcement. Browser tests must distinguish intercepted API fixtures from real API-backed journeys.

## Design and scope

- internal/domain: stable identity, separate server/client intent and invariants.
- internal/importer, conversion, render: bounded parsing, ordered processing and deterministic target-specific compilation.
- internal/service and auth: pure cycle/entitlement policy and authentication primitives.
- internal/store and resources: persistence and bounded safe resource fetching.
- internal/agent: scoped generation-fenced reconciliation and runtime adapters.
- internal/httpapi: authorized request mapping and current application orchestration.
- web: React/TypeScript, official shadcn/ui (radix-nova), Tailwind semantic tokens, React Flow and TanStack Query.

[ADR 0002](docs/adr/0002-delivery-harness-and-boundaries.md) records the baseline and integration debt; [AGENTS.md](AGENTS.md) is the engineering contract. Historical prototypes are not production behavior.

Excluded: payments/orders, external-airport billing aggregation, arbitrary script execution and automatic server-side failover. Explicit client URL-test/fallback/load-balance strategies remain in scope. Unsupported/unverified combinations must be reported, never silently omitted or changed to another exit.

## WIP47 endpoint and UI update

See [endpoint capability matrix](docs/verification/ENDPOINT-CAPABILITIES-2026-10-29.md), [shadcn migration](docs/design/SHADCN-MIGRATION.md), and [source-bound final verification](docs/verification/WIP47-FINAL.md). Common supported endpoints now include Trojan and VMess AEAD alongside SOCKS5, Shadowsocks and VLESS. Target-specific limits and managed accounting safeguards remain explicit; this is not blanket parity with every 3x-ui/s-ui feature.

## Package and source provenance

```sh
# Linux amd64 host: build twice, require byte-identical archives, then execute smoke:
scripts/verify.sh package
# Build a candidate only (not a smoke result):
scripts/package.sh
```

Outputs live in `bin/packages/`: archive, `.sha256`, `.provenance.json` and, only after successful smoke, `.smoke.json`. Each archive includes `SOURCE-MANIFEST.json`: sorted source paths, content hashes, executable flags and the actual local commit/dirty status. Source enumeration does not trust arbitrary Git-ignore rules: ignored build-affecting source is included and marks the tree dirty; known generated/dependency directories are excluded. Operator state such as `.env` and database files is rejected outside those private generated directories. A source-only directory explicitly records no commit; it never inherits an unrelated parent repository. The source is checked again after building to reject concurrent edits. CI requires a clean checkout.

Archive ordering, owner/mode and gzip/tar timestamps are normalized (`SOURCE_DATE_EPOCH`, default `0`); Go builds disable implicit VCS stamps because the explicit manifest binds the complete package. The package gate checks **two builds on the same toolchain/host**, not universal bit-for-bit cross-platform reproducibility. The checksum/provenance receipt is not a signature or supply-chain attestation.

The extracted package smoke covers static UI assets and authentication, then a separate non-demo database, source/profile publication, anonymous feed retrieval, restart without bootstrap credentials, token rotation and old-link rejection. All state and credentials are disposable local fixtures. This does not execute Chromium, a real client, a node agent or a VPS. [Release gates](docs/verification/RELEASE-GATES.md) keep repository acceptance separate from operator-authorized deployment.
