# ADR 0002: Reproducible modular delivery and explicit evidence

Status: accepted engineering baseline under the user's 2026-10-19 full-scope implementation delegation. This supersedes ADR 0001's historical implementation pause, not product constraints or external-operation permissions.

## Decision

Retain the existing mature stack: modular Go control plane/narrow agent, SQLite, React/TypeScript/Vite, Ant Design, React Flow and TanStack Query. Use upstream cores rather than a proxy framework of our own. No broker, distributed-consensus system or arbitrary plugin-execution platform is needed.

Twenty-four local vertical tickets cover all 35 confirmed stories with real blocking edges and public verification seams. GitHub remains unavailable following declined authentication. Local files do not impersonate published issues.

## Executable dependency policy

scripts/architecture-policy.json is enforced by a Go AST import parser. Its tests reject a forbidden domain-to-store/HTTP fixture and unclassified module, and accept a declared renderer-to-domain fixture.

- Domain forbids HTTP, SQL, OS/process libraries, native SDKs and local adapters. Standard net value parsing is permitted; the guard is not a full effect system.
- importer/conversion/render depend only on domain among local modules. Fetching, deployment and publication belong elsewhere.
- service currently contains pure cycle/entitlement policy, not orchestration. auth is pure cryptographic helpers. Persistence may use these pure modules; neither imports persistence.
- HTTP currently coordinates repositories/policies/imports/renderers, including legacy routes. This is explicit integration debt, not a claim that application ports are fully extracted. A separate application module may serve a real second driver, not a speculative framework.
- Agent code cannot import the control-plane HTTP handlers, tenant persistence or subscription importer. Native processes remain behind scoped runtime adapters.

The guard checks production import direction, not authorization, data flow or all dynamic effects. Security/runtime tests remain required. New modules require intentional classification, not blanket exceptions to make CI green.

## Verification and truthfulness

Static verifies complete ticket scope, DAG integrity and architectural imports with negative fixtures. Quick adds formatting, vet, race/behavior tests and Go/web builds. Native parser checks require exact pinned executable bytes and mandatory passing test names. Browser evidence distinguishes controlled fixtures from real API journeys. Native process checks require explicitly selected families and report unrequested families. Full requires every configured stage, including both process families, and cannot silently skip a missing target.

Local and CI use scripts/verify.sh. Actions references are pinned to verified official repository commits; permissions are read-only, checkout credentials are not persisted, diagnostic artifacts survive failures. No remote CI execution is claimed.

Official Go 1.27.2 metadata/archive checksum was checked. scripts/core-lock.json records official native release URLs and archive/executable hashes. Its upstreamChecksumVerified field distinguishes an independent matching upstream checksum from a local reproducibility pin; neither is a signature attestation.

This host rejects sing-box runtime initialization at a netlink socket. Native syntax can pass while runtime stays blocked. Do not retry this operation using privileges or security-setting changes. Ordinary CI is configured to require both native runtimes, not to hide a denied target with a skip. Xray-only local evidence is scoped accordingly.

Formal/state-machine evidence is bounded and assumption-dependent, not a complete proof. Parser success is not activation, process liveness is not traffic, and loopback traffic is not real-VPS deployment or limit enforcement.

## Workflow provenance and integration constraint

Read-only references were recovered from [Matt Pocock's pinned skills](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336): to-tickets, tdd, implement-spec, codebase-design and code-review under skills/engineering. User-delegated breakdown replaces a redundant granularity prompt; public seams recorded in AGENTS provide the test agreement. No upstream scripts were installed or executed.

The preferred workflow uses per-ticket worktrees. This first uncommitted local integration instead uses one shared checkout with explicit ownership because no committed baseline exists yet. Reverify combined changes and obtain separate standards/spec review before closing integration. The user's full-scope permission does not authorize GitHub authentication retries, public publication, real VPS changes or external persistent credentials.
