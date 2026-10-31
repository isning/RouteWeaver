# Find RouteWeaver's first usable release

UNPUBLISHED LOCAL MAP DRAFT. Intended future label: wayfinder:map. No tracker IDs, claims, assignments or closed tracker tickets have been created. Privacy and route-level weighted-quota principles are confirmed by actual user replies, recorded locally below. The intended GitHub tracker is unavailable because login was declined; do not retry it. Local documents are review artifacts only.

## Current authority update, 2026-10-19

This historical map is subordinate to [the full capability register](CAPABILITY-REGISTER.md). The user accepted the final eight-item defaults and authorized autonomous engineering refinement, task splitting, CI/tests and development (Sentinel_937013b99c00819183687dc7057530d4). Old pending questions below must not be repeated when answered there; prior blanket product-review pauses are superseded. Major product trade-offs and real VPS/account/persistent-credential actions still require their applicable review/authorization. No tracker closure or test success is fabricated.

## Destination

A reviewed product specification and acceptance-ready first-release plan for a founder-admin/invited-user connectivity service and subscription converter, with distinct server/client intent and a reviewed primary UI flow. This map ends at a plan, not production software.

## Notes

Follow official wayfinder, domain-modeling, to-spec and grilling skills. HITL questions must be answered by the user; synthesis and recommended defaults are not resolution. Skills' publication/ready-for-agent steps remain gated. No more than one non-research ticket should be resolved in a live session. Names below are local draft titles, not invented GitHub issues.

## Decisions so far

- [Choose the source privacy model](decisions/privacy.md): confirmed by the user on 2026-10-19; server-side processing is accepted with explicit operator-visibility disclosure. This is a local product decision, not a closed GitHub issue.

- Multiplier accounting meaning: confirmed in C9; route-level weighted quota, distinct actual/provider/weighted accounting, no repeated per-hop charge and no payment collection. Arithmetic/cutover details remain proposals.

The following conversation evidence establishes product constraints; it is not fabricated tracker history.

| Evidence | Exact user wording and necessary context | Scope established |
| --- | --- | --- |
| C1 | Assistant asked whether founder-only admin with invited users and separated infrastructure/user responsibilities was correct. User: “对，但是它要可扩展，为未来成长为完整的机场管理工具留下空间，留好相关的接口和建模抽象” | Initial audience plus future service-management extensibility, not current billing. |
| C2 | Assistant asked whether users combine authorized routes, their own airports and routing preferences but cannot change shared server topology. User: “嗯，我同意，相当于我们也是一个机场，只不过提供一个更方便的订阅转换器” | Admin topology vs user subscription composition. |
| C3 | Assistant proposed user airports remain client-side by default, only explicitly admin-opened lines allowing server upstream use. User: “嗯” | Default no transit through platform VPS. |
| C4 | User: “不是双核心，是多核心架构” | Open multi-core architecture, not two-core enum. |
| C5 | User: “尽量用成熟的框架，不要重复造轮子” and “你应该先做一个产品经理，确认项目的面向人群，功能设计，建模等等啊” | Product-first review and mature components. |
| C6 | User: “还有也要注意我们的IR的设计，包括服务端的IR和客户端订阅/配置的IR，也包括分流规则等等的支持，我们尽量使用srs等等文件规则，不在订阅文件里里面展平” | Separate server/client IR attention and file-based rule-set preference, not universal SRS support. |
| C7 | User, Sentinel_522e8560f0c08191b4a0ef25b0bf4b18: “我同意，你完成整体的设计了吗”, answering the exact privacy question preserved in [Choose the source privacy model](decisions/privacy.md). | Server-side source processing accepted with operator-visibility disclosure; no approval of the overall design is implied. |
| C8 | User, Sentinel_b6356bbe15c881919bda4e7a08037e6d: “还有倍率计费功能，也是需要的”. The assistant asked whether this means route-level weighted quota deduction rather than payments; the later answer is C9. | Multiplier functionality is required in the first release. Interpretation was pending at this message; see the subsequent confirmation in C9. |
| C9 | User, Sentinel_1031ed7a803c8191903abab89793e9da: “是的”, answering the assistant’s weighted-quota clarification recorded in UI-SPEC.md. | Whole-route actual traffic × multiplier debits quota, with separate raw/provider/weighted accounting, no repeated per-hop deduction and no payment collection. Arithmetic/cutover and implementation evidence remain proposed. |

