# Release gate closure — 2026-11-17

Status: in progress; release gate remains open.

Baseline: `63b10e0e83f7ac594f03d015ad766a317eb8018b`, with local documentation cleanup changes. Historical checkpoint and ticket passes are not current-source release acceptance.

## Current evidence

- Static gate completed, including pinned actionlint; full verification advanced to backend Go vet.
- Secrets gate completed: 30 scanner regressions passed; pinned Gitleaks scanned 6,014 distinct path/content pairs across current tree, index and reachable history. This is pattern scanning, not security certification.
- Static helper regressions: 129 tests passed. Architecture negative fixtures, production import directions and ticket DAG passed.
- Separate formatting check and `git diff --check` passed.
- Full gate invoked with both required native and client target selections; results pending in `bin/release-full.log`.
- Independent backend probe was stopped after the full gate reached backend verification, avoiding duplicate execution. It is not a backend pass. Full results belong to `bin/release-full.log`.
- Locked frontend installation completed successfully (`bin/release-npm-ci.log`). Web typecheck passed; single-worker behavior tests are running in `bin/release-web.log`; production build is pending.
- Dependency audit reports four moderate entries in the shadcn CLI dependency chain, including minimatch globparts amplification (GHSA-g3hv-75wg-m249). Audit details are in `bin/release-npm-audit.json`. No major-version automatic fix was applied; dependency disposition remains open.
- Official pinned native asset bootstrap remains incomplete in `bin/release-cores.log`: four attempts exhausted with 180-second transfer timeouts fetching the first Mihomo archive; bootstrap exited 1 (curl exit 28). A separate same-URL download with a 1,800-second bound is preparing the cache and requires the unchanged pinned SHA-256 before promotion (`bin/release-mihomo-download.log`). No native pass is claimed.
- GitHub CLI has no authenticated session. Existing GitHub connector returned empty combined statuses and empty pull-request workflow results for the baseline. These empty responses do not prove absence of push workflows or a successful CI run.

## Closure requirements

All required jobs must finish successfully against one identified source revision: static, secrets, backend, web, API, browser, browser/native, native parsers, runtime, managed runtime and package reproducibility/smoke. Local checks cannot substitute for actual target-repository CI.

Retain the operator deployment requirements in [Release gates](RELEASE-GATES.md). This work does not authorize or establish production deployment.

## Frontend run disposition

The first web run exited 1: 400 files passed, 3 failed; 4,943 tests passed and 22 failed. Production build was not reached. During this run node_modules was replaced with a pnpm layout: installed Vitest 5.1.0 and React Query 5.107.1 differ from package-lock versions 5.0.5 and 5.104.4. The failure stack crosses flat npm and pnpm React paths. The three failing files passed in a later focused run (23 tests), but that used the changed dependency tree and does not close the locked release gate. No product or assertion changes were made.

An active Vite preview uses the current pnpm tree. To preserve it, a separate web source copy under bin/release-web-isolated is being installed with npm ci using the committed lock. Installation log: bin/release-web-isolated-install.log. Full locked rerun remains required.

## Native prerequisite recovery

The extended Mihomo download completed successfully and matched the original archive SHA-256. The verified archive is cached at bin/cores/mihomo.download. The unchanged bootstrap script has been rerun to validate/extract and prepare the remaining locked cores; see bin/release-cores-retry.log. Download success is prerequisite evidence only, not a parser, process or traffic pass.

## Locked frontend rerun

Isolated npm ci completed successfully. Installed versions were verified: React 19.3.1, Vitest 5.0.5, React Query 5.104.4, matching package-lock.json. Source equality was checked against the current web tree (manifest: bin/release-web-isolated-source.json). Sequential typecheck, complete single-worker behavior suite and production build are running; see bin/release-web-isolated.log. The initial mixed-dependency run remains a failed run; it is not erased or reclassified as passing.

The bootstrap retry exited 1 downloading sing-box 1.14.3: curl exit 28 after the fixed 180-second limit, with 5,845,074 of 31,678,266 bytes received on the final attempt. Remaining compatibility and non-withdrawn stock archives are now being prepared sequentially from their locked URLs with a 1,800-second bound per download and original archive SHA-256 checks before cache promotion. The unchanged bootstrap runs after all cache downloads succeed. Log: bin/release-native-cache.log. No runtime tests or host-security bypasses are involved.

## Full run terminal result

The first full gate exited 1 in backend core tests. Static, secrets, formatting and Go vet completed. Core race tests passed outside internal/integration; that package failed seven top-level native tests (mixed-chain has two failing subtests) because explicitly selected native targets lacked the required compatibility/stock binaries. This is a failed requested prerequisite, not a native behavior pass or a demonstrated product defect. Native cache preparation remains in progress. Remaining backend backup, HTTP API, store and managed-runtime groups are being run sequentially in bin/release-backend-remaining.log. No complete backend/full pass is claimed.

## Locked frontend terminal result

The isolated locked frontend command exited 0: typecheck, complete single-worker behavior suite and production build all passed. Source manifests were rechecked after execution against both current web source and the isolated copy. All 403 test files and 4,965 tests passed (882.34 seconds); production build completed. Log: bin/release-web-isolated.log. This closes the local frontend type/behavior/build checks for that source snapshot; it does not close browser user tasks, remote CI, or the dependency-audit disposition. The original mixed-dependency failure remains recorded above.

The extended sing-box transfer ended with curl exit 92 (HTTP/2 stream reset) after approximately 20 MiB. The partial archive is retained. Cache preparation was resumed with HTTP/1.1 and Range continuation, bounded transport retries, unchanged HTTPS URLs and original SHA-256 checks. Identical verified archive hashes may be reused across compatibility/stock cache entries. Log: bin/release-native-cache-resume.log. No partial download is treated as an executable or test pass.

## Native prerequisites completed

Resumable cache preparation and the unchanged bootstrap completed with exit 0. Compatibility Mihomo 1.19.32, sing-box 1.14.3 and Xray 26.3.27, plus all non-withdrawn stock entries (including sing-box 1.14.4 and Xray 26.10.31), passed archive/executable pin checks. Withdrawn Xray 26.10.29 remains excluded by existing policy. No service was installed. The native parser gate is now running in bin/release-native.log. Runtime lifecycle, traffic and managed enforcement remain separate checks.

Backend backup, HTTP API and store gates completed successfully with race instrumentation (938.378 s, 1,095.791 s and 913.660 s respectively). Managed runtime vet/tests/build are still pending; no overall backend pass is claimed.

## Parser pass and managed dependency retry

The native parser gate completed successfully, including required pinned fixtures. This is parser acceptance only; process activation and traffic remain separate. The remaining-backend chain exited 1 in managed runtime vet because downloads of github.com/klauspost/compress v1.18.7 and github.com/cloudflare/circl v1.6.3 returned unexpected EOF. Backup, HTTP API and store passes remain valid. Managed runtime verification is being retried in bin/release-backend-managed-retry.log; after success, the explicitly selected xray/sing-box runtime gate will run sequentially in bin/release-runtime.log with both required clients selected.
