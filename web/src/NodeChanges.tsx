import type { NodeChanges as NodeChangesValue } from "./types";
type Available = Extract<
  NodeChangesValue,
  {
    state: "available";
  }
>;
function available(value: unknown): value is Available {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    v.state !== "available" ||
    typeof v.orderChanged !== "boolean" ||
    !Array.isArray(v.rows) ||
    v.rows.length > 50
  )
    return false;
  const fields = [
    "beforeCount",
    "afterCount",
    "addedCount",
    "removedCount",
    "modifiedCount",
    "affectedNodeCount",
    "omittedRowCount",
  ] as const;
  for (const key of fields)
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) return false;
  const n = v as unknown as Available;
  if (
    n.beforeCount > 10000 ||
    n.afterCount > 10000 ||
    n.removedCount > n.beforeCount ||
    n.addedCount > n.afterCount ||
    n.beforeCount - n.removedCount + n.addedCount !== n.afterCount ||
    n.modifiedCount > n.beforeCount - n.removedCount ||
    n.affectedNodeCount !== n.addedCount + n.removedCount + n.modifiedCount ||
    n.rows.length + n.omittedRowCount !== n.affectedNodeCount ||
    (n.orderChanged && n.beforeCount - n.removedCount < 2)
  )
    return false;
  const label = (x: unknown): x is string =>
    typeof x === "string" && x.trim().length > 0 && x.length <= 1024;
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const item of v.rows) {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.kind !== "string" ||
      !["added", "removed", "modified"].includes(row.kind) ||
      !label(row.label)
    )
      return false;
    if (
      (row.nameChanged !== undefined && typeof row.nameChanged !== "boolean") ||
      (row.settingsChanged !== undefined &&
        typeof row.settingsChanged !== "boolean")
    )
      return false;
    if (row.kind === "modified") {
      if (!row.nameChanged && !row.settingsChanged) return false;
      if (
        row.nameChanged
          ? !label(row.beforeLabel)
          : row.beforeLabel !== undefined
      )
        return false;
    } else if (
      row.nameChanged !== undefined ||
      row.settingsChanged !== undefined ||
      row.beforeLabel !== undefined
    )
      return false;
    counts[row.kind as keyof typeof counts]++;
  }
  return (
    counts.added <= n.addedCount &&
    counts.removed <= n.removedCount &&
    counts.modified <= n.modifiedCount
  );
}
export function NodeChanges({ value }: { value: NodeChangesValue }) {
  if (!available(value))
    return (
      <section
        aria-label="节点变化"
        className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm"
      >
        <h3 className="font-semibold">节点变化</h3>
        <p>无法比较此订阅的节点变化。可查看待发布技术配置。</p>
      </section>
    );
  const changed = value.affectedNodeCount > 0;
  return (
    <section
      aria-label="节点变化"
      className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm"
    >
      <h3 className="font-semibold">节点变化</h3>
      <p>
        已发布 {value.beforeCount} 个 → 待发布 {value.afterCount} 个
      </p>
      {changed ? (
        <p>
          新增 {value.addedCount} 个，移除 {value.removedCount} 个，修改{" "}
          {value.modifiedCount} 个
        </p>
      ) : (
        !value.orderChanged && <p>节点名称和连接设置未变化。</p>
      )}
      {value.rows.length > 0 && (
        <ul className="list-disc space-y-2 pl-5 break-words">
          {value.rows.map((row, index) => (
            <li key={index} className="leading-relaxed">
              {row.kind === "added"
                ? "新增："
                : row.kind === "removed"
                  ? "移除："
                  : "修改："}
              {row.nameChanged ? (
                <>
                  <span>{row.beforeLabel}</span> →{" "}
                </>
              ) : null}
              <strong>{row.label}</strong>
              {row.kind === "modified" && (
                <span className="block text-sm text-muted-foreground">
                  {row.nameChanged && "名称变化"}
                  {row.nameChanged && row.settingsChanged && "、"}
                  {row.settingsChanged && <span>连接设置变化</span>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {value.omittedRowCount > 0 && (
        <p>
          另有 {value.omittedRowCount} 个节点变化未列出；以上数量包含全部变化。
        </p>
      )}
      {value.orderChanged && <p>导出的节点顺序已调整。</p>}
    </section>
  );
}
