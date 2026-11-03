# Console decision-copy refinement — 2026-11-02

## Recovery and evidence boundary

This source delta was reconstructed after the 18:00 UTC workspace reset from retained task context, against recovered baseline `87444b7`. The former worktree/commit was unavailable; no private session logs were read. Production strings and intended changes are recoverable with high confidence, but tests and this document are reconstructed, not byte-for-byte recovered. **Previous passes and screenshots do not validate this reconstruction.**

Scope: the user's console complaint about redundant disclaimers, missing professional explanations and inconsistent hierarchy. Shared typography, controls, layout and loading are separate coordinated changes. AGENTS.md and CONTENT-DESIGN-RULES.md are authoritative. The pinned engineering skills were reread from their official repository paths because `/workspace/shared/routeweaver-skills` was absent.

Cloudflare's [Kumo guidance](https://kumo-ui.com/skill/) was consulted before reset for related-information grouping and concise hierarchy. This is an adaptation to existing shadcn primitives, not Cloudflare branding, a new dependency, or a claim of equivalent usability. No dashboard metrics were invented.

## Finite inventory

| Surface / selector | Before | Change / retained task facts |
|---|---|---|
| Account security: labels `新密码`, `临时密码` | Byte-length constraint appeared only after invalid input | Associated field description explains 12–72 UTF-8 bytes and typical Chinese character cost. Session invalidation and separate credential-revocation consequences stay visible. |
| Accounting recovery: warning `流量统计状态暂不可用` | Body repeated failure title | Remove only duplicate sentence; real failure, retry and pending behavior remain. |
| Backup: region `备份与恢复`, `创建加密备份`, inspection action | Adjacent cards lacked a shared gap; nested warning panel repeated creation warning | Group sections with shared grid/gap; remove nested panel. Creation dialog retains credential/privacy/password-loss disclosure at download decision. Inspection action is described by visible file+password upload disclosure; selecting file is still local. New-database/nonactivation, uncertain outcome, manual-check and revoked-credential consequences stay. |
| Backup capacity: `检查历史容量` | Competing primary action | Outline secondary action; capacity uncertainty, archive limitations and no-delete scope retained. |
| Notifications inbox / admin header | Subtitle restated page/tabs; inbox list had outer card plus bordered rows | Remove repeat subtitles, make inbox section plain. Message content, read state and refresh remain. |
| Notifications: `传输安全` | STARTTLS/TLS without choice explanation | Field-associated explanation distinguishes connection upgrade from encryption at connection start. Automatic-send scope, stored-secret and test-delivery semantics remain. |
| Security: `二次验证已启用` | Heading plus duplicate enabled badge | Remove badge only; next-login requirement, setup confirmation and recovery instructions remain. |
| Diagnostics: `节点连接诊断` | Header repeated authorized/no-change guarantees | Explain actual test scope: direct/applied-route connectivity and download/upload. Target authorization, TLS, upload/PUT, cancellation and network uncertainty remain at decisions/results. |
| Observation forms: provider-usage footer | User-billing non-effect repeated in adjacent sentences | State separate provider record and no automatic route change once; first sentence still explains baseline reset, billing reference and user-billing non-effect. |
| TLS material: private-key status | Claimed `默认隐藏` even when revealed | Use `已填入 TLS 私钥`; reveal control remains authoritative for current visibility. |
| Rates | Input and effective-rate context useful | No change; preserve actual quota-deduction examples, immutable rate versions and historical-period consequences. |
| Templates | Proposal/review and cancellation context useful | No change; preserve explicit review and draft continuity. |
| Node changes | Published-versus-candidate comparison context useful | No change; preserve unavailable-comparison state, actual added/removed/modified counts, omitted-row disclosure and order-change facts. |

## Verification seam and limits

The pre-agreed AGENTS seam is public UI user tasks with HTTP fetch fixtures. Reconstructed `console-decision-copy.dom.test.tsx` covers associated password help, backup local-selection/upload disclosure and creation consequences, named backup task grouping, SMTP help with scope, and inbox without redundant outer card. DOM structure is not pixel spacing or comprehension proof. Existing focused suites cover draft retention, outcomes and stale requests.

At initial preservation: `git diff --check` passed; tests/typecheck **not run**. Offline `npm ci --cache /workspace/scratch/d385eb428cee/npm-cache` failed `ENOTCACHED` for `zod-4.6.7.tgz`. New tests were written before corresponding reconstruction changes but no fresh red/green run was yet possible. No prior check is being reused as current evidence.

Historical baseline pixel findings retained in context: nested inbox border at 390 px, adjacent backup sections/nested warning at 390 px, duplicated settings description at 1440 px, repeated MFA state at 1440 px. Those screenshot files have not been recovered or re-viewed in this reset workspace; no fresh rendered screenshot or visual acceptance is claimed. Coordinator owns new integrated checks and permitted desktop/narrow review. No local browser, CI, deployment, credential or permission action is included.

### Fresh reconstruction checks

- Normal `npm ci --cache /workspace/scratch/d385eb428cee/npm-cache --ignore-scripts --no-audit --no-fund` succeeded without registry/permission changes (450 packages).
- `npx vitest run src/console-decision-copy.dom.test.tsx --maxWorkers=1`: **5 passed**, 1 file, 1.90 s.
- `npm run typecheck`: **passed**.
- Retrospective test sensitivity: temporarily substituted the three original baseline production files (`AccountSecurity`, `Backup`, `Notifications`), ran the same new suite and observed **5 expected failures** for the missing field help/upload disclosure/named region and retained outer card. Restored committed production files immediately and verified a clean production diff. This is a fresh sensitivity check, **not** a reconstructed claim of original TDD execution order.
- Source facts reread after reset: password byte validation uses `TextEncoder`; `postArchive` sends multipart metadata and archive; SMTP verifies TLS before greeting or requires STARTTLS before authentication. Rates, template decision copy and node-comparison copy were reread; no-change inventory retained, with comparison limitation/omission disclosure explicit for NodeChanges.
- Broader regressions, integrated independent review and permitted rendered desktop/narrow review remain coordinator-owned and unclaimed here. No browser or deployment was performed.
