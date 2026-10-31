# Choose the source privacy model

Status: CONFIRMED PRODUCT DECISION, 2026-10-19 UTC. Local decision record only; no GitHub issue was published or closed. Intended future label: wayfinder:grilling. Parent: Find RouteWeaver's first usable release.

## Question and exact evidence

Assistant's pending question:
“还有一个需要你决定的产品原则，醒来再答也可以：是否接受服务器处理用户的私人机场订阅？我建议首版接受，并明确告知用户运营者理论上能接触处理中的内容；加密存储和权限隔离不能等同于‘对运营者保密’。如果必须连运营者也看不到，就需要另一套客户端处理模式。”

User, message Sentinel_522e8560f0c08191b4a0ef25b0bf4b18:
“我同意，你完成整体的设计了吗”

## Resolution

The user accepts server-side processing of private external subscriptions for the first release, with explicit disclosure that the operator can theoretically access content while processing it. Encryption at rest and permission isolation are not a claim of confidentiality from the operator. An operator-blind client-side mode would require a separate design and is not a first-release guarantee.

This answer settles this privacy principle only. It does not approve the whole specification, detailed UI, compatibility envelope, enforcement thresholds, test seams, implementation tickets or deployment. The accompanying question asks about design completeness; it is not approval of those remaining choices.

## Product consequences and acceptance links

- Source creation must disclose server-side processing beside the input before submission, in plain language, not only in a policy link. Suggested wording: “订阅将在服务器解析和生成配置。我们使用加密存储与权限隔离，但运营者理论上能接触处理中的内容。”
- Preserve per-user ownership, secret masking, access checks and redacted diagnostics. Operator visibility is a trust-model disclosure, not permission to show private credentials broadly in the admin UI.
- Normalized snapshots and generated client configurations can contain sensitive connection credentials; apply their owner's authorization scope and retention/deletion policy.
- A04: cross-user isolation remains required despite operator visibility. A06: refreshes preserve private provenance without exposing secrets in diffs. A11: deletion/rotation explain affected outputs and limitations of recalling downloaded copies. A14: source fetch security and redaction remain release gates. A15: private rule-resource delivery must not bypass ownership or leak upstream credentials.
- Detailed security implementation and retention periods remain proposals for review; this decision does not claim any controls have been implemented or verified.

## Alternatives considered

A separate operator-blind client-side source/secret processing mode changes fetching, refresh, generation, storage and delivery. It is not necessary to satisfy the approved first-release privacy model and must not be simulated by merely hiding fields in the admin interface.
