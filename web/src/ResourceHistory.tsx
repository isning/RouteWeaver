import { useEffect, useId, useRef, useState } from "react";
import { ChartTooltip } from "./ChartTooltip";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { ScrollableTabsList } from "@/ui-patterns/scrollable-tabs-list";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { Section } from "./components";
import { ActionButton } from "@/ui-patterns/actions";
import { request } from "./api";
import { bytesLabel, dateLabel } from "./model";
import { observationPath, type NodeSnapshot } from "./observability-model";

export interface ResourcePoint {
  observedAt: string;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  interfaceRates?: Record<string, Pick<ResourcePoint, "receiveBytesPerSecond" | "transmitBytesPerSecond">>;
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
  points: ResourcePoint[]; fields: readonly { key: "cpuPercent" | "memoryUsedPercent" | "memoryUsedBytes" | "memoryTotalBytes" | "receiveBytesPerSecond" | "transmitBytesPerSecond"; label: string; color: string }[];
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
  // Expire the tooltip when its sample leaves the window.
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
    if (field.key.endsWith("Percent")) return `${precise}%`;
    return `${format(value!)} (${precise} ${field.key.endsWith("Bytes") ? "B" : "B/s"})`;
  };
  const readout = anchor && selected && (<ChartTooltip id={tooltipID} anchor={anchor}>
        <time className="block font-medium" dateTime={selected.observedAt}>{sampleTime(selected.observedAt)} UTC+8</time>
        <dl className="mt-2 grid gap-1.5">{fields.map(field => <div key={field.key} className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
          <dt className="inline-flex items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: field.color }} />{field.label}</dt>
          <dd className="ml-auto font-medium tabular-nums">{reading(selected, field)}</dd>
        </div>)}</dl>
      </ChartTooltip>);
  const plotFocus = {
    tabIndex: points.length ? 0 : undefined,
    role: "group",
    "aria-label": `${title}采样`,
    "aria-describedby": anchor && selected ? tooltipID : undefined,
    onFocus: () => reveal(selectedIndex),
    onKeyDown: (event: React.KeyboardEvent) => {
      const index = event.key === "Home" ? 0
        : event.key === "End" ? points.length - 1
        : event.key === "ArrowLeft" ? selectedIndex - 1
        : event.key === "ArrowRight" ? selectedIndex + 1 : null;
      if (index == null) return;
      event.preventDefault();
      reveal(Math.max(0, Math.min(points.length - 1, index)));
    },
  };
  return <div ref={root} className="min-w-0 space-y-3"
    onPointerLeave={event => { if (interaction.current === "pointer" && event.pointerType !== "touch") setAnchor(undefined); }}
    onKeyDown={event => { if (event.key === "Escape") setAnchor(undefined); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setAnchor(undefined); }}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p className="font-medium">{title}</p></div>
    {!all.length ? <div ref={plot} {...plotFocus} className="relative rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring flex h-40 items-center justify-center border border-dashed text-sm text-muted-foreground">尚无可绘制的数据{readout}</div> : <div className="grid h-40 min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-2">
      <div aria-hidden="true" className="relative text-right text-[11px] leading-none tabular-nums text-muted-foreground">{[max, max / 2, 0].map((value, index) => <span key={index} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${y(value) / 155 * 100}%` }}>{format(value)}</span>)}</div>
      <div ref={plot} {...plotFocus} className="relative rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-w-0">
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
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{fields.map(f => <span className="inline-flex items-center gap-1.5" key={f.key}><span className="size-2 rounded-full" style={{ background: f.color }} />{f.label}</span>)}</div>
  </div>;
}
const hour = 3600000;
const ranges = [
  { value: "1h", label: "1 小时", hours: 1 },
  { value: "5h", label: "5 小时", hours: 5 },
  { value: "12h", label: "12 小时", hours: 12 },
  { value: "24h", label: "24 小时", hours: 24 },
  { value: "7d", label: "7 天", hours: 168 },
] as const;

export function ResourceHistory({ nodeId, latest }: { nodeId: string; latest?: NodeSnapshot | null }) {
  const [range, setRange] = useState("auto");
  const [tableOpen, setTableOpen] = useState(false);
  const window = range === "7d" ? "7d" : "24h";
  const query = useQuery({ queryKey: ["node-resource-history", nodeId, window], queryFn: ({ signal }) => request<ResourceHistoryView>(`${observationPath(nodeId)}/history?window=${window}`, { signal }), refetchInterval: 30000 });
  const data = query.data?.nodeId === nodeId && Array.isArray(query.data.points) && query.data.points.length <= 288 ? query.data : undefined;
  const sourceStart = Date.parse(data?.windowStart || ""), sourceEnd = Date.parse(data?.windowEnd || "");
  const validWindow = Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart && data?.intervalSeconds === (window === "7d" ? 3600 : 300);
  const end = validWindow ? Math.max(sourceEnd, query.dataUpdatedAt, Date.parse(latest?.observedAt || "") || 0) : NaN;
  const samples = validWindow ? data!.points.filter(p => Date.parse(p.observedAt) >= sourceStart && Date.parse(p.observedAt) <= sourceEnd) : [];
  if (validWindow && latest && Date.parse(latest.observedAt) > (samples.length ? Date.parse(samples.at(-1)!.observedAt) : sourceStart)) {
    const { memoryTotalBytes, memoryAvailableBytes } = latest.metrics;
    const memoryUsedBytes = memoryTotalBytes - memoryAvailableBytes;
    samples.push({
      observedAt: latest.observedAt,
      cpuPercent: latest.cpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryUsedPercent: 100 * memoryUsedBytes / memoryTotalBytes,
      receiveBytesPerSecond: latest.receiveBytesPerSecond,
      transmitBytesPerSecond: latest.transmitBytesPerSecond,
      interfaceRates: latest.interfaceRates,
      breakBefore: latest.continuity !== "continuous" && latest.continuity !== "interface_gap",
    });
  }
  const span = samples.length ? end - Date.parse(samples[0].observedAt) : 0;
  const automatic = ranges.slice(0, 4).find(item => span <= item.hours * hour) ?? ranges[3];
  const selectedRange = ranges.find(item => item.value === range) ?? automatic;
  const start = end - selectedRange.hours * hour;
  const windowLabel = selectedRange.label.replace(" ", "");
  const points = samples.filter(point => Date.parse(point.observedAt) >= start);
  const interfaces = [...new Set(points.flatMap(point => Object.keys(point.interfaceRates ?? {})))].sort();
  const hasMemoryBytes = points.some(point => valid(point.memoryTotalBytes) && point.memoryTotalBytes! > 0);
  const trafficFields = [
    { key: "receiveBytesPerSecond", label: "接收", color: "var(--color-sky-500)" },
    { key: "transmitBytesPerSecond", label: "发送", color: "var(--color-emerald-500)" },
  ] as const;
  const last = points.at(-1);
  const stale = last && Date.now() - Date.parse(last.observedAt) > Math.max(15 * 60000, (data?.intervalSeconds || 300) * 1500);
  return <section aria-label="资源趋势" className="min-w-0">
    <Section title="趋势"
      extra={<ActionButton variant="ghost" size="sm" aria-label="刷新资源趋势" leadingIcon={<RotateCw aria-hidden="true" />} pending={query.isFetching} onClick={() => query.refetch()} />}>
      <Tabs value={range} onValueChange={setRange} className="min-w-0 gap-3">
        <ScrollableTabsList aria-label="趋势时间范围">
          <TabsTrigger value="auto">自动（{automatic.label}）</TabsTrigger>
          {ranges.map(({ value, label }) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
        </ScrollableTabsList>
        <TabsContent value={range} className="min-w-0 space-y-4">
      {query.isError && <p role="status" className="text-sm text-muted-foreground">{data ? "趋势刷新失败，保留上次读取的数据。" : "无法读取趋势，请重试。"}</p>}
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">{query.isPaused ? "等待网络连接" : "正在读取趋势…"}</p>}
      {!query.isPending && !query.isError && (!data || !validWindow) && <p role="status" className="text-sm text-muted-foreground">趋势数据尚未确定，请重试。</p>}
      {data && !data.available && <p role="status" className="text-sm text-muted-foreground">历史存储容量已满，当前资源数据仍可查看。</p>}
      {data?.available && validWindow && !points.length && <p role="status" className="text-sm text-muted-foreground">最近 {windowLabel}没有历史数据。收到新的资源上报后开始记录。</p>}
      {data && validWindow && !!points.length && <>
        {stale && <p role="status" className="text-xs text-muted-foreground">最后采样 {dateLabel(last!.observedAt)}，较早的数据不代表当前状态。</p>}
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <Series key={`${nodeId}:${range}:resources`} title="CPU 与内存" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} maximum={100} format={n => `${n.toFixed(0)}%`} fields={[{ key: "cpuPercent", label: "CPU", color: "var(--color-sky-400)" }, { key: "memoryUsedPercent", label: "内存使用率", color: "var(--color-red-500)" }]} />
          {hasMemoryBytes && <Series key={`${nodeId}:${range}:memory`} title="内存用量" points={points} start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} format={n => bytesLabel(Math.round(n))}
            fields={[{ key: "memoryUsedBytes", label: "已用", color: "var(--color-sky-500)" }, { key: "memoryTotalBytes", label: "总量", color: "var(--color-muted-foreground)" }]} />}
        </div>
        <section aria-label="网卡流量" className="space-y-4 border-t pt-4">
          <h3 className="text-sm font-semibold">网卡流量</h3>
          {interfaces.length ? <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {interfaces.map(name => <div key={name} className="min-w-0 rounded-lg border p-3">
              <Series key={`${nodeId}:${range}:${name}`} title={name}
                points={points.map(point => {
                  const rates = Object.hasOwn(point.interfaceRates ?? {}, name) ? point.interfaceRates?.[name] : undefined;
                  return { ...point, receiveBytesPerSecond: rates?.receiveBytesPerSecond ?? null, transmitBytesPerSecond: rates?.transmitBytesPerSecond ?? null };
                })}
                start={start} end={end} interval={data.intervalSeconds} windowLabel={windowLabel} format={formatRate} fields={trafficFields} />
            </div>)}
          </div> : <p className="text-sm text-muted-foreground">收到新的网卡采样后，将按接口显示接收与发送速率</p>}
        </section>
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
                  {(["cpuPercent", "memoryUsedPercent", "memoryUsedBytes", "memoryTotalBytes"] as const).map(field => <TableCell key={field} className="text-right">{valid(point[field]) ? (field.endsWith("Percent") ? `${point[field]!.toFixed(1)}%` : bytesLabel(point[field]!)) : "无数据"}</TableCell>)}
                </TableRow>)}</TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
        <p className="text-xs text-muted-foreground">缺失采样和计数器重置处断开显示</p>
      </>}
        </TabsContent>
      </Tabs>
    </Section>
  </section>;
}
