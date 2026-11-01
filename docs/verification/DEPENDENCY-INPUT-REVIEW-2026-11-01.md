# Bounded dependency and high-risk input review — 2026-11-01

Base: `0f3cc5ee699a4cbc9d261276c4c4437a770ea961`. Scope: Linux/amd64,
single control plane/private invitation deployment; not penetration certification,
all-platform review, or a claim of zero vulnerabilities. No dependency version,
managed-runtime profile, external target, deployment or host policy changed.

## Distribution and notices

`scripts/package.sh` copies web/dist and four executables (control plane, node
agent, notification migration, managed Xray), not node_modules. Installed
`@rolldown/binding-linux-x64-gnu` and `-musl` 1.2.14 contain native `.node`
build binaries and metadata but no license text. They remain conspicuous warnings
in the conservative npm inventory; no fabricated text or blanket exception added.

An actual production Vite build plus a read-only `generateBundle` inspection
reported 730 included module IDs, including virtual `rolldown/runtime.js`.
It includes none of the shadcn CLI, deepmerge, minimatch or ts-morph modules.
`web/src/shadcn.css` is the application's local stylesheet, not the shadcn CLI.
The parent rolldown package's upstream LICENSE and THIRD-PARTY-LICENSE are already
retained byte-for-byte by the collector, including the helper's MIT notice.
[Official pinned license](https://github.com/rolldown/rolldown/blob/v1.2.14/LICENSE).
No additional notice omission verified for this package recipe. Redistribution
of build binaries/node_modules would need a separate review. Managed Xray's
existing notice/source process is unchanged; this is not a legal certification.

All four executables and web/dist were rebuilt by `scripts/build.sh`; the actual
three root binary notice scan retained 400 dependency entries with exactly the
same two binding warnings. Managed Xray retains its separate existing notices.
Build information and collector output are retained alongside the review.

Evidence: `dependency-input-20261101/rolldown-notice-review.json`,
`bundle-modules.json`, six collector unit tests. The build-module inspection used
Vite's actual `generateBundle` output, not string-search absence in minified JS.

## Known vulnerability findings and disposition

Tools: Node 24.22.1 / npm 11.9.0, normal local `npm ci` (449 installed packages), npm's registry audit,
`govulncheck@v1.9.0` installed from official `golang.org/x/vuln`, Go 1.27.3.
Official Go DB timestamp: **2026-10-27T21:16:18Z**. Scans are as of this review;
the database date and static reachability do not establish absence of unknown
vulnerabilities. Root scan is source/symbol level without tests; managed scan is
**module only**, deliberately not a repeat of native runtime acceptance.

| Finding | Actual scope and evidence | Maintenance disposition |
|---|---|---|
| [deepmerge GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), 4.3.1 | Low prototype poisoning advisory; shadcn CLI / registry dependency, not emitted web modules. Package.json calls it production but deployed archive does not ship the CLI. | No upstream fixed release shown. Avoid processing untrusted registries with this CLI; evaluate upstream fix/replacement separately. Do not accept npm's shadcn 1.0.0 major downgrade as an automatic fix. |
| [minimatch GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249), 10.2.6 | Moderate pattern amplification when optimizationLevel >= 2; through ts-morph under shadcn. Not in emitted web modules; no deployed input path established. | Fixed 11.0.1 is a major-version change; review compatible tooling update rather than blind override. |
| [GO-2026-6860](https://pkg.go.dev/vuln/GO-2026-6860), [GO-2026-6866](https://pkg.go.dev/vuln/GO-2026-6866) | x/net 0.60.0 module findings, HTML parsing/rendering; root symbol scan emitted no package/symbol trace. `go list -deps` for all three root commands does not import x/net/html. | Plan a separately tested x/net maintenance update to >=0.62.0; no runtime exploit inferred from module presence. |
| [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) | x/crypto OpenPGP is unmaintained. Root commands do not import openpgp; age backup is not OpenPGP. Module-only finding. | Keep OpenPGP out of the product; bumping x/crypto alone cannot resolve this package-wide unmaintained warning. |
| Managed Xray's nine module findings | The preceding three plus GO-2026-5841, 6061, 6348, 6441, 6443, 6651. s2/NewDict, grpc and upstream certificate-pinning issues. A module scan alone does not prove reachable/not-reachable. | Existing [compiler review](GO-CERTIFICATE-MAINTENANCE-2026-10-31.md) records conservative traces and managed profile restrictions. Keep that explicit residual risk; do not call managed dependencies clean or silently upgrade the native base. |

npm reports **six affected dependency nodes, two primary advisories**, not six
independent vulnerabilities. Root govulncheck returns three module-only findings,
no reached vulnerable symbol; exit 0 is not interpreted as zero findings.
Managed module scan returns nine findings. Exact records/config/SBOM retained in
`dependency-input-20261101/govuln-*-summary.json`; original JSON SHA-256 included.
`npm-audit.json` and `npm-tree.txt` preserve the audit and dependency path.
No exploit payload was sent to an external service.

## Finite input surface matrix

| Surface | Contract and negative cases exercised | Result / limits |
|---|---|---|
| External source URL | `resources.Fetch`: only permitted schemes, no URL userinfo/fragment/local names, private/loopback/link-local/mapped/NAT64/special addresses rejected before dial; mixed public/private DNS denied; checked literal IP reused for dial; redirects revalidated and bounded; referrer stripped; body/status/error/cancellation bounded. | Full resources tests passed using existing fake DNS/transport seams, no external probe. Does not prove all future address allocations, DNS infrastructure or network policy. |
| Import formats | `importer.Parse`: no partial usable snapshot after failure; duplicate JSON, unsupported security/protocol fields, malformed input, identity ambiguity. Added eight finite cases: >16 MiB, long URI, >20,000 lines, >10,000 native rows, excessive JSON depth, duplicate YAML keys, multiple YAML documents, recursive YAML alias. | Full importer tests passed. New cases were green on existing implementation: coverage gap, not a newly fixed vulnerability. No unbounded fuzzing. |
| Native configuration text | Renderer limits 256 KiB, depth 40 / 20,000 nodes; rejects aliases/anchors/custom tags, duplicates/multiple docs; protects generated credentials/resources/schema, foreign/cyclic references and target identity. Existing native renderer tests also verify untrusted property names are not echoed and URLs are client data, not CP reads. | All `Test.*Native` render tests passed. Focused HTTP tests confirmed owner-private draft, redacted preview and preservation of explicit export data. No native core process/Chrome/sing-box launch in this review. Bounds are source-reviewed; not every numeric boundary independently tested here. |
| Backup file/schema | Authenticated age EOF, wrong password/tamper/truncation/trailing ciphertext, KDF cap, unknown schema/frame, duplicate/unordered rows, mixed frames, footer/count/index/generation failures, configured total/row/record caps, staging cleanup. | Full backup package tests passed, plus administrator preview/confirm/fresh-restore HTTP test. No real data; no claim of crash/power-loss or maximum-capacity validation. |
| Secrets/errors and tenant state | Fetch transport errors do not echo token URLs; importer errors omit credentials; HTTP summaries/reveal scopes, native preview URL redaction, typed source error codes, failed/empty/partial source acceptance and pinned resource ownership. | Focused HTTP suites passed; existing accepted snapshot/publication semantics preserved. This is not an exhaustive review of every log/error path. |

## Commands and evidence

Environment sourced from `checklist-tools-20261101/env.sh`: Go build parallelism
`-p=1`, GOMAXPROCS=2, normal own-worktree npm installation (no symlinks).
Go tests used `-count=1`; compile cache was shared, not represented as cold-cache
acceptance. Logs under `dependency-input-20261101/` record:

- `go test -count=1 ./internal/resources ./internal/importer ./internal/backup`
- `go test -count=1 ./internal/importer` after added bounds cases
- `go test -count=1 ./internal/render -run Native`
- focused HTTP native draft/redaction, profile redaction and backup admin tests
- focused HTTP source privacy/failure/empty/candidate and rule-file ownership tests
- `python3 -m unittest discover -s scripts -p test_collect_notices.py`
- `npm run build --prefix web` and independent included-module inspection

This closes the two binding-warning investigation and adds finite input evidence;
it does **not** close the managed dependency residuals, developer-tool advisory
maintenance, independent security review, exact final-commit full CI, browser QA
or deployment acceptance. No blanket `npm audit fix`, major update, push or
public communication performed.
