import { serviceCountInteger, serviceQuotaBytes, serviceRateBytes } from "./service-quota-input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useId } from "react";
import { bitrateLabel, bytesLabel } from "./model";
import type { Service } from "./types";
import type { ServicePolicyResource } from "./access-policy-model";
type Field = {
    key: string;
    label: string;
    raw: unknown;
    value: string;
};
const optional = (value: unknown, unit = "") => value === undefined || value === "" ? "未设置" : `${value}${unit}`;
const cycleParameter = (mode: string, activeMode: "monthly" | "fixed-days", value: unknown, unit: string) => {
    const saved = optional(value, unit);
    if (mode === activeMode)
        return saved;
    const state = ["monthly", "anniversary", "fixed-days", "none"].includes(mode) ? "未启用" : "适用性未知";
    return `${state}（保存值：${saved}）`;
};
const quantity = (value: unknown, zero: string, format: (value: number) => string) => value === null || value === ""
    ? "尚未填写" : value === undefined ? zero : typeof value !== "number" || !Number.isFinite(value) || value < 0
    ? `待修正：${String(value)}` : value === 0 ? zero : format(value);
const retainedQuota = (value: unknown) => {
    if (value === undefined || value === null || value === "") return "尚未填写";
    const bytes = typeof value === "number" || typeof value === "string" ? serviceQuotaBytes(String(value)) : undefined;
    return bytes === undefined ? `${String(value)} GiB（待修正）`
        : bytes === 0 ? "不限额（0 GiB）" : `${String(value)} GiB（${bytes} 字节）`;
};
const retainedRate = (value: string) => {
    if (value === "") return "尚未填写";
    const bytes = serviceRateBytes(value);
    return bytes === undefined ? `${value} Mbps（待修正）`
        : bytes === 0 ? `不限制（${value} Mbps）` : `${value} Mbps（${bytes} 字节/秒）`;
};
const retainedCount = (value: string, unit: string) => {
    if (value === "") return "尚未填写";
    const count = serviceCountInteger(value);
    return count === undefined ? `${value} ${unit}（待修正）`
        : count === 0 ? `不限制（${value}）` : `${value} ${unit}`;
};
function fields(plan: Service): Field[] {
    const cycle = plan.cycle;
    return [
        { key: "name", label: "方案名称", raw: plan.name, value: plan.name || "未命名" },
        { key: "quota", label: "周期额度", raw: plan.quotaBytes, value: quantity(plan.quotaBytes, "不限额", bytesLabel) },
        { key: "routes", label: "授权线路（ID）", raw: plan.routeIds, value: (plan.routeIds || []).join("、") || "无" },
        { key: "ips", label: "在线 IP 上限", raw: plan.onlineIpLimit, value: quantity(plan.onlineIpLimit, "不限制", (value) => `${value} 个`) },
        { key: "connections", label: "并发逻辑流上限", raw: plan.connectionLimit, value: quantity(plan.connectionLimit, "不限制", (value) => `${value} 条`) },
        { key: "rate", label: "每个逻辑入口速率", raw: plan.entryRateBps, value: quantity(plan.entryRateBps, "不限制", bitrateLabel) },
        { key: "mode", label: "账号周期默认规则", raw: cycle.mode, value: ({ monthly: "每月固定日", anniversary: "按周期起点日每月重置", "fixed-days": "固定天数周期", none: "不自动重置" } as Record<string, string>)[cycle.mode] || `未支持的规则：${cycle.mode}` },
        { key: "day", label: "每月重置日", raw: cycle.day, value: cycleParameter(cycle.mode, "monthly", cycle.day, " 日") },
        { key: "days", label: "周期天数", raw: cycle.days, value: cycleParameter(cycle.mode, "fixed-days", cycle.days, " 天") },
        { key: "anchor", label: "周期起点（方案保存值）", raw: cycle.anchor, value: optional(cycle.anchor) },
        { key: "timezone", label: "周期时区（方案保存值）", raw: cycle.timezone, value: optional(cycle.timezone) },
    ];
}
/** Resource intent, deliberately separate from existing-account effective policy. */
export function ServicePolicyComparison({ resource, title = "方案变更", showAll = false, beforeLabel = "当前保存", afterLabel = "本次保存", draftQuota, draftRate, draftCounts }: {
    resource: ServicePolicyResource;
    title?: string;
    showAll?: boolean;
    beforeLabel?: string;
    afterLabel?: string;
    draftQuota?: {
        value: unknown;
    };
    draftRate?: { value: string };
    draftCounts?: Partial<Record<"onlineIpLimit" | "connectionLimit", string>>;
}) {
    const id = useId();
    const before = resource.before?.service;
    const after = resource.after.service;
    const previous = before ? fields(before) : [];
    const next = fields(after).map((field) => {
        if (field.key === "quota" && draftQuota)
            return { ...field, raw: draftQuota.value, value: retainedQuota(draftQuota.value) };
        if (field.key === "rate" && draftRate)
            return { ...field, raw: draftRate.value, value: retainedRate(draftRate.value) };
        const countText = field.key === "ips" ? draftCounts?.onlineIpLimit : field.key === "connections" ? draftCounts?.connectionLimit : undefined;
        if (countText !== undefined)
            return { ...field, raw: countText, value: retainedCount(countText, field.key === "ips" ? "个" : "条") };
        if (showAll && ["quota", "rate"].includes(field.key) && typeof field.raw === "number" && Number.isFinite(field.raw))
            return { ...field, value: `${field.value}（${field.raw} ${field.key === "quota" ? "字节" : "字节/秒"}）` };
        return field;
    });
    const modeChanged = before?.cycle.mode !== after.cycle.mode;
    const rows = next.filter((field) => showAll || !before ||
        JSON.stringify(previous.find((item) => item.key === field.key)?.raw) !== JSON.stringify(field.raw) ||
        (modeChanged && ((field.key === "day" && [before?.cycle.mode, after.cycle.mode].includes("monthly")) || (field.key === "days" && [before?.cycle.mode, after.cycle.mode].includes("fixed-days")))));
    const text = (field: Field, counterpart?: Field) => counterpart && field.value === counterpart.value && JSON.stringify(field.raw) !== JSON.stringify(counterpart.raw)
        ? `${field.value}（保存值：${JSON.stringify(field.raw) ?? "未设置"}）` : field.value;
    return <section aria-labelledby={`${id}-title`} className="space-y-3 text-sm [overflow-wrap:anywhere]">
    <h3 className="text-base font-medium" id={`${id}-title`}>{title}</h3>
    {!before && <p>新建方案</p>}
    {rows.length ? <Table className="policy-comparison-table w-full table-fixed text-sm [&_th]:p-2 [&_td]:p-2 sm:[&_th]:p-3 sm:[&_td]:p-3 [&_th]:whitespace-normal [&_td]:whitespace-normal [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere] [&_th]:text-left [&_th]:font-medium [&_td]:align-top [&_tr]:border-b [&_thead]:bg-muted/50 [&_td]:break-words" role="table" aria-labelledby={`${id}-title`}>
      <TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col" role="columnheader" className="policy-comparison-field-heading text-left font-medium">方案设置</TableHead><TableHead scope="col" role="columnheader" id={`${id}-before`}>{before ? beforeLabel : "变更前"}</TableHead><TableHead scope="col" role="columnheader" id={`${id}-after`}>{afterLabel}</TableHead></TableRow></TableHeader>
      <TableBody role="rowgroup">{rows.map((field) => {
                const prior = previous.find((item) => item.key === field.key);
                return <TableRow role="row" key={field.key}><TableHead scope="row" role="rowheader" id={`${id}-${field.key}`}>{field.label}</TableHead><TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-before`}>{prior ? text(prior, field) : "尚未创建"}</TableCell><TableCell className="whitespace-normal [overflow-wrap:anywhere]" role="cell" headers={`${id}-${field.key} ${id}-after`}>{text(field, prior)}</TableCell></TableRow>;
            })}</TableBody>
    </Table> : <p className="muted text-sm text-muted-foreground">方案设置保持不变。</p>}
    {rows.some((field) => ["mode", "day", "days"].includes(field.key)) && <p className="muted text-sm text-muted-foreground">首次设置账号周期时使用的默认规则；已有账号继续沿用各自的周期。</p>}
    {rows.some((field) => ["anchor", "timezone"].includes(field.key)) && <p className="muted text-sm text-muted-foreground">起点与时区为方案保存值；已有账号继续沿用各自的周期。</p>}
    <details className="space-y-3 rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">方案标识</summary><code>{resource.target.id}</code></details>
  </section>;
}
