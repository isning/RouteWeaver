import type { ReactNode } from "react";
import type {
  GroupChange,
  GroupValue,
  NodeChange,
  SafeRef,
  SemanticCategory,
  SemanticChanges,
  Uses,
} from "./types";

const selectionLabels = {
  manual: "手动选择",
  "url-test": "延迟优选",
  fallback: "故障切换",
  "load-balance": "负载均衡",
};
const strategyLabels = {
  "consistent-hashing": "一致性哈希",
  "round-robin": "轮询",
  "sticky-sessions": "会话保持",
};
const categoryLabels = {
  endpoint: "服务器地址或端口",
  protocol: "协议",
  authentication: "认证",
  security: "安全",
  transport: "传输",
  "protocol-options": "协议选项",
  other: "其他连接选项",
};
const unavailableReasons = {
  "baseline-missing": "已发布版本没有可比较的快照。",
  unsupported: "此配置不支持这项比较。",
  "size-limit": "内容超出比较范围。",
  "invalid-snapshot": "比较快照不可用。",
  "redaction-unavailable": "无法安全展示这项比较。",
};
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const member = (value: unknown): value is SafeRef =>
  record(value) &&
  ["endpoint", "group", "direct"].includes(String(value.kind)) &&
  (value.ref === undefined || text(value.ref)) &&
  (value.label === undefined || text(value.label));
