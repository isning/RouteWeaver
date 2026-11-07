import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useId } from "react";
import { bytesLabel, bitrateLabel, dateLabel } from "./model";
import type { Entitlement } from "./types";
import type { EntitlementPolicyResource, NamedRecord } from "./access-policy-model";
type Field = {
    key: string;
    label: string;
    raw: unknown;
    text: string;
};
const limit = (value: number | null | undefined, format: (value: number) => string) => value == null ? "继承" : value === 0 ? "明确不限制（0）" : format(value);
const saved = (value: unknown) => value === undefined || value === "" ? "未设置" : String(value);
const knownMode = (mode: string) => ["monthly", "anniversary", "fixed-days", "none"].includes(mode);
const parameter = (mode: string, active: string, value: unknown) => mode === active ? saved(value) : `${knownMode(mode) ? "未启用" : "适用性未知"}，保存值：${saved(value)}`;
function fields(ent: Entitlement): Field[] {
    const cycle = ent.cycle;
    return [
        { key: "service", label: "个人指定方案", raw: ent.serviceId, text: ent.serviceId || "继承用户组方案" },
        { key: "routes", label: "个人线路授权（ID）", raw: ent.routeIdsOverride, text: ent.routeIdsOverride == null ? "继承线路授权" : ent.routeIdsOverride.length ? ent.routeIdsOverride.join("、") : "禁止所有线路" },
        { key: "quota", label: "个人周期额度", raw: ent.quotaOverride, text: limit(ent.quotaOverride, bytesLabel) },
        { key: "ips", label: "个人在线 IP 上限", raw: ent.onlineIpLimitOverride, text: limit(ent.onlineIpLimitOverride, (v) => `${v} 个`) },
        { key: "connections", label: "个人并发逻辑流上限", raw: ent.connectionLimitOverride, text: limit(ent.connectionLimitOverride, (v) => `${v} 条`) },
        { key: "rate", label: "个人入口限速", raw: ent.entryRateBpsOverride, text: limit(ent.entryRateBpsOverride, bitrateLabel) },
        { key: "startsAt", label: "开通时间", raw: ent.startsAt, text: ent.startsAt === "0001-01-01T00:00:00Z" ? "未单独设置" : ent.startsAt },
        { key: "expiresAt", label: "到期时间", raw: ent.expiresAt, text: ent.expiresAt || "不过期" },
        { key: "paused", label: "暂停平台服务", raw: ent.paused, text: ent.paused ? "暂停" : "不暂停" },
        { key: "mode", label: "账号流量周期", raw: cycle.mode, text: ({ monthly: "每月固定日", anniversary: "按周期起点日每月重置", "fixed-days": "固定天数周期", none: "不自动重置" } as Record<string, string>)[cycle.mode] ?? `未支持的规则：${cycle.mode}` },
        { key: "day", label: "每月几号", raw: cycle.day, text: parameter(cycle.mode, "monthly", cycle.day) },
        { key: "days", label: "每周期天数", raw: cycle.days, text: parameter(cycle.mode, "fixed-days", cycle.days) },
        { key: "anchor", label: "账号周期起点", raw: cycle.anchor, text: cycle.anchor === "0001-01-01T00:00:00Z" ? dateLabel(cycle.anchor) : saved(cycle.anchor) },
        { key: "timezone", label: "账号周期时区", raw: cycle.timezone, text: saved(cycle.timezone) },
    ];
}
// Creation is one set of choices, not fourteen repetitions of a missing row.
// Keep operative settings visible; exact inactive values stay in full details.
function creationFields(ent: Entitlement): Field[] {
    const values = fields(ent), pick = (key: string) => values.find((field) => field.key === key)!;
    const limits = ["quota", "ips", "connections", "rate"].map(pick), explicit = limits.filter((field) => field.raw != null);
    const cycle = ent.cycle, unknown = !knownMode(cycle.mode);
    // Even 'none' uses a nonzero anchor as its accounting window start.
    const showAnchor = unknown || cycle.mode !== "none" || !!cycle.anchor && cycle.anchor !== "0001-01-01T00:00:00Z";
    return [pick("service"), pick("routes"), ...explicit,
        ...(explicit.length < limits.length ? [{ key: "inherited-limits", label: explicit.length ? "其余个人额度与限制" : "个人额度与限制", raw: null, text: "未单独覆盖" }] : []),
        pick("startsAt"), pick("expiresAt"), ...(ent.paused ? [pick("paused")] : []), pick("mode"),
        ...(unknown || cycle.mode === "monthly" ? [pick("day")] : []),
        ...(unknown || cycle.mode === "fixed-days" ? [pick("days")] : []),
        ...(showAnchor ? [pick("anchor"), pick("timezone")] : [])];
}
// These are stored personal settings, not a second effective-policy projection.
export function EntitlementPolicyComparison({ resource, services = [], title = "个人授权变更", beforeLabel = "当前保存", afterLabel = "本次保存", showAll = false }: {
    resource: EntitlementPolicyResource;
    services?: NamedRecord[];
    title?: string;
    beforeLabel?: string;
    afterLabel?: string;
    showAll?: boolean;
}) {
    const id = useId(), before = resource.before?.entitlement, previous = before ? fields(before) : [];
    const after = resource.after.entitlement, modeChanged = before?.cycle.mode !== after.cycle.mode;
    const rows = !before ? creationFields(after) : fields(after).filter((field) => showAll || !before || JSON.stringify(previous.find((old) => old.key === field.key)?.raw) !== JSON.stringify(field.raw) ||
        (modeChanged && ["day", "days"].includes(field.key) &&
            (!knownMode(after.cycle.mode) || !knownMode(before.cycle.mode) ||
                [before.cycle.mode, after.cycle.mode].includes(field.key === "day" ? "monthly" : "fixed-days"))));
    const text = (field: Field, other?: Field) => {
        // Resolve only the stored personal selection by stable ID. An effective
        // group plan must never become a stored personal override in this view.
        if (field.key === "service" && typeof field.raw === "string" && field.raw) {
            const matches = services.filter((service) => service.id === field.raw);
            const name = matches.length === 1 && matches[0].name?.trim() ? matches[0].name : "方案名称不可用";
            return <div className="space-y-1"><span>{name}</span><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">方案标识</summary><code>{field.raw}</code></details></div>;
        }
        return other && field.text === other.text && JSON.stringify(field.raw) !== JSON.stringify(other.raw)
            ? `${field.text}（保存值：${JSON.stringify(field.raw) ?? "未设置"}${field.key === "quota" ? " 字节" : field.key === "rate" ? " 字节/秒" : ""}）` : field.text;
    };
    return <section aria-labelledby={`${id}-title`} className="space-y-3 text-sm [overflow-wrap:anywhere]"><h3 className="text-base font-medium" id={`${id}-title`}>{title}</h3>
    {!before && <p>新建个人授权设置</p>}
    {rows.length ? <Table className={`policy-comparison-table w-full table-fixed text-sm [&_th]:p-2 [&_td]:p-2 sm:[&_th]:p-3 sm:[&_td]:p-3 [&_th]:whitespace-normal [&_td]:whitespace-normal [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere] [&_th]:text-left [&_th]:font-medium [&_tr]:border-b [&_thead]:bg-muted/50${before ? "" : " policy-creation-summary"}`} role="table" aria-labelledby={`${id}-title`}>
      <TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col" role="columnheader" className="policy-comparison-field-heading text-left font-medium">个人设置</TableHead>{before && <TableHead scope="col" role="columnheader" id={`${id}-before`}>{beforeLabel}</TableHead>}<TableHead scope="col" role="columnheader" id={`${id}-after`}>{afterLabel}</TableHead></TableRow></TableHeader>
      <TableBody role="rowgroup">{rows.map((field) => <TableRow role="row" key={field.key}><TableHead role="rowheader" scope="row" id={`${id}-${field.key}`}>{field.label}</TableHead>{before && <TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-before`}>{text(previous.find((old) => old.key === field.key)!, field)}</TableCell>}<TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-after`}>{text(field, previous.find((old) => old.key === field.key))}</TableCell></TableRow>)}</TableBody>
    </Table> : <p className="muted text-sm text-muted-foreground">个人设置保持不变。</p>}
    <details className="space-y-3 rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">账号标识与完整保存值</summary><code>{resource.target.id}</code><pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify({ before: resource.before, after: resource.after }, null, 2)}</pre></details>
  </section>;
}
