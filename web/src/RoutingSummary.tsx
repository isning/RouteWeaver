import type {
  FrozenRoutingAction,
  FrozenRoutingIntent,
  FrozenRoutingRule,
  MatchExpression,
  RoutingSummary,
} from "./types";
type AdvancedSummary = NonNullable<RoutingSummary["advanced"]>;
function matchLabel(
  expression: MatchExpression,
  resources: FrozenRoutingIntent["resources"],
): string {
  const children = expression.children || [];
  switch (expression.op) {
    case "domain":
      return `域名 ${expression.value}`;
    case "domain-suffix":
      return `域名后缀 ${expression.value}`;
    case "ip-cidr":
      return `IP 网段 ${expression.value}`;
    case "resource":
      return `规则文件「${resources?.find((item) => item.id === expression.value)?.label || "未提供名称"}」`;
    case "not":
      return `不匹配（${children.map((child) => matchLabel(child, resources)).join("、")}）`;
    case "and":
    case "or":
      return children
        .map((child) => `（${matchLabel(child, resources)}）`)
        .join(expression.op === "and" ? "且" : "或");
    default:
      return "匹配条件未展示";
  }
}
function ruleMatchLabel(rule: FrozenRoutingRule, intent: FrozenRoutingIntent) {
  if (rule.match.state === "exact" && rule.match.expression)
    return matchLabel(rule.match.expression, intent.resources);
  return rule.match.reason === "sensitive"
    ? "匹配条件未展示（含敏感信息）"
    : "匹配条件未在摘要中展示";
}
function FrozenRoutingIntentView({
  intent,
  summary,
  decisionReview = false,
}: {
  intent: FrozenRoutingIntent;
  summary?: RoutingSummary;
  decisionReview?: boolean;
}) {
  if (intent.kind === "native-override")
    return <p>使用原生配置覆盖，无法提供可靠的分流摘要。</p>;
  if (intent.kind === "nodes-only") return <p>纯节点订阅，仅交付连接。</p>;
  const rules = intent.rules || [];
  const hasGroup =
    intent.defaultAction?.kind === "group" ||
    rules.some((rule) => rule.action.kind === "group");
  return (
    <div className="routing-intent space-y-4">
      {rules.length > 0 ? (
        <ol
          className="routing-intent-rules list-decimal space-y-4 pl-6 marker:text-muted-foreground"
          aria-label="分流规则（按顺序匹配）"
        >
          {rules.map((rule) => (
            <li key={rule.id}>
              <div className="routing-intent-rule flex flex-wrap items-center gap-2 rounded-md border p-3">
                <span className="routing-intent-match min-w-0 break-words font-mono text-xs">
                  {ruleMatchLabel(rule, intent)}
                </span>
                <span
                  aria-hidden="true"
                  className="routing-intent-arrow text-muted-foreground"
                >
                  →
                </span>
                <strong>{defaultActionLabel(rule.action)}</strong>
              </div>
            </li>
          ))}
        </ol>
      ) : intent.ruleCount === 0 ? (
        <p>未配置分流规则。</p>
      ) : null}
      {!!intent.omittedRuleCount && (
        <p>另有 {intent.omittedRuleCount} 条规则未在摘要中展示。</p>
      )}
      <dl className="routing-summary routing-intent-default space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
        <dt>未匹配规则的流量</dt>
        <dd>
          {intent.defaultAction
            ? defaultActionLabel(intent.defaultAction)
            : "未提供默认处理方式"}
        </dd>
      </dl>
      {!!intent.resources?.length && (
        <p>规则文件仅显示引用，具体条目请查看文件内容。</p>
      )}
      {(summary?.advanced || hasGroup || rules.length > 1) && (
        <details className="routing-intent-overview muted text-sm text-muted-foreground">
          <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {decisionReview ? "配置数量与说明" : "配置概览"}
          </summary>
          {rules.length > 1 && <p>按顺序匹配，首个匹配的规则决定去向。</p>}
          {summary?.advanced && (
            <p>
              {summary.advanced.ruleCount} 条分流规则 ·{" "}
              {summary.advanced.groupCount} 个策略组 ·{" "}
              {summary.advanced.nodeCount} 个节点
            </p>
          )}
          {hasGroup && (
            <p>策略组展示配置中的流量去向；当前选中的节点请在客户端查看。</p>
          )}
        </details>
      )}
    </div>
  );
}
function sameAction(a?: FrozenRoutingAction, b?: FrozenRoutingAction) {
  return a?.kind === b?.kind && a?.ref === b?.ref;
}
function matchKey(expression?: MatchExpression): string {
  if (!expression) return "";
  return JSON.stringify([
    expression.op,
    expression.value || "",
    (expression.children || []).map(matchKey),
  ]);
}
function completeRules(intent: FrozenRoutingIntent) {
  return (
    !intent.omittedRuleCount &&
    Array.isArray(intent.rules) &&
    intent.ruleCount === intent.rules?.length &&
    intent.rules.every(
      (rule) => rule.match.state === "exact" && !!rule.match.expression,
    )
  );
}
// Shared coverage contract for both the comparison and its surrounding review.
export function hasCompleteFrozenRoutingIntent(intent: FrozenRoutingIntent) {
  return (
    intent.kind === "portable" &&
    completeRules(intent) &&
    !!intent.defaultAction
  );
}
type RoutingComparisonLabels = {
  before: string;
  after: string;
};
// Selected-output companions own these categories, including their unavailable
// states. Omission preserves the generic comparison's existing exclusions.
type CompanionCategories = {
  groups?: boolean;
  nodes?: boolean;
};
function comparisonLimit(
  companions?: CompanionCategories,
  concreteRules = true,
) {
  const excluded = [
    concreteRules
      ? "规则文件内容和客户端运行设置"
      : "具体规则、规则文件内容和客户端运行设置",
    !companions?.groups && "策略组内容",
    !companions?.nodes && "节点设置",
  ].filter(Boolean);
  return `未比较${excluded.join("、")}。`;
}
const publicationLabels: RoutingComparisonLabels = {
  before: "已发布",
  after: "待发布",
};
function TargetIdentityDetails({
  before,
  after,
  labels = publicationLabels,
}: {
  before?: FrozenRoutingAction;
  after?: FrozenRoutingAction;
  labels?: RoutingComparisonLabels;
}) {
  if (
    !before?.ref ||
    !after?.ref ||
    sameAction(before, after) ||
    defaultActionLabel(before) !== defaultActionLabel(after)
  )
    return null;
  return (
    <details className="routing-target-identities flex flex-wrap gap-2">
      <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        查看去向标识
      </summary>
      <dl className="routing-summary space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
        <dt>{labels.before}</dt>
        <dd>{before.ref}</dd>
        <dt>{labels.after}</dt>
        <dd>{after.ref}</dd>
      </dl>
    </details>
  );
}
function FrozenRoutingChanges({
  published,
  candidate,
  summary,
  decisionReview = false,
  labels = publicationLabels,
  companionCategories,
}: {
  published: FrozenRoutingIntent;
  candidate: FrozenRoutingIntent;
  summary?: RoutingSummary;
  decisionReview?: boolean;
  labels?: RoutingComparisonLabels;
  companionCategories?: CompanionCategories;
}) {
  const before = published.rules || [];
  const after = candidate.rules || [];
  const oldRules = new Map(
    before.map((rule, index) => [rule.id, { rule, index }]),
  );
  const newIDs = new Set(after.map((rule) => rule.id));
  const changes = after
    .map((rule, index) => {
      const old = oldRules.get(rule.id);
      return {
        before: old?.rule,
        after: rule as FrozenRoutingRule | undefined,
        beforeIndex: old?.index ?? -1,
        afterIndex: index,
      };
    })
    .concat(
      before.flatMap((rule, index) =>
        newIDs.has(rule.id)
          ? []
          : [
              {
                before: rule,
                after: undefined,
                beforeIndex: index,
                afterIndex: -1,
              },
            ],
      ),
    )
    .filter((change) => {
      if (!change.before || !change.after) return true;
      const exact =
        change.before.match.state === "exact" &&
        change.after.match.state === "exact";
      return (
        !sameAction(change.before.action, change.after.action) ||
        change.before.action.label !== change.after.action.label ||
        change.beforeIndex !== change.afterIndex ||
        (exact &&
          matchKey(change.before.match.expression) !==
            matchKey(change.after.match.expression))
      );
    });
  const defaultChanged =
    !sameAction(published.defaultAction, candidate.defaultAction) ||
    published.defaultAction?.label !== candidate.defaultAction?.label;
  const complete =
    hasCompleteFrozenRoutingIntent(published) &&
    hasCompleteFrozenRoutingIntent(candidate);
  const hasChanges = changes.length > 0 || defaultChanged;
  // Compact only this selected-output companion's fully known comparison.
  // Equal counts, missing rows or a coarse summary cannot establish equality.
  const compactUnchanged =
    decisionReview &&
    (companionCategories?.groups === true ||
      companionCategories?.nodes === true) &&
    complete &&
    !hasChanges;
  return (
    <div className="routing-intent-comparison space-y-4">
      {decisionReview && (
        <div
          className="routing-comparison-conclusion text-sm font-medium"
          role="group"
          aria-label="比较结论与范围"
        >
          {compactUnchanged ? (
            <details>
              <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                分流规则和默认去向未变化
              </summary>
              <FrozenRoutingIntentView
                intent={candidate}
                summary={summary}
                decisionReview={decisionReview}
              />
            </details>
          ) : complete && !hasChanges ? (
            <p>已展示的分流规则和默认去向相同。</p>
          ) : null}
          {!complete && <p>部分规则明细未展示，无法完整比较分流规则。</p>}
          <p>
            {companionCategories
              ? comparisonLimit(companionCategories)
              : "仅比较分流规则和默认去向；未比较规则文件内容、策略组内容和节点设置。"}
          </p>
        </div>
      )}
      {changes.length > 0 && (
        <ul
          className="routing-intent-changes space-y-3"
          aria-label="分流规则变更"
        >
          {changes.map((change) => {
            const old = change.before;
            const next = change.after;
            const oldMatch = old ? ruleMatchLabel(old, published) : "";
            const nextMatch = next ? ruleMatchLabel(next, candidate) : "";
            const conditionChanged =
              !!old &&
              !!next &&
              old.match.state === "exact" &&
              next.match.state === "exact" &&
              matchKey(old.match.expression) !==
                matchKey(next.match.expression);
            const sharedMatch =
              !!old && !!next && oldMatch === nextMatch && !conditionChanged;
            const moved =
              !!old && !!next && change.beforeIndex !== change.afterIndex;
            const rerouted =
              !!old && !!next && !sameAction(old.action, next.action);
            const status = !old
              ? published.omittedRuleCount
                ? `${labels.before}摘要未展示此规则`
                : "新增规则"
              : !next
                ? candidate.omittedRuleCount
                  ? `${labels.after}摘要未展示此规则`
                  : "移除规则"
                : rerouted
                  ? "去向已更换"
                  : old.action.label !== next.action.label
                    ? "去向名称已更新"
                    : conditionChanged
                      ? "匹配条件已更改"
                      : "顺序已调整";
            return (
              <li key={(next || old)!.id}>
                <h4>
                  {sharedMatch
                    ? nextMatch
                    : `规则 ${change.afterIndex >= 0 ? change.afterIndex + 1 : change.beforeIndex + 1}`}
                </h4>
                <p className="routing-intent-change-state flex items-center gap-2">
                  {status}
                  {moved
                    ? ` · 顺序 ${change.beforeIndex + 1} → ${change.afterIndex + 1}`
                    : ""}
                </p>
                <div className="routing-intent-versions grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:space-y-1 [&>div]:break-words">
                  <div>
                    <span className="muted text-sm text-muted-foreground">
                      {labels.before}
                    </span>
                    {old ? (
                      <>
                        {!sharedMatch && <span>{oldMatch}</span>}
                        <span>{defaultActionLabel(old.action)}</span>
                      </>
                    ) : (
                      <span>
                        {published.omittedRuleCount
                          ? "此摘要未展示"
                          : "无此规则"}
                      </span>
                    )}
                  </div>
                  <span
                    className="routing-change-arrow hidden self-center text-muted-foreground sm:block"
                    aria-hidden="true"
                  >
                    →
                  </span>
                  <div>
                    <span className="muted text-sm text-muted-foreground">
                      {labels.after}
                    </span>
                    {next ? (
                      <>
                        {!sharedMatch && <span>{nextMatch}</span>}
                        <strong>{defaultActionLabel(next.action)}</strong>
                      </>
                    ) : (
                      <span>
                        {candidate.omittedRuleCount
                          ? "此摘要未展示"
                          : "移除此规则"}
                      </span>
                    )}
                  </div>
                </div>
                <TargetIdentityDetails
                  labels={labels}
                  before={old?.action}
                  after={next?.action}
                />
                {conditionChanged && oldMatch === nextMatch && (
                  <details className="routing-target-identities flex flex-wrap gap-2">
                    <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      查看匹配条件标识
                    </summary>
                    <dl className="routing-summary space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
                      <dt>{labels.before}</dt>
                      <dd>{JSON.stringify(old!.match.expression)}</dd>
                      <dt>{labels.after}</dt>
                      <dd>{JSON.stringify(next!.match.expression)}</dd>
                    </dl>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {defaultChanged ? (
        <div>
          <h4>未匹配规则的流量</h4>
          <p className="routing-intent-change-state flex items-center gap-2">
            {sameAction(published.defaultAction, candidate.defaultAction)
              ? "默认去向名称已更新"
              : "默认去向已更换"}
          </p>
          <div className="routing-intent-versions grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:space-y-1 [&>div]:break-words">
            <div>
              <span className="muted text-sm text-muted-foreground">
                {labels.before}
              </span>
              <span>
                {published.defaultAction
                  ? defaultActionLabel(published.defaultAction)
                  : "未提供默认处理方式"}
              </span>
            </div>
            <span
              className="routing-change-arrow hidden self-center text-muted-foreground sm:block"
              aria-hidden="true"
            >
              →
            </span>
            <div>
              <span className="muted text-sm text-muted-foreground">
                {labels.after}
              </span>
              <strong>
                {candidate.defaultAction
                  ? defaultActionLabel(candidate.defaultAction)
                  : "未提供默认处理方式"}
              </strong>
            </div>
          </div>
          <TargetIdentityDetails
            labels={labels}
            before={published.defaultAction}
            after={candidate.defaultAction}
          />
        </div>
      ) : hasChanges ? (
        <dl className="routing-summary routing-intent-default space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
          <dt>未匹配规则的流量</dt>
          <dd>
            {candidate.defaultAction
              ? defaultActionLabel(candidate.defaultAction)
              : "未提供默认处理方式"}
          </dd>
        </dl>
      ) : !compactUnchanged ? (
        <>
          {!decisionReview && complete && (
            <p>已展示的分流规则和默认去向相同。</p>
          )}
          <FrozenRoutingIntentView
            intent={candidate}
            summary={summary}
            decisionReview={decisionReview}
          />
        </>
      ) : null}
      {!decisionReview && (
        <>
          {!complete && <p>部分规则明细未展示，无法完整比较分流规则。</p>}
          <p>
            此处仅比较分流规则和默认去向，未比较规则文件内容、策略组内容和节点设置。
          </p>
        </>
      )}
      {hasChanges && (candidate.ruleCount || 0) > 1 && (
        <details>
          <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            查看{labels.after}规则明细
          </summary>
          <FrozenRoutingIntentView
            intent={candidate}
            summary={summary}
            decisionReview={decisionReview}
          />
        </details>
      )}
    </div>
  );
}
export function FrozenRoutingComparison({
  published,
  candidate,
  publishedIntent,
  candidateIntent,
  decisionReview = false,
  labels = publicationLabels,
  companionCategories,
}: {
  published?: RoutingSummary;
  candidate?: RoutingSummary;
  publishedIntent?: FrozenRoutingIntent;
  candidateIntent?: FrozenRoutingIntent;
  decisionReview?: boolean;
  labels?: RoutingComparisonLabels;
  companionCategories?: CompanionCategories;
}) {
  if (publishedIntent?.version === 1 && candidateIntent?.version === 1) {
    if (
      publishedIntent.kind === "portable" &&
      candidateIntent.kind === "portable"
    )
      return (
        <FrozenRoutingChanges
          labels={labels}
          published={publishedIntent}
          candidate={candidateIntent}
          summary={candidate}
          decisionReview={decisionReview}
          companionCategories={companionCategories}
        />
      );
    if (
      publishedIntent.kind === "native-override" &&
      candidateIntent.kind === "native-override"
    )
      return (
        <p>
          {labels.before}与{labels.after}
          均使用原生配置覆盖，无法提供可靠的分流比较。
        </p>
      );
    if (
      publishedIntent.kind === "nodes-only" &&
      candidateIntent.kind === "nodes-only"
    )
      return (
        <p>
          {companionCategories?.nodes
            ? "纯节点订阅仅交付连接。"
            : "纯节点订阅仅交付连接；本摘要未比较节点及连接设置。"}
        </p>
      );
  }
  return (
    <div className="routing-review space-y-4">
      <div>
        <h4>{labels.before}</h4>
        <RoutingSummaryView summary={published} intent={publishedIntent} />
        {!publishedIntent &&
          (published?.kind === "basic" || published?.kind === "advanced") && (
            <p>此版本未保存具体规则明细，无法逐条比较。</p>
          )}
      </div>
      <div>
        <h4>{labels.after}</h4>
        <RoutingSummaryView summary={candidate} intent={candidateIntent} />
      </div>
    </div>
  );
}
function defaultActionLabel(action: AdvancedSummary["defaultAction"]) {
  return (
    {
      group: `由策略组「${action.label || "未提供名称"}」决定`,
      endpoint: `节点「${action.label || "未提供名称"}」`,
      direct: "直连",
      reject: "拒绝连接",
    }[action.kind] || "未提供默认处理方式"
  );
}
function AdvancedSummaryNotes({ hasGroup }: { hasGroup: boolean }) {
  return (
    <details className="muted text-sm text-muted-foreground">
      <summary className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        摘要说明
      </summary>
      <p className="muted text-sm text-muted-foreground">
        规则数仅统计配置中的显式规则；默认处理与规则文件内条目单独查看。节点数统计配置所含节点，在线状态需另行查询。
      </p>
      {hasGroup && (
        <p className="muted text-sm text-muted-foreground">
          策略组展示配置中的流量去向；当前选中的节点请在客户端查看。
        </p>
      )}
    </details>
  );
}
function AdvancedRoutingChanges({
  published,
  candidate,
  companionCategories,
}: {
  published: AdvancedSummary;
  candidate: AdvancedSummary;
  companionCategories?: CompanionCategories;
}) {
  // Rank the decision before supporting detail (Refactoring UI §2.1, §3.6):
  // changed fields, their coverage limit, then optional counting/group semantics.
  // Names are frozen display metadata, not stable references or runtime choices.
  const changes = [
    {
      label: "未匹配规则的流量",
      before: defaultActionLabel(published.defaultAction),
      after: defaultActionLabel(candidate.defaultAction),
    },
    {
      label: "分流规则数",
      before: `${published.ruleCount} 条`,
      after: `${candidate.ruleCount} 条`,
    },
    {
      label: "策略组数",
      before: `${published.groupCount} 个`,
      after: `${candidate.groupCount} 个`,
    },
    {
      label: "节点数",
      before: `${published.nodeCount} 个`,
      after: `${candidate.nodeCount} 个`,
    },
  ].filter(({ before, after }) => before !== after);
  return (
    <div className="routing-known-changes space-y-3">
      {changes.length > 0 ? (
        <dl className="routing-change-list space-y-6 [&>div]:min-w-0 [&_dt]:mb-2 [&_dt]:font-semibold [&_dd]:grid [&_dd]:grid-cols-1 sm:[&_dd]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] [&_dd]:items-start [&_dd]:gap-3">
          {changes.map(({ label, before, after }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <span className="routing-change-value min-w-0 break-words rounded-md bg-muted p-3 text-sm">
                  <small>已发布</small>
                  <span>{before}</span>
                </span>
                <span
                  className="routing-change-arrow hidden self-center text-muted-foreground sm:block"
                  aria-hidden="true"
                >
                  →
                </span>
                <span className="routing-change-value routing-change-after font-semibold min-w-0 break-words rounded-md bg-muted p-3 text-sm">
                  <small>待发布</small>
                  <span>{after}</span>
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>本次比较的摘要字段相同；完整配置仍可能有变化。</p>
      )}
      <p>
        {companionCategories
          ? comparisonLimit(companionCategories, false)
          : "未比较具体规则、策略组内容和节点设置。"}
      </p>
      <AdvancedSummaryNotes
        hasGroup={
          published.defaultAction.kind === "group" ||
          candidate.defaultAction.kind === "group"
        }
      />
    </div>
  );
}
export function RoutingSummaryView({
  summary,
  intent,
}: {
  summary?: RoutingSummary;
  intent?: FrozenRoutingIntent;
}) {
  if (intent?.version === 1)
    return <FrozenRoutingIntentView intent={intent} summary={summary} />;
  if (!summary || summary.version !== 1)
    return (
      <p className="muted text-sm text-muted-foreground">
        这份订阅暂无可用的分流摘要。
      </p>
    );
  if (summary.kind === "advanced") {
    if (!summary.advanced)
      return (
        <p className="muted text-sm text-muted-foreground">
          这份高级配置暂无可用的分流详情。
        </p>
      );
    const { defaultAction, ruleCount, groupCount, nodeCount } =
      summary.advanced;
    return (
      <div>
        <dl className="routing-summary space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
          <dt>未匹配规则的流量</dt>
          <dd>{defaultActionLabel(defaultAction)}</dd>
          <dt>配置内容</dt>
          <dd>
            {ruleCount} 条分流规则 · {groupCount} 个策略组 · {nodeCount} 个节点
          </dd>
        </dl>
        <AdvancedSummaryNotes hasGroup={defaultAction.kind === "group"} />
      </div>
    );
  }
  if (summary.kind !== "basic") {
    const descriptions = {
      "native-override": "使用原生配置覆盖，无法提供可靠的分流摘要。",
      "nodes-only": "纯节点订阅，仅交付连接。",
    };
    return <p>{descriptions[summary.kind]}</p>;
  }
  return (
    <dl className="routing-summary space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
      <dt>ChatGPT</dt>
      <dd>{summary.chatGPT?.label || "未提供分流摘要"}</dd>
      <dt>其他流量</dt>
      <dd>{summary.default?.label || "未提供分流摘要"}</dd>
    </dl>
  );
}
export function RoutingReview({
  published,
  candidate,
  publishedIntent,
  candidateIntent,
  creation = false,
  decisionReview = false,
  companionCategories,
}: {
  published?: RoutingSummary;
  candidate?: RoutingSummary;
  publishedIntent?: FrozenRoutingIntent;
  candidateIntent?: FrozenRoutingIntent;
  creation?: boolean;
  decisionReview?: boolean;
  companionCategories?: CompanionCategories;
}) {
  const basicComparison =
    !creation &&
    published?.version === 1 &&
    published.kind === "basic" &&
    candidate?.version === 1 &&
    candidate.kind === "basic";
  const advancedComparison =
    !creation &&
    published?.version === 1 &&
    published.kind === "advanced" &&
    published.advanced &&
    candidate?.version === 1 &&
    candidate.kind === "advanced" &&
    candidate.advanced;
  const matchingKind =
    published?.version === 1 &&
    candidate?.version === 1 &&
    published.kind === candidate.kind;
  return (
    <section
      aria-label={
        creation ? "待发布分流" : decisionReview ? "分流比较" : "分流摘要"
      }
      className="routing-decision-review space-y-4 [&_h3]:text-base [&_h3]:font-semibold"
    >
      <h3>
        {creation ? "待发布分流" : decisionReview ? "分流比较" : "分流摘要"}
      </h3>
      {creation ? (
        <RoutingSummaryView summary={candidate} intent={candidateIntent} />
      ) : publishedIntent?.version === 1 || candidateIntent?.version === 1 ? (
        <FrozenRoutingComparison
          published={published}
          candidate={candidate}
          publishedIntent={publishedIntent}
          candidateIntent={candidateIntent}
          decisionReview={decisionReview}
          companionCategories={companionCategories}
        />
      ) : matchingKind && candidate?.kind === "native-override" ? (
        <p className="routing-comparison-limit text-sm text-muted-foreground">
          已发布与待发布均使用原生配置覆盖，无法提供可靠的分流比较。
        </p>
      ) : matchingKind && candidate?.kind === "nodes-only" ? (
        <p className="routing-comparison-limit text-sm text-muted-foreground">
          {companionCategories?.nodes
            ? "纯节点订阅仅交付连接。"
            : "纯节点订阅仅交付连接；本摘要未比较节点及连接设置。"}
        </p>
      ) : advancedComparison ? (
        <AdvancedRoutingChanges
          published={published!.advanced!}
          candidate={candidate!.advanced!}
          companionCategories={companionCategories}
        />
      ) : basicComparison ? (
        <>
          <p className="muted text-sm text-muted-foreground">已发布 → 待发布</p>
          <dl className="routing-summary space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
            <dt>ChatGPT</dt>
            <dd>
              {published.chatGPT?.label || "未提供摘要"} →{" "}
              {candidate.chatGPT?.label || "未提供摘要"}
            </dd>
            <dt>其他流量</dt>
            <dd>
              {published.default?.label || "未提供摘要"} →{" "}
              {candidate.default?.label || "未提供摘要"}
            </dd>
          </dl>
        </>
      ) : (
        <div className="routing-review space-y-4">
          {!creation && (
            <div>
              <h4>已发布</h4>
              <RoutingSummaryView summary={published} />
            </div>
          )}
          <div>
            <h4>待发布</h4>
            <RoutingSummaryView summary={candidate} />
          </div>
        </div>
      )}
    </section>
  );
}
