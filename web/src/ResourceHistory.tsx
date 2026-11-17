import { Metadata, MetadataItem } from "@/ui-patterns/metadata";
import { useEffect, useId, useRef, useState } from "react";
import { ChartTooltip } from "./ChartTooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
const sampleTime = (at: string) => new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const formatRate = (n: number) => `${bytesLabel(Math.round(n))}/s`;
function Series({ points, fields, maximum, start, end, interval, windowLabel, title, format }: {
  points: ResourcePoint[]; fields: { key: "cpuPercent" | "memoryUsedPercent" | "receiveBytesPerSecond" | "transmitBytesPerSecond"; label: string; color: string }[];
  maximum?: number; start: number; end: number; interval: number; windowLabel: string; title: string; format: (n: number) => string;
}) {
  const [selectedAt, setSelectedAt] = useState<string>();
  const [anchor, setAnchor] = useState<{ x: number; y: number }>();
  const root = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const tooltipID = useId();
  const interaction = useRef<"pointer" | "keyboard">("pointer");
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setAnchor(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const inspectedIndex = points.findIndex(p => p.observedAt === selectedAt);
  const selectedIndex = Math.max(0, inspectedIndex);
  const selected = points[selectedIndex];
  // The retained window rolls forward independently of keyboard inspection.
  // Expire its tooltip with the removed sample, not the slider's readable value.
  if (selectedAt && inspectedIndex < 0) {
    setSelectedAt(undefined);
    setAnchor(undefined);
  }
  const selectAtPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const at = start + ((event.clientX - rect.left) / rect.width * 500 - 6) / 488 * (end - start);
    const nearest = points.reduce((best, point) => Math.abs(Date.parse(point.observedAt) - at) < Math.abs(Date.parse(best.observedAt) - at) ? point : best, points[0]);
    if (nearest) {
      interaction.current = "pointer";
      setSelectedAt(nearest.observedAt);
      setAnchor({ x: 6 / 500 * rect.width + 488 / 500 * rect.width * (Date.parse(nearest.observedAt) - start) / (end - start), y: event.clientY - rect.top });
    }
  };
  const all = fields.flatMap(f => points.map(p => p[f.key])).filter(valid) as number[];
  const max = maximum || Math.max(1, ...all);
  const x = (at: string) => 6 + 488 * (Date.parse(at) - start) / (end - start);
  const y = (n: number) => 142 - 132 * Math.min(1, n / max);
  const reveal = (index: number) => {
    const point = points[index];
    if (!point) return;
    interaction.current = "keyboard";
    setSelectedAt(point.observedAt);
    setAnchor({ x: x(point.observedAt) / 500 * (plot.current?.clientWidth || 0), y: 72 });
  };
  const reading = (point: ResourcePoint, field: typeof fields[number]) => {
    const value = point[field.key];
    if (!valid(value)) return "无数据";
    const precise = value!.toLocaleString(undefined, { maximumFractionDigits: 3 });
    return field.key.endsWith("Percent") ? `${precise}%` : `${format(value!)} (${precise} B/s)`;
  };
  const readout = anchor && selected && (<ChartTooltip id={tooltipID} anchor={anchor}>
        <time className="block font-medium" dateTime={selected.observedAt}>{sampleTime(selected.observedAt)} UTC+8</time>
        <dl className="mt-2 grid gap-1.5">{fields.map(field => <div key={field.key} className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
          <dt className="inline-flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: field.color }} />{field.label}</dt>
          <dd className="ml-auto font-medium tabular-nums">{reading(selected, field)}</dd>
        </div>)}</dl>
      </ChartTooltip>);
  return <div ref={root} className="min-w-0 space-y-3"
    onPointerLeave={event => { if (interaction.current === "pointer" && event.pointerType !== "touch") setAnchor(undefined); }}
    onKeyDown={event => { if (event.key === "Escape") setAnchor(undefined); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setAnchor(undefined); }}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p className="font-medium">{title}</p></div>
    {!all.length ? <div ref={plot} className="relative flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">尚无可绘制的数据{readout}</div> : <div className="grid h-40 min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-2">
      <div aria-hidden="true" className="relative text-right text-[11px] leading-none tabular-nums text-muted-foreground">{[max, max / 2, 0].map((value, index) => <span key={index} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${y(value) / 155 * 100}%` }}>{format(value)}</span>)}</div>
      <div ref={plot} className="relative min-w-0">
      <svg role="img" aria-label={`${title}，最近${windowLabel}实际采样趋势`} onPointerMove={selectAtPointer} onPointerDown={selectAtPointer} viewBox="0 0 500 155" className="h-40 w-full overflow-visible" preserveAspectRatio="none">
      {[max, max / 2, 0].map((value, index) => <line key={index} x1="6" x2="494" y1={y(value)} y2={y(value)} className="stroke-border" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
      {anchor && selected && <line x1={x(selected.observedAt)} x2={x(selected.observedAt)} y1="10" y2="142" className="stroke-foreground" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
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
            <circle cx={x(p.observedAt)} cy={y(value!)} r={!link && !linkNext ? 2 : 4} fill={!link && !linkNext ? "currentColor" : "transparent"} />
          </g>;
        })}</g>;
      })}
    </svg>
    {anchor && selected && <>
      {fields.map(field => valid(selected[field.key]) && <span key={field.key} aria-hidden="true"
        className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `${x(selected.observedAt) / 500 * 100}%`, top: `${y(selected[field.key]!) / 155 * 100}%`, background: field.color }} />)}
      {readout}
    </>}
    </div></div>}
    <div className="flex justify-between gap-2 text-[11px] tabular-nums text-muted-foreground"><time>{dateLabel(new Date(start).toISOString())}</time><time>{dateLabel(new Date(end).toISOString())}</time></div>
    {!!points.length && <div className="space-y-2">
      <input type="range" min={0} max={points.length - 1} step={1} value={selectedIndex} aria-label={`${title}采样时间`} aria-valuetext={selected ? `${sampleTime(selected.observedAt)} UTC+8，${fields.map(field => `${field.label} ${reading(selected, field)}`).join("，")}` : undefined}
        aria-describedby={anchor && selected ? tooltipID : undefined} className="h-8 w-full accent-primary"
        onFocus={() => reveal(selectedIndex)} onChange={event => reveal(Number(event.target.value))} />
    </div>}
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{fields.map(f => <span className="inline-flex items-center gap-1.5" key={f.key}><span className="size-2 rounded-full" style={{ background: f.color }} />{f.label}</span>)}</div>
  </div>;
}
export function ResourceHistory({ nodeId }: { nodeId: string }) {
  const [window, setWindow] = useState("24h");
  const [tableOpen, setTableOpen] = useState(false);
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
      <div className="space-y-1"><CardTitle>趋势</CardTitle><CardDescription><Metadata><MetadataItem>最近 {windowLabel}</MetadataItem><MetadataItem>{window === "7d" ? "每小时" : "每 5 分钟"}保留一次实际采样</MetadataItem></Metadata></CardDescription></div>
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
          <Series key={`${nodeId}:${window}:traffic`} title="计费网卡流量" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} format={formatRate} fields={[{ key: "receiveBytesPerSecond", label: "接收", color: "var(--color-sky-400)" }, { key: "transmitBytesPerSecond", label: "发送", color: "var(--color-red-500)" }]} />
          <Series key={`${nodeId}:${window}:resources`} title="CPU 与内存" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} maximum={100} format={n => `${n.toFixed(0)}%`} fields={[{ key: "cpuPercent", label: "CPU", color: "var(--color-sky-400)" }, { key: "memoryUsedPercent", label: "内存使用率", color: "var(--color-red-500)" }]} />
        </div>
        <Collapsible open={tableOpen} onOpenChange={setTableOpen} className="min-w-0 space-y-2">
          <CollapsibleTrigger asChild><Button variant="outline" size="sm">{tableOpen ? "收起" : "查看"}采样数据（{points.length} 条）</Button></CollapsibleTrigger>
          <CollapsibleContent>
            <div className="max-h-80 overflow-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_[data-slot=table-container]]:overflow-visible" tabIndex={0} role="region" aria-label="资源采样明细，可滚动" >
              <Table aria-label="资源采样数据" className="tabular-nums">
                <TableHeader><TableRow>
                  <TableHead scope="col">采样时间（UTC+8）</TableHead>
                  <TableHead scope="col" className="text-right">CPU</TableHead><TableHead scope="col" className="text-right">内存使用率</TableHead>
                  <TableHead scope="col" className="text-right">接收（B/s）</TableHead><TableHead scope="col" className="text-right">发送（B/s）</TableHead>
                </TableRow></TableHeader>
                <TableBody>{points.map((point, index) => <TableRow key={`${point.observedAt}-${index}`}>
                  <TableCell><time dateTime={point.observedAt}>{dateLabel(point.observedAt)}</time></TableCell>
                  {(["cpuPercent", "memoryUsedPercent", "receiveBytesPerSecond", "transmitBytesPerSecond"] as const).map(field => <TableCell key={field} className="text-right">{valid(point[field]) ? `${point[field]!.toLocaleString(undefined, { maximumFractionDigits: 3 })}${field.endsWith("Percent") ? "%" : " B/s"}` : "无数据"}</TableCell>)}
                </TableRow>)}</TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
        <p className="text-xs text-muted-foreground">实际快照，不代表均值或峰值；历史不能回填。缺失采样与重启处断开显示；网卡速率仅包含所选计费网卡，不等于供应商账单。</p>
      </>}
    </CardContent>
  </Card>;
}