## Minimal next human decision frontier

Privacy is settled; do not ask it again. The remaining policy/scope topics below are not new questions to send automatically. Research their facts, then bring only a concrete consequential choice to the user. UI and acceptance-seam review are also pending; a written specification is not evidence of a completed live review.

1. **Bound fail-closed enforcement**: The parent reports that fail-closed with a prompt for uncertain quota/route state is already agreed; do not ask that principle again. After researching measurement/runtime facts, may we use conservative explicit freshness and offline bounds, refuse silent exit switching, and show the achievable enforcement delay? Recommended yes to a researched bounded policy, not invented thresholds. Exact cycle/counter facts remain prerequisites; zero overshoot and instant session revocation are not implied.
2. **Choose the first compatibility envelope**: May the first end-to-end acceptance target be FRA → UK plus a user airport, rule-driven ChatGPT routing with a manually selectable group, and a narrowly documented initial core/client/version set that preserves rule-file semantics, with unsupported targets blocked rather than silently weakened? Recommended yes. The agent must research actual formats/versions and show the small compatibility table; do not ask the user to supply technical facts.

Multiplier meaning is now confirmed in C9; do not ask it again. Resolve detailed arithmetic/cutover through a concrete proposed contract and evidence, not a repeated product-meaning question.

## Candidate decision tickets and native dependency intent

Except for the locally confirmed privacy and multiplier decisions, statuses below are OPEN DRAFT, unassigned, unpublished. Future labels are only wayfinder types. Read the title as identity until actual tracker IDs exist.

- [Choose the source privacy model](decisions/privacy.md): grilling; locally CONFIRMED from C7. No tracker closure implied.
- [Choose exhaustion behavior](decisions/exhaustion.md): grilling; no blocker for product choice, measurement evidence needed for implementation bounds.
- [Choose the first compatibility envelope](decisions/compatibility.md): grilling; supported-version research feeds the final contract.
- **Verify core, client and rule-resource capabilities**: research; no blocker, bounded to the first journey; outputs official versioned validation/runtime/rule-format evidence and semantic gaps, not a stack approval. Do not execute binaries or access VPSs as a side effect.
- **Clarify multiplier accounting meaning**: grilling; locally CONFIRMED in C9. UI places are specified in UI-SPEC.md and trace to A16. No payment workflow is included; precise arithmetic/cutover and evidence remain proposed.
- **Review primary workspace alternatives**: prototype HITL; blocked by compatibility-envelope choice for feature detail; present three structural options from the interaction document and record actual feedback.
- **Review the spec and acceptance seams**: grilling; blocked by the remaining enforcement/compatibility choices, multiplier arithmetic/cutover contract, capability evidence and primary workspace review; the privacy prerequisite is satisfied. Test seams remain proposed until this exchange.

Dependency graph in words: capabilities research → compatibility contract; compatibility contract → UI review; confirmed privacy principle + enforcement bounds + confirmed multiplier meaning and proposed accounting contract + compatibility contract + UI review → spec/seam review → implementation-ticket granularity review → authorized publication/implementation. These are local proposed relationships, not native GitHub edges.

## Not yet specified

- Exact supported core/client versions, protocols and rule-resource semantic differences after official research.
- Narrow initial installation/recovery journey and the observed runtime enforcement window after capability facts.
- UI details discovered by prototype feedback and invitation-scale usability trials.
- Future service growth beyond current offerings/entitlements; do not prebuild billing frameworks.

## Out of scope

Payment collection and sales workflows remain outside the current proposed scope; the new multiplier requirement is in scope, with weighted-quota meaning confirmed in C9. Also out of scope: public signup, automatic exit optimization, default server transit for user airports, live infrastructure operations, implementation during this map, and retrying declined GitHub authentication. Historic two-hop prototype restrictions are not accepted product scope.

## Design completeness, 2026-10-19

The product positioning, durable model, separate server/client IR, rule-file lifecycle and proposed page/action flows are documented. [Page-level UI specification](UI-SPEC.md) makes the interaction proposal reviewable. This is a substantial overall design draft, not a final validated design: exact capability/version envelope, enforcement bounds, multiplier arithmetic/cutover details, live UI/prototype feedback, test-seam acceptance and implementation-ticket granularity remain gates. Source privacy is no longer a blocker. This historical status statement is superseded by the implementation authorization above.
