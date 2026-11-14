import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/ui-patterns/actions";
import { request } from "./api";
import { bytesLabel, dateLabel } from "./model";
import { observationPath } from "./observability-model";

export interface ResourcePoint {
  observedAt: string;
  cpuPercent: number | null;
  memoryUsedPercent: number;
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
  breakBefore: boolean;
}
export interface ResourceHistoryView {
  nodeId: string; available: boolean; reason?: string; intervalSeconds: number;
  windowStart: string; windowEnd: string; points: ResourcePoint[];
}
const valid = (n: number | null | undefined) => n != null && Number.isFinite(n) && n >= 0;
const formatRate = (n: number) => `${bytesLabel(Math.round(n))}/s`;
function Series({ points, fields, maximum, start, end, interval, windowLabel, title, format }: {
  points: ResourcePoint[]; fields: { key: "cpuPercent" | "memoryUsedPercent" | "receiveBytesPerSecond" | "transmitBytesPerSecond"; label: string; color: string }[];
  maximum?: number; start: number; end: number; interval: number; windowLabel: string; title: string; format: (n: number) => string;
}) {
  const all = fields.flatMap(f => points.map(p => p[f.key])).filter(valid) as number[];
  const max = maximum || Math.max(1, ...all);
  const x = (at: string) => 6 + 488 * (Date.parse(at) - start) / (end - start);
  const y = (n: number) => 142 - 132 * Math.min(1, n / max);
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p className="font-medium">{title}</p></div>
    {!all.length ? <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">尚无可绘制的数据</div> : <div className="grid h-40 min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-2">
      <div aria-hidden="true" className="relative text-right text-[11px] leading-none tabular-nums text-muted-foreground">{[max, max / 2, 0].map((value, index) => <span key={index} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${y(value) / 155 * 100}%` }}>{format(value)}</span>)}</div>
      <svg role="img" aria-label={`${title}，最近${windowLabel}实际采样趋势`} viewBox="0 0 500 155" className="h-40 w-full overflow-visible" preserveAspectRatio="none">
      {[max, max / 2, 0].map((value, index) => <line key={index} x1="6" x2="494" y1={y(value)} y2={y(value)} className="stroke-border" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
      {fields.map(f => {
        let previous: ResourcePoint | undefined;
        return <g key={f.key} style={{ color: f.color }}>{points.map((p, index) => {
          const value = p[f.key]; const prior = previous; previous = p;
          if (!valid(value)) return null;
          const link = prior && valid(prior[f.key]) && !p.breakBefore && Date.parse(p.observedAt) - Date.parse(prior.observedAt) <= interval * 1500;
          const next = points[index + 1];
          const linkNext = next && valid(next[f.key]) && !next.breakBefore && Date.parse(next.observedAt) - Date.parse(p.observedAt) <= interval * 1500;
          return <g key={index}>
            {link && <line x1={x(prior!.observedAt)} y1={y(prior![f.key]!)} x2={x(p.observedAt)} y2={y(value!)} stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
            <circle cx={x(p.observedAt)} cy={y(value!)} r={!link && !linkNext ? 2 : 4} fill={!link && !linkNext ? "currentColor" : "transparent"}><title>{f.label} {format(value!)} · {dateLabel(p.observedAt)}</title></circle>
          </g>;
        })}</g>;
      })}
    </svg></div>}
    <div className="flex justify-between gap-2 text-[11px] tabular-nums text-muted-foreground"><time>{dateLabel(new Date(start).toISOString())}</time><time>{dateLabel(new Date(end).toISOString())}</time></div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{fields.map(f => <span className="inline-flex items-center gap-1.5" key={f.key}><span className="size-2 rounded-full" style={{ background: f.color }} />{f.label}</span>)}</div>
  </div>;
}
export function ResourceHistory({ nodeId }: { nodeId: string }) {
  const [window, setWindow] = useState("24h");
  const windowLabel = window === "1h" ? "1小时" : window === "7d" ? "7天" : "24小时";
  const query = useQuery({ queryKey: ["node-resource-history", nodeId, window], queryFn: ({ signal }) => request<ResourceHistoryView>(`${observationPath(nodeId)}/history?window=${window}`, { signal }), refetchInterval: 60000 });
  const data = query.data?.nodeId === nodeId && Array.isArray(query.data.points) && query.data.points.length <= 288 ? query.data : undefined;
  const start = Date.parse(data?.windowStart || ""), end = Date.parse(data?.windowEnd || "");
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && end > start && data?.intervalSeconds === (window === "7d" ? 3600 : 300);
  const points = validWindow ? data!.points.filter(p => Number.isFinite(Date.parse(p.observedAt)) && Date.parse(p.observedAt) >= start && Date.parse(p.observedAt) <= end) : [];
  const last = points.at(-1);
  const stale = last && Date.now() - Date.parse(last.observedAt) > Math.max(15 * 60000, (data?.intervalSeconds || 300) * 1500);
  return <Card aria-label="资源趋势" className="min-w-0 gap-4">
    <CardHeader className="flex flex-row items-start justify-between gap-3">
      <div className="space-y-1"><CardTitle>趋势</CardTitle><CardDescription>最近 {windowLabel} · {window === "7d" ? "每小时" : "每 5 分钟"}保留一次实际采样</CardDescription></div>
      <ActionButton variant="ghost" size="sm" aria-label="刷新资源趋势" leadingIcon={<RotateCw aria-hidden="true" />} pending={query.isFetching} onClick={() => query.refetch()} />
    </CardHeader>
    <CardContent className="space-y-3">
      <Tabs value={window} onValueChange={setWindow}><TabsList aria-label="趋势时间范围"><TabsTrigger value="1h">1 小时</TabsTrigger><TabsTrigger value="24h">24 小时</TabsTrigger><TabsTrigger value="7d">7 天</TabsTrigger></TabsList></Tabs>
      {query.isError && <p role="status" className="text-sm text-muted-foreground">{data ? "趋势刷新失败，保留上次读取的数据。" : "无法读取趋势，请重试。"}</p>}
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">{query.isPaused ? "等待网络连接" : "正在读取趋势…"}</p>}
      {!query.isPending && !query.isError && (!data || !validWindow) && <p role="status" className="text-sm text-muted-foreground">趋势数据尚未确定，请重试。</p>}
      {data && !data.available && <p role="status" className="text-sm text-muted-foreground">历史存储容量已满，当前资源数据仍可查看。</p>}
      {data?.available && validWindow && !points.length && <p role="status" className="text-sm text-muted-foreground">最近 {windowLabel}没有历史数据。收到新的资源上报后开始记录。</p>}
      {data?.available && validWindow && !!points.length && <>
        {stale && <p role="status" className="text-xs text-muted-foreground">最后采样 {dateLabel(last!.observedAt)}，较早的数据不代表当前状态。</p>}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[2fr_1fr]">
          <Series title="计费网卡流量" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} format={formatRate} fields={[{ key: "receiveBytesPerSecond", label: "接收", color: "var(--foreground)" }, { key: "transmitBytesPerSecond", label: "发送", color: "var(--muted-foreground)" }]} />
          <Series title="CPU 与内存" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} maximum={100} format={n => `${n.toFixed(0)}%`} fields={[{ key: "cpuPercent", label: "CPU", color: "var(--foreground)" }, { key: "memoryUsedPercent", label: "内存使用率", color: "var(--muted-foreground)" }]} />
        </div>
        <p className="text-xs text-muted-foreground">实际快照，不代表均值或峰值；历史不能回填。缺失采样与重启处断开显示；网卡速率仅包含所选计费网卡，不等于供应商账单。</p>
      </>}
    </CardContent>
  </Card>;
}
