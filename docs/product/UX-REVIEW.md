# UX review: make the ordinary task ordinary

Revision 2026-10-19. Documentation review and redesign, not a completed usability test. Applies to [UI-SPEC.md](UI-SPEC.md), [INTERACTIONS.md](INTERACTIONS.md) and the concise [Chinese review](REVIEW.md). Prototype work is separately owned.

## User feedback driving this revision

- “请你进一步检查，review，我感觉有很多没必要显示的东西，还有用户体验并不是特别好。”
- “请你进一步打磨产品的设计”
- “还有非可用性承诺之类的这种废话，不要放在里面”
- “还有FRA → UK 的可用性仍待核对什么，不要有这种没意义的免责，按成熟产品来设计”

## Before → after, with rationale

| Before | After | Why the task gets easier |
| --- | --- | --- |
| My Configuration opens a multi-column editor | 我的订阅 opens a published summary; 获取订阅 is primary | Most visits retrieve output, not redesign routing |
| Get output through target/manifest/preview machinery | Remembered client → Copy link/Download; review only necessary changes | Existing valid output should not require configuration literacy |
| Sources, groups, rules, DNS and resource library all compete for attention | Basic named routing choices first; advanced controls progressively disclosed | Complexity remains available without being mandatory |
| Admin overview/graph competes with route operations | 线路 list → concise detail → edit mode → optional graph | Normal operations and exceptional topology changes are different tasks |
| IDs, hashes, versions and deployment evidence on default surfaces | Named status/action first; diagnostic detail on demand | Engineering traceability is preserved without making users parse it |
| Generic cautions and repeated prototype labels | Healthy default fixture; specific optional failure with fix | Defensive prose neither helps the task nor establishes reliability |
| Multiplier explanations repeated through cards | One badge at choice and explicit usage columns; explanation on demand | Cost is visible at decision time without becoming clutter |
| Draft/current/preview states compete visually | Current published summary plus one pending-changes strip | Users know what they are using and what remains unapplied |
| Permanent privacy explanation | One trust disclosure at private-source entry | Consent-relevant information appears where data is supplied |
| All failure classes displayed together | One actual affected state with cause/action; detail expands | Recovery becomes a task rather than a wall of warnings |

## What was deliberately retained

No silent exit substitution, hidden rule flattening or unsupported policy omission. Stable identities, ownership checks and generation fencing still exist behind the UI. Actual partial/unknown outcomes cannot be presented as success. Published and pending states remain distinct. Multiplier accounting is explicit at choice/usage and historical policy remains attributable. Keyboard, narrow-screen and recoverable-form flows remain first-class.

## Content test

For each visible element ask: does it help complete this task, make this decision, or fix this actual problem? If not, move it to editing, detail, diagnostics or documentation. “Something might be unverified” is not a useful error. “UK 服务器连接失败” with the relevant retry/recovery action is useful only when that is the actual state.

Do not solve clutter by suppressing real problems or hardcoding success. Demonstration data belongs to a separately documented prototype scenario. Documentation truth and product-facing usefulness are compatible; they belong in different places.

## Next review scripts and observable criteria

- Can an invited user get the current subscription without entering advanced settings? No mandatory editor/manifest step.
- Can they change ChatGPT's route and identify exactly what will publish? Current and draft remain distinguishable throughout.
- Can they see the multiplier at selection and actual versus charged usage later without repeated explanation banners?
- Can an administrator find, inspect and edit a route without first interpreting a graph or instance-version table?
- When a specific rule or deployment error is selected, can they identify the cause and next action without opening raw diagnostics?
- Can the same essential tasks be completed by keyboard and on a narrow screen with input retained after errors?

These are proposed inspection/test criteria, not claims of measured usability gains or completed human approval. No backend functionality, deployment or blanket design approval is implied by this revision.