function validUses(value: unknown): value is Uses {
  return (
    record(value) &&
    value.scope === "direct" &&
    ["available", "partial", "unavailable"].includes(String(value.state)) &&
    typeof value.default === "boolean" &&
    Array.isArray(value.rules) &&
    value.rules.length <= 10 &&
    value.rules.every(
      (rule) =>
        record(rule) && text(rule.id) && count(rule.index) && rule.index > 0,
    ) &&
    Array.isArray(value.groups) &&
    value.groups.length <= 10 &&
    value.groups.every(member) &&
    count(value.omittedRuleCount) &&
    count(value.omittedGroupCount)
  );
}
function validGroupValue(value: unknown): value is GroupValue {
  return (
    record(value) &&
    text(value.label) &&
    Object.hasOwn(selectionLabels, String(value.selection)) &&
    (value.strategy === undefined ||
      Object.hasOwn(strategyLabels, String(value.strategy))) &&
    count(value.memberCount)
  );
}
function validChange(value: unknown) {
  return (
    record(value) &&
    text(value.id) &&
    ["added", "removed", "modified"].includes(String(value.kind)) &&
    typeof value.nameChanged === "boolean" &&
    validUses(value.usesBefore) &&
    validUses(value.usesAfter)
  );
}
function validGroup(value: unknown): value is GroupChange {
  if (!record(value) || !validChange(value)) return false;
  return (
    (value.kind === "added"
      ? value.before === undefined
      : validGroupValue(value.before)) &&
    (value.kind === "removed"
      ? value.after === undefined
      : validGroupValue(value.after)) &&
    ["strategyChanged", "parametersChanged", "memberOrderChanged"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
    Array.isArray(value.membersAdded) &&
    value.membersAdded.length <= 20 &&
    value.membersAdded.every(member) &&
    Array.isArray(value.membersRemoved) &&
    value.membersRemoved.length <= 20 &&
    value.membersRemoved.every(member) &&
    count(value.omittedAddedMemberCount) &&
    count(value.omittedRemovedMemberCount)
  );
}
function validNode(value: unknown): value is NodeChange {
  return (
    record(value) &&
    validChange(value) &&
    (value.kind === "added"
      ? value.beforeLabel === undefined
      : text(value.beforeLabel)) &&
    (value.kind === "removed"
      ? value.afterLabel === undefined
      : text(value.afterLabel)) &&
    typeof value.settingsChanged === "boolean" &&
    Array.isArray(value.changedCategories) &&
    value.changedCategories.every(
      (category) =>
        typeof category === "string" && Object.hasOwn(categoryLabels, category),
    )
  );
}
function category<T extends { id: string }>(
  value: unknown,
  validRow: (row: unknown) => row is T,
): SemanticCategory<T> {
  if (record(value)) {
    if (
      value.state === "unavailable" &&
      typeof value.reason === "string" &&
      Object.hasOwn(unavailableReasons, value.reason)
    )
      return value as unknown as SemanticCategory<T>;
    if (
      value.state === "available" &&
      count(value.beforeCount) &&
      count(value.afterCount) &&
      count(value.changedCount) &&
      count(value.omittedRowCount) &&
      Array.isArray(value.rows) &&
      value.rows.length <= 50 &&
      value.rows.every(validRow) &&
      value.rows.length + value.omittedRowCount === value.changedCount &&
      value.changedCount <= value.beforeCount + value.afterCount &&
      (value.changedCount !== 0 || value.beforeCount === value.afterCount) &&
      new Set(value.rows.map((row) => row.id)).size === value.rows.length
    )
      return value as unknown as SemanticCategory<T>;
  }
  return { state: "unavailable", reason: "invalid-snapshot" };
}
function refLabel(ref: SafeRef) {
  return ref.kind === "direct"
    ? "直连"
    : `${ref.kind === "group" ? "策略组" : "连接"}「${ref.label || "未提供名称"}」`;
}
function strategy(value: GroupValue) {
  return (
    <span className="grid gap-1">
      <span>{selectionLabels[value.selection]}</span>
      {value.strategy && (
        <span className="text-muted-foreground">
          {strategyLabels[value.strategy]}
        </span>
      )}
    </span>
  );
}
function Versions({ before, after }: { before: ReactNode; after: ReactNode }) {
  return (
    <div className="routing-intent-versions grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:space-y-2 [&>div]:rounded-md [&>div]:bg-muted/50 [&>div]:p-3 [&>div]:wrap-anywhere [&>div>span]:block [&>div>strong]:block">
      <div>
        <span className="muted text-sm text-muted-foreground">已发布</span>
        <span>{before}</span>
      </div>
      <span
        className="routing-change-arrow hidden self-center text-muted-foreground sm:block"
        aria-hidden="true"
      >
        →
      </span>
      <div>
        <span className="muted text-sm text-muted-foreground">待发布</span>
        <strong>{after}</strong>
      </div>
    </div>
  );
}
function DirectUses({ value }: { value: Uses }) {
  if (value.state === "unavailable") return <span>直接引用信息不可用。</span>;
  const entries = [
    value.default ? "默认去向" : "",
    ...value.rules.map((rule) => `规则 ${rule.index}`),
    ...value.groups.map(refLabel),
  ].filter(Boolean);
  return (
    <>
      {entries.length > 0 ? (
        <span>{entries.join("、")}</span>
      ) : value.state === "available" &&
        !value.omittedRuleCount &&
        !value.omittedGroupCount ? (
        <span>无直接引用。</span>
      ) : (
        <span>暂无可展示的直接引用。</span>
      )}
      {value.omittedRuleCount > 0 && (
        <span>另有 {value.omittedRuleCount} 条规则引用未列出。</span>
      )}
      {value.omittedGroupCount > 0 && (
        <span>另有 {value.omittedGroupCount} 个策略组引用未列出。</span>
      )}
      {value.state === "partial" && <span>直接引用信息不完整。</span>}
    </>
  );
}
function UsesDetails({ before, after }: { before: Uses; after: Uses }) {
  const unavailable =
    before.state === "unavailable" || after.state === "unavailable";
  const partial = [before, after].some(
    (use) =>
      use.state === "partial" ||
      use.omittedRuleCount > 0 ||
      use.omittedGroupCount > 0,
  );
  return (
    <details>
      <summary>
        查看直接引用
        {unavailable ? "（部分不可用）" : partial ? "（部分未展示）" : ""}
      </summary>
      <p>此处仅展示配置中的直接引用；完整间接依赖与实际流量需另行核对。</p>
      <Versions
        before={<DirectUses value={before} />}
        after={<DirectUses value={after} />}
      />
    </details>
  );
}
function IdentityDetails({
  id,
  members = [],
}: {
  id: string;
  members?: { action: string; value: SafeRef }[];
}) {
  return (
    <details className="routing-target-identities flex flex-wrap gap-2">
      <summary>查看对象标识</summary>
      <dl className="routing-summary space-y-3">
        <div>
          <dt>对象标识</dt>
          <dd>{id}</dd>
        </div>
        {members
          .filter(({ value }) => !!value.ref)
          .map(({ action, value }, index) => (
            <div key={`${action}-${value.ref}-${index}`}>
              <dt>
                {action}：{refLabel(value)}
              </dt>
              <dd>{value.ref}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
function GroupRow({ row }: { row: GroupChange }) {
  const label = row.after?.label || row.before!.label;
  return (
    <li>
      <h4>{label}</h4>
      {row.kind !== "modified" && (
        <p className="routing-intent-change-state text-sm text-muted-foreground">
          {row.kind === "added" ? "新增策略组" : "移除策略组"}
        </p>
      )}
      {row.nameChanged && (
        <Versions
          before={row.before?.label || "无此策略组"}
          after={row.after?.label || "移除此策略组"}
        />
      )}
      {(row.strategyChanged || row.kind !== "modified") && (
        <div>
          <h5>选择方式</h5>
          <Versions
            before={row.before ? strategy(row.before) : "无此策略组"}
            after={row.after ? strategy(row.after) : "移除此策略组"}
          />
        </div>
      )}
      {row.parametersChanged && <p>策略参数已更改。</p>}
      {row.membersAdded.length > 0 && (
        <p>加入成员：{row.membersAdded.map(refLabel).join("、")}</p>
      )}
      {row.membersRemoved.length > 0 && (
        <p>移除成员：{row.membersRemoved.map(refLabel).join("、")}</p>
      )}
      {row.omittedAddedMemberCount > 0 && (
        <p>另有 {row.omittedAddedMemberCount} 个加入成员未列出。</p>
      )}
      {row.omittedRemovedMemberCount > 0 && (
        <p>另有 {row.omittedRemovedMemberCount} 个移除成员未列出。</p>
      )}
      {row.memberOrderChanged && <p>成员顺序已调整。</p>}
      <UsesDetails before={row.usesBefore} after={row.usesAfter} />
      <IdentityDetails
        id={row.id}
        members={[
          ...row.membersAdded.map((value) => ({ action: "加入成员", value })),
          ...row.membersRemoved.map((value) => ({ action: "移除成员", value })),
        ]}
      />
    </li>
  );
}
function NodeRow({ row }: { row: NodeChange }) {
  return (
    <li>
      <h4>{row.afterLabel || row.beforeLabel}</h4>
      {row.kind !== "modified" && (
        <p className="routing-intent-change-state text-sm text-muted-foreground">
          {row.kind === "added" ? "新增连接" : "移除连接"}
        </p>
      )}
      {row.nameChanged && (
        <Versions
          before={row.beforeLabel || "无此连接"}
          after={row.afterLabel || "移除此连接"}
        />
      )}
      {row.settingsChanged && (
        <p>
          连接设置已更改
          {row.changedCategories.length
            ? `：${row.changedCategories.map((value) => categoryLabels[value]).join("、")}`
            : ""}
          。
        </p>
      )}
      <UsesDetails before={row.usesBefore} after={row.usesAfter} />
      <IdentityDetails id={row.id} />
    </li>
  );
}
function CategoryReview<T extends { id: string }>({
  title,
  noun,
  value,
  children,
}: {
  title: string;
  noun: string;
  value: SemanticCategory<T>;
  children: (row: T) => ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="routing-decision-review routing-update-review semantic-change-review space-y-4 rounded-lg border p-4 [&_h3]:text-sm [&_h3]:font-semibold [&_summary]:min-h-11 [&_summary]:cursor-pointer [&_summary]:rounded-sm [&_summary]:py-3 [&_summary]:outline-none [&_summary]:focus-visible:ring-2 [&_summary]:focus-visible:ring-ring"
    >
      <h3>{title}</h3>
      {value.state === "unavailable" ? (
        <p>{unavailableReasons[value.reason]}可查看待发布技术配置。</p>
      ) : (
        <>
          {value.changedCount === 0 ? (
            <p>{noun}未变化。</p>
          ) : (
            <>
              <ul className="routing-intent-changes space-y-4">
                {value.rows.map(children)}
              </ul>
              {value.omittedRowCount > 0 && (
                <p>
                  另有 {value.omittedRowCount} 个{noun}变化未列出。
                </p>
              )}
              <details className="muted text-sm text-muted-foreground">
                <summary>数量明细</summary>
                <div className="grid gap-1">
                  <p>
                    {value.changedCount} 个{noun}变化
                  </p>
                  <p>
                    已发布 {value.beforeCount} 个 → 待发布 {value.afterCount} 个
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

// Only the selected Output review renders this owner-safe comparison. It never
// determines publish eligibility, draft status, a link effect or client state.
export function SemanticOutputChanges({
  value,
  unchangedOnly = false,
  unchangedContext,
}: {
  value?: SemanticChanges;
  unchangedOnly?: boolean;
  unchangedContext?: ReactNode;
}) {
  const known =
    value?.version === 1 &&
    typeof value.renderedConfigurationChanged === "boolean";
  if (!known && unchangedOnly) return null;
  if (!known)
    return (
      <section
        aria-label="策略组与连接比较"
        className="routing-decision-review routing-update-review space-y-4 rounded-lg border p-4 [&_h3]:text-sm [&_h3]:font-semibold [&_summary]:min-h-11 [&_summary]:cursor-pointer [&_summary]:rounded-sm [&_summary]:py-3 [&_summary]:outline-none [&_summary]:focus-visible:ring-2 [&_summary]:focus-visible:ring-ring"
      >
        <h3>策略组与连接比较</h3>
        <p>此版本没有可用的策略组和连接比较。可查看待发布技术配置。</p>
      </section>
    );
  const groups = category(value.groups, validGroup),
    nodes = category(value.nodes, validNode);
  const sameGroups = groups.state === "available" && groups.changedCount === 0;
  const sameNodes = nodes.state === "available" && nodes.changedCount === 0;
  if (unchangedOnly)
    return sameGroups || sameNodes ? (
      <p className="muted text-sm text-muted-foreground">
        {sameGroups && sameNodes
          ? "策略组和连接未变化。"
          : sameGroups
            ? "策略组未变化。"
            : "连接未变化。"}
      </p>
    ) : null;
  const groupReview = !sameGroups && (
    <CategoryReview
      key="groups"
      title="策略组变化"
      noun="策略组"
      value={groups}
    >
      {(row) => <GroupRow key={row.id} row={row} />}
    </CategoryReview>
  );
  const nodeReview = !sameNodes && (
    <CategoryReview key="nodes" title="连接变化" noun="连接" value={nodes}>
      {(row) => <NodeRow key={row.id} row={row} />}
    </CategoryReview>
  );
  const rank = (item: SemanticCategory<unknown>) =>
    item.state === "available" ? (item.changedCount > 0 ? 0 : 2) : 1;
  return (
    <>
      {value.renderedConfigurationChanged === false && (
        <>
          <p>生成的配置文本与已发布版本相同。</p>
          {unchangedContext && <p>{unchangedContext}</p>}
        </>
      )}
      {groups.state === "unavailable" &&
      nodes.state === "unavailable" &&
      groups.reason === nodes.reason ? (
        <section
          aria-label="策略组与连接比较"
          className="routing-decision-review routing-update-review space-y-4 rounded-lg border p-4 [&_h3]:text-sm [&_h3]:font-semibold [&_summary]:min-h-11 [&_summary]:cursor-pointer [&_summary]:rounded-sm [&_summary]:py-3 [&_summary]:outline-none [&_summary]:focus-visible:ring-2 [&_summary]:focus-visible:ring-ring"
        >
          <h3>策略组与连接比较</h3>
          <p>{unavailableReasons[groups.reason]}可查看待发布技术配置。</p>
        </section>
      ) : rank(nodes) < rank(groups) ? (
        [nodeReview, groupReview]
      ) : (
        [groupReview, nodeReview]
      )}
    </>
  );
}
