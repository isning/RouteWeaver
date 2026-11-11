import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useId } from "react";
import type { GroupPolicyResource, GroupReferenceLabels, UserGroup } from "./access-policy-model";
type Field = {
    key: string;
    label: string;
    raw: unknown;
    value: string;
};
type ReferenceKind = keyof GroupReferenceLabels;
const members = (group: UserGroup | undefined) => [...new Set(group?.memberIds ?? [])];
const referenceIDs = (group: UserGroup | undefined, kind: ReferenceKind) => kind === "users" ? members(group) : group?.serviceId ? [group.serviceId] : [];
const referenceNames = (references: GroupReferenceLabels | undefined, kind: ReferenceKind) => new Map<string, string>((references?.[kind] ?? []).map((entry) => [entry.id, entry.name.trim()]));
function fields(group: UserGroup): Field[] {
    return [
        { key: "name", label: "用户组名称", raw: group.name, value: group.name || "未命名" },
        { key: "service", label: "服务方案", raw: group.serviceId, value: group.serviceId || "尚未选择" },
        { key: "members", label: "组成员", raw: group.memberIds, value: `${members(group).length} 位` },
        { key: "priority", label: "用户组优先级", raw: group.priority, value: group.priority === null || group.priority === undefined ? "尚未填写" : String(group.priority) },
    ];
}
/** Read-time names explain IDs; neither labels nor catalogs define a change. */
export function GroupPolicyComparison({ resource, title = "用户组变更", showAll = false, beforeLabel = "当前保存", afterLabel = "本次保存", draftPriority }: {
    resource: GroupPolicyResource;
    title?: string;
    showAll?: boolean;
    beforeLabel?: string;
    afterLabel?: string;
    /** Local retained input only; never supplied for a server policy review. */
    draftPriority?: { value: string; invalid: boolean };
}) {
    const id = useId(), before = resource.before?.group, after = resource.after.group;
    const previous = before ? fields(before) : [], next = fields(after).map((field) => field.key === "priority" && draftPriority ? {
        ...field,
        raw: draftPriority.value === String(field.raw) ? field.raw : draftPriority.value,
        value: draftPriority.value === "" ? "尚未填写" : `${draftPriority.value}${draftPriority.invalid ? "（待修正）" : ""}`,
    } : field);
    const rows = next.filter((field) => showAll || !before || JSON.stringify(previous.find((prior) => prior.key === field.key)?.raw) !== JSON.stringify(field.raw));
    const beforeIDs = new Set(members(before)), afterIDs = new Set(members(after));
    const added = [...afterIDs].filter((member) => !beforeIDs.has(member));
    const removed = [...beforeIDs].filter((member) => !afterIDs.has(member));
    const rawMembersChanged = !!before && JSON.stringify(before.memberIds) !== JSON.stringify(after.memberIds);
    const representationOnly = rawMembersChanged && !added.length && !removed.length;
    const namesBySide = {
        before: { users: referenceNames(resource.references?.before, "users"), services: referenceNames(resource.references?.before, "services") },
        after: { users: referenceNames(resource.references?.after, "users"), services: referenceNames(resource.references?.after, "services") },
    };
    const duplicateLabels = (kind: ReferenceKind) => {
        const names = new Map<string, Set<string>>();
        for (const side of ["before", "after"] as const) {
            for (const referenceID of referenceIDs(side === "before" ? before : after, kind)) {
                const label = namesBySide[side][kind].get(referenceID) || referenceID;
                const ids = names.get(label) ?? new Set<string>();
                ids.add(referenceID);
                names.set(label, ids);
            }
        }
        return new Set([...names].filter(([, ids]) => ids.size > 1).map(([name]) => name));
    };
    const duplicates = { users: duplicateLabels("users"), services: duplicateLabels("services") };
    const identity = (referenceID: string, kind: ReferenceKind, side: "before" | "after", full = false) => {
        const name = namesBySide[side][kind].get(referenceID) || "";
        return <div>{name ? <span>{name}</span> : <code>{referenceID}</code>}
      {name && (full || duplicates[kind].has(name)) && <div className="muted text-sm text-muted-foreground">ID：<code>{referenceID}</code></div>}
    </div>;
    };
    const value = (field: Field, side: "before" | "after", counterpart?: Field) => {
        if (field.key === "service")
            return field.raw ? identity(String(field.raw), "services", side) : "尚未选择";
        if (field.key !== "members" && counterpart && field.value === counterpart.value && JSON.stringify(field.raw) !== JSON.stringify(counterpart.raw))
            return `${field.value}（保存值：${JSON.stringify(field.raw) ?? "未设置"}）`;
        return field.value;
    };
    return <section aria-labelledby={`${id}-title`} className="space-y-3 text-sm [overflow-wrap:anywhere]">
    <h3 className="text-base font-medium" id={`${id}-title`}>{title}</h3>
    {!before && <p>新建用户组</p>}
    {rows.length ? <Table className="policy-comparison-table w-full table-fixed text-sm [&_th]:p-2 [&_td]:p-2 sm:[&_th]:p-3 sm:[&_td]:p-3 [&_th]:whitespace-normal [&_td]:whitespace-normal [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere] [&_th]:text-left [&_th]:font-medium [&_td]:align-top [&_tr]:border-b [&_thead]:bg-muted/50 [&_td]:break-words" role="table" aria-labelledby={`${id}-title`}>
      <TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col" role="columnheader" className="policy-comparison-field-heading text-left font-medium">用户组设置</TableHead><TableHead scope="col" role="columnheader" id={`${id}-before`}>{before ? beforeLabel : "变更前"}</TableHead><TableHead scope="col" role="columnheader" id={`${id}-after`}>{afterLabel}</TableHead></TableRow></TableHeader>
      <TableBody role="rowgroup">{rows.map((field) => {
                const prior = previous.find((item) => item.key === field.key);
                return <TableRow role="row" key={field.key}><TableHead scope="row" role="rowheader" id={`${id}-${field.key}`}>{field.label}</TableHead><TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-before`}>{prior ? value(prior, "before", field) : "尚未创建"}</TableCell><TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-after`}>{value(field, "after", prior)}</TableCell></TableRow>;
            })}</TableBody>
    </Table> : <p className="muted text-sm text-muted-foreground">用户组设置保持不变。</p>}
    {added.length > 0 && <div><p>新增 {added.length} 位</p><ul aria-label="新增成员">{added.map((member) => <li key={member}>{identity(member, "users", "after")}</li>)}</ul></div>}
    {removed.length > 0 && <div><p>移除 {removed.length} 位</p><ul aria-label="移除成员">{removed.map((member) => <li key={member}>{identity(member, "users", "before")}</li>)}</ul></div>}
    {representationOnly && <p>成员不变，保存格式调整</p>}
    <details className="space-y-3 rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">查看完整成员与标识</summary>
      {(["before", "after"] as const).map((side) => {
            const group = side === "before" ? before : after;
            return <section className="space-y-2 border-t pt-3" key={side} aria-labelledby={`${id}-${side}-details`}>
          <h4 id={`${id}-${side}-details`}>{side === "before" ? before ? beforeLabel : "变更前" : afterLabel}</h4>
          {group ? <><p>服务方案</p>{group.serviceId ? identity(group.serviceId, "services", side, true) : <p>尚未选择</p>}
            <p>组成员：{members(group).length} 位</p>
            {members(group).length > 0 && <ul aria-label={`${side === "before" ? beforeLabel : afterLabel}的完整成员`}>{members(group).map((member) => <li key={member}>{identity(member, "users", side, true)}</li>)}</ul>}
            {(representationOnly || showAll) && <p>成员保存值：<code>{JSON.stringify(group.memberIds) ?? "未设置"}</code></p>}
          </> : <p>尚未创建</p>}
        </section>;
        })}
    </details>
    <details className="space-y-3 rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">用户组标识</summary><code>{resource.target.id}</code></details>
  </section>;
}
