import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, post, put, request } from "./api";
import { ErrorNotice, QueryState, Section } from "./components";
import { TaskDialog } from "./ui-patterns/task-overlays";
import { ActionButton } from "./ui-patterns/actions";
import { ChoiceSelect } from "./ui-patterns/choice-select";
import { NumericInput } from "./ui-patterns/numeric-input";
import { Input } from "./components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Badge } from "./components/ui/badge";
import { Switch } from "./components/ui/switch";
import { Label } from "./components/ui/label";
import { Notice } from "./ui-patterns/notice";
import { DataTable } from "./DataTable";
import { dateLabel } from "./model";
import { ChartTooltip } from "./ChartTooltip";
import { randomUUID } from "./random-id";
import { useUnsavedChanges } from "./navigation";
import type { HostRecord } from "./types";

const carriers = [
  {
    id: "telecom",
    name: "中国电信",
    color: "var(--color-sky-600)",
  },
  {
    id: "unicom",
    name: "中国联通",
    color: "var(--color-violet-500)",
  },
  {
    id: "mobile",
    name: "中国移动",
    color: "var(--color-amber-600)",
  },
];
const probeCities: Record<string, string> = {
  Beijing: "北京", Shanghai: "上海", Guangzhou: "广州", Shenzhen: "深圳",
  Hangzhou: "杭州", Nanjing: "南京", Wuhan: "武汉", Chengdu: "成都",
  Changsha: "长沙", Zhengzhou: "郑州", Fuzhou: "福州", "Xi'an": "西安",
};
const carrierLabels = (cities: Monitor["probeCities"]) => carriers.map(carrier => {
  const city = probeCities[cities?.[carrier.id] ?? ""];
  return { ...carrier, name: city ? city + carrier.name.replace(/^中国/, "") : carrier.name };
});
type Probe = { id: string; name: string; country: string; city: string; asn: number };
const probeColors = ["#0284c7", "#7c3aed", "#d97706", "#059669", "#e11d48", "#0891b2", "#4f46e5", "#65a30d"];
const probeLabels = (state: Monitor) => state.probes
  ? state.probes.map((probe, index) => ({
      id: probe.id,
      name: probe.name,
      color: probeColors[index],
    }))
  : state.revision ? carrierLabels(state.probeCities) : [];

type Observation = {
  carrier: string;
  status: "up" | "down" | "unknown";
  latencyMs?: number;
  loss?: number;
  city?: string;
  network?: string;
  asn?: number;
  code?: string;
};
type Round = {
  at: string;
  target: string;
  port: number;
  protocol: string;
  results: Observation[];
};
type Monitor = {
  hostId: string;
  monitorIp?: string;
  probeCities?: Record<string, string>;
  probes?: Probe[];
  revision: number;
  enabled: boolean;
  notify: boolean;
  intervalMinutes: number;
  protocol: string;
  port: number;
  target: string;
  currentTarget: string;
  requiresReview: boolean;
  queued: boolean;
  startedAt?: string;
  nextCheckAt?: string;
  errorCode?: string;
  incidents?: Record<string, boolean>;
  history: Round[];
};
type Settings = Pick<
  Monitor,
  "enabled" | "notify" | "intervalMinutes" | "protocol" | "port"
> & { monitorIp: string; probes?: Probe[] };
const selection = (s: Monitor): Settings => ({
  enabled: s.enabled,
  notify: s.notify,
  intervalMinutes: s.intervalMinutes,
  protocol: s.protocol,
  port: s.port,
  monitorIp: s.monitorIp ?? "",
  probes: s.probes ?? (s.revision ? undefined : []),
});
const equal = (a: Settings, b: Settings) =>
  JSON.stringify(a) === JSON.stringify(b);
const codes: Record<string, string> = {
  "no-probe": "暂无匹配的探针",
  "provider-rejected": "探针服务未接受本次检测",
  "budget-exhausted": "本小时的共享检测预算已用完",
  "rate-limited": "检测额度受限，稍后重试",
  "provider-unavailable": "探针服务暂不可用",
  "provider-timeout": "未能取得完整结果",
  "invalid-response": "探针返回的结果不完整",
  "pinned-probe-unavailable": "固定探针暂不可用",
  "probe-mismatch": "探针归属不符，本次结果未采用",
  "invalid-target": "目标地址无法解析或不是公网地址",
  interrupted: "上次检测中断",
  "target-changed": "服务器地址已变更，请重新保存设置",
};
function status(o?: Observation) {
  return o?.status === "up"
    ? "可达"
    : o?.status === "down"
      ? "未连通"
      : "无结果";
}
function monitorError(error: unknown): Error {
  if (error instanceof APIError) {
    if (error.status === 409)
      return new Error("监控设置或任务已变化，请刷新后重试，当前输入已保留");
    if (error.status === 429) return new Error("检查过于频繁，请稍后再试");
    if (error.status === 404)
      return new Error("无法读取服务器的监控设置，请刷新服务器清单后重试");
    if (error.status === 400)
      return new Error("请检查监控设置，公共探针需要可访问的公网服务器地址");
  }
  return error instanceof Error ? error : new Error("监控操作未完成，请重试");
}
function checked(value: Monitor, hostId: string): Monitor {
  if (value?.probes !== undefined && (!Array.isArray(value.probes) || value.probes.length < 1 || value.probes.length > 8 ||
    value.probes.some((probe) => !probe || typeof probe.id !== "string" || typeof probe.name !== "string"))) {
    throw new Error("未能读取固定探针设置");
  }
  const ids = new Set((value?.probes ?? carriers).map((probe) => probe.id));
  const observationValid = (o: Observation) =>
    !!o &&
    ids.has(o.carrier) &&
    ["up", "down", "unknown"].includes(o.status) &&
    (o.status !== "up" ||
      (typeof o.latencyMs === "number" &&
        Number.isFinite(o.latencyMs) &&
        o.latencyMs >= 0)) &&
    (o.status === "up" || o.latencyMs === undefined) &&
    (o.loss === undefined ||
      (Number.isFinite(o.loss) && o.loss >= 0 && o.loss <= 100));
  const historyValid =
    Array.isArray(value?.history) &&
    value.history.every(
      (r) =>
        r &&
        Number.isFinite(Date.parse(r.at)) &&
        typeof r.target === "string" &&
        ["tcp", "icmp"].includes(r.protocol) &&
        Number.isInteger(r.port) &&
        r.port > 0 &&
        r.port <= 65535 &&
        Array.isArray(r.results) &&
        r.results.length <= 8 &&
        new Set(r.results.map((o) => o?.carrier)).size === r.results.length &&
        r.results.every(observationValid),
    );

  if (
    !historyValid ||
    typeof value?.notify !== "boolean" ||
    typeof value?.currentTarget !== "string" ||
    !value ||
    value.hostId !== hostId ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.history) ||
    value.history.length > 288 ||
    !["tcp", "icmp"].includes(value.protocol) ||
    ![1, 5, 10, 15, 30, 60].includes(value.intervalMinutes) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    throw new Error("未能读取完整的连通性监控设置");
  return value;
}
export function NetworkMonitor({ host }: { host: HostRecord }) {
  const key = ["network-monitor", host.id];
  const path = `/admin/hosts/${encodeURIComponent(host.id)}/network-monitor`;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return checked(await request<Monitor>(path), host.id);
      } catch (cause) {
        throw monitorError(cause);
      }
    },
    refetchInterval: (query) =>
      query.state.data?.queued || query.state.data?.startedAt ? 2500 : 30000,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="space-y-6">
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        error={query.data ? null : query.error}
        retry={() => query.refetch()}
        loadingLayout="settings"
      >
        {query.data && (
          <MonitorTask
            key={host.id}
            host={host}
            state={query.data}
            path={path}
            readError={query.error}
            refresh={() => query.refetch()}
            readAt={query.dataUpdatedAt}
          />
        )}
      </QueryState>
    </div>
  );
}
function LatencyComparison({ rounds, labels: carriers }: { rounds: Round[]; labels: ReturnType<typeof probeLabels> }) {
  const tooltipId = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [selectedAt, setSelectedAt] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const index = Math.max(
    0,
    selectedAt
      ? rounds.findIndex((r) => r.at === selectedAt)
      : rounds.length - 1,
  );
  const selected = rounds[index];
  const values = rounds.flatMap((r) =>
    r.results
      .filter((o) => o.status === "up" && o.latencyMs !== undefined)
      .map((o) => o.latencyMs!),
  );
  const max = Math.max(20, Math.ceil(Math.max(0, ...values) / 20) * 20);
  const start = Date.parse(rounds[0]?.at || ""),
    end = Date.parse(rounds.at(-1)?.at || "");
  const x = (at: string) =>
    6 + (end > start ? (Date.parse(at) - start) / (end - start) : 0.5) * 488;
  const y = (v: number) => 150 - (v / max) * 138;
  const reading = (round: Round | undefined, carrier: string) => {
    const o = round?.results.find((o) => o.carrier === carrier);
    return o?.status === "up" && o.latencyMs !== undefined
      ? `${o.latencyMs.toFixed(1)} ms`
      : status(o);
  };
  const reveal = (i: number) => {
    const r = rounds[i];
    if (!r) return;
    setSelectedAt(r.at);
    const box = plot.current?.getBoundingClientRect();
    if (box) setAnchor({ x: (x(r.at) / 500) * box.width, y: 44 });
  };
  const pointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!rounds.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const at =
      start +
      Math.max(
        0,
        Math.min(1, (((event.clientX - box.left) / box.width) * 500 - 6) / 488),
      ) *
        (end - start);
    let nearest = 0;
    rounds.forEach((r, i) => {
      if (
        Math.abs(Date.parse(r.at) - at) <
        Math.abs(Date.parse(rounds[nearest].at) - at)
      )
        nearest = i;
    });
    reveal(nearest);
  };
  return (
    <section aria-label="延迟对比" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">延迟对比</h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {carriers.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5">
              <span
                className="h-0.5 w-3 rounded"
                style={{ backgroundColor: c.color }}
              />
              {c.name}
            </span>
          ))}
        </div>
      </div>
      {rounds.length < 2 || values.length === 0 ? (
        <p className="flex min-h-32 items-center justify-center rounded-lg bg-muted/20 text-sm text-muted-foreground">
          {rounds.length < 2 ? "暂无延迟趋势" : "暂无有效延迟数据"}
        </p>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] gap-2">
            <div className="relative h-44 text-right text-xs text-muted-foreground">
              {[max, max / 2, 0].map((v) => (
                <span
                  key={v}
                  className="absolute right-0 -translate-y-1/2 tabular-nums"
                  style={{ top: `${(y(v) / 164) * 100}%` }}
                >
                  {v}
                </span>
              ))}
              <span className="absolute -top-3 right-0 text-[10px]">ms</span>
            </div>
            <div
              ref={plot}
              className="relative min-w-0"
              onPointerLeave={() => setAnchor(null)}
            >
              <svg
                role="img"
                aria-label="各探针延迟对比，缺失数据不连接"
                viewBox="0 0 500 164"
                preserveAspectRatio="none"
                className="h-44 w-full rounded-md focus-visible:outline-2 focus-visible:outline-ring"
                tabIndex={0}
                aria-describedby={anchor ? tooltipId : undefined}
                onFocus={() => reveal(index)}
                onBlur={() => setAnchor(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setAnchor(null);
                    return;
                  }
                  const next = event.key === "ArrowLeft" ? index - 1
                    : event.key === "ArrowRight" ? index + 1
                    : event.key === "Home" ? 0
                    : event.key === "End" ? rounds.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  reveal(Math.max(0, Math.min(rounds.length - 1, next)));
                }}
                onPointerMove={pointer}
                onPointerDown={pointer}
              >
                {[max, max / 2, 0].map((v) => (
                  <line
                    key={v}
                    x1="6"
                    x2="494"
                    y1={y(v)}
                    y2={y(v)}
                    className="stroke-border"
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {carriers.map((c, ci) => {
                  let connected = false;
                  const d = rounds
                    .map((r) => {
                      const o = r.results.find((o) => o.carrier === c.id);
                      if (o?.status !== "up" || o.latencyMs === undefined) {
                        connected = false;
                        return "";
                      }
                      const command = connected ? "L" : "M";
                      connected = true;
                      return `${command}${x(r.at).toFixed(1)},${y(o.latencyMs).toFixed(1)}`;
                    })
                    .join(" ")
                    .trim();
                  return (
                    <g key={c.id} data-series={c.id} style={{color: c.color}}>
                      <path
                        d={d}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeDasharray={
                          ci === 1 ? "6 3" : ci === 2 ? "2 3" : undefined
                        }
                        vectorEffect="non-scaling-stroke"
                      />
                      {rounds.map((r, i) => {
                        const o = r.results.find((o) => o.carrier === c.id);
                        return o?.status === "up" &&
                          o.latencyMs !== undefined ? (
                          <circle
                            key={i}
                            cx={x(r.at)}
                            cy={y(o.latencyMs)}
                            r="2"
                            fill="currentColor"
                          />
                        ) : null;
                      })}
                    </g>
                  );
                })}
                {selected && anchor && (
                  <line
                    x1={x(selected.at)}
                    x2={x(selected.at)}
                    y1="8"
                    y2="150"
                    className="stroke-foreground"
                    strokeDasharray="2 3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{dateLabel(rounds[0].at).slice(-5)}</span>
                <span>{dateLabel(rounds.at(-1)!.at).slice(-5)}</span>
              </div>
              {selected && anchor && (
                <ChartTooltip id={tooltipId} anchor={anchor}>
                  <p className="mb-2 font-medium">{dateLabel(selected.at)}</p>
                  <dl className="space-y-1">
                    {carriers.map((c) => (
                      <div key={c.id} className="flex justify-between gap-5">
                        <dt>{c.name}</dt>
                        <dd className="tabular-nums">
                          {reading(selected, c.id)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </ChartTooltip>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function MonitorTask({
  host,
  state,
  path,
  readError,
  refresh,
  readAt,
}: {
  host: HostRecord;
  state: Monitor;
  path: string;
  readError: Error | null;
  refresh: () => unknown;
  readAt: number;
}) {
  const client = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings>(() => selection(state));
  const current = useRef(draft);
  current.current = draft;
  const baseline = useRef(selection(state));
  const [error, setError] = useState<Error | null>(null);
  const [receiptUncertain, setReceiptUncertain] = useState(false);
  useEffect(() => setReceiptUncertain(false), [readAt]);
  const [feedback, setFeedback] = useState("");
  const [page, setPage] = useState(1);
  const [portText, setPortText] = useState(String(state.port));
  const dirty =
    !equal(draft, selection(state)) || portText !== String(state.port);
  useEffect(() => {
    if (
      equal(current.current, baseline.current) &&
      portText === String(baseline.current.port)
    ) {
      setDraft(selection(state));
      setPortText(String(state.port));
    }
    baseline.current = selection(state);
  }, [state.revision]);
  const sending = useRef(false);
  const key = ["network-monitor", host.id];
  const accept = async (next: Monitor) => {
    await client.cancelQueries({ queryKey: key, exact: true });
    client.setQueryData(key, next);
  };
  const commit = useMutation({
    mutationFn: async (kind: "save" | "check") => {
      const submitted = {
        ...draft,
        probes: draft.probes?.map((probe) => ({ ...probe, name: probe.name.trim(), city: probe.city.trim() })),
        monitorIp: draft.monitorIp.trim(),
        port: draft.protocol === "icmp" ? draft.port : Number(portText),
      };
      if (
        !Number.isInteger(submitted.port) ||
        submitted.port < 1 ||
        submitted.port > 65535
      )
        throw new Error("请输入 1–65535 的端口号");
      if (kind === "save" && submitted.probes?.length === 0) throw new Error("请至少添加一个探针");
      try {
        const next = checked(
          kind === "save"
            ? await put<Monitor>(path, {
                ...submitted,
                expectedRevision: state.revision,
              })
            : await post<Monitor>(path + "/check", {
                expectedRevision: state.revision,
              }),
          host.id,
        );
        if (
          next.revision <= state.revision ||
          (kind === "save" && !equal(selection(next), submitted))
        )
          throw new Error("未能确认监控操作结果");
        return { next, submitted, kind };
      } catch (cause) {
        if (!(
          cause instanceof APIError &&
          [400, 401, 403, 404, 409, 413, 429].includes(cause.status)
        ))
          setReceiptUncertain(true);
        void refresh();
        throw monitorError(cause);
      }
    },
    onSuccess: async ({ next, submitted, kind }) => {
      await accept(next);
      if (kind === "save" && equal({ ...current.current, probes: current.current.probes?.map((probe) => ({ ...probe, name: probe.name.trim(), city: probe.city.trim() })), monitorIp: current.current.monitorIp.trim(), port: submitted.port }, submitted)) {
        setDraft(selection(next));
        setPortText(String(next.port));
        setSettingsOpen(false);
      }
      setFeedback(kind === "save" ? "监控设置已保存" : "已提交检查");
      setError(null);
    },
    onError: (cause) => setError(monitorError(cause)),
  });
  const pending = !!state.queued || !!state.startedAt;
  const busy = commit.isPending;
  useUnsavedChanges(dirty || busy || receiptUncertain);
  const run = async (kind: "save" | "check") => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    setFeedback("");
    try {
      await commit.mutateAsync(kind);
    } catch {
      /* Mutation retains the actionable error. */
    } finally {
      sending.current = false;
    }
  };
  const change = (next: Partial<Settings>) => {
    if (next.protocol === "icmp") {
      setPortText(String(state.port));
      next = { ...next, port: state.port };
    }
    setDraft((value) => ({ ...value, ...next }));
    setFeedback("");
  };
  const labels = probeLabels(state);
  const probeDraft = draft.probes ?? [];
  const latest = state.history.at(-1);
  const stale =
    latest &&
    Date.now() - Date.parse(latest.at) > state.intervalMinutes * 120000;
  const rows = state.history
    .slice()
    .reverse()
    .flatMap((round, index) =>
      round.results.map((o) => ({
        ...o,
        id: `${round.at}-${index}-${o.carrier}`,
        at: round.at,
        target: round.target,
        protocol: round.protocol,
        port: round.port,
      })),
    );
  return (
    <div className="space-y-6">
      <section aria-label="连通性检测结果">
        <Section
          title="连通性监控"

          extra={
            <div className="flex flex-wrap gap-2">
              <ActionButton
                variant={state.revision === 0 ? "default" : "outline"}
                onClick={() => setSettingsOpen(true)}
              >
                设置监控
              </ActionButton>
              {state.revision > 0 && (
              <ActionButton
                variant="outline"
                pending={busy && commit.variables === "check"}
                disabled={
                  busy ||
                  pending ||
                  dirty ||
                  receiptUncertain ||
                  !!readError ||
                  state.revision === 0 ||
                  state.requiresReview
                }
                onClick={() => void run("check")}
              >
                {pending ? "检测中" : "立即检查"}
              </ActionButton>
              )}
            </div>
          }
        >
          {feedback && <p role="status" className="text-sm text-muted-foreground">{feedback}</p>}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="break-all">
              {state.currentTarget || host.address}
              {state.protocol === "tcp" ? `:${state.port}（TCP）` : "（ICMP）"}
            </span>
            <span>
              {latest ? `最近检查 ${dateLabel(latest.at)}` : "尚未检查"}
            </span>
            {state.enabled && state.nextCheckAt && (
              <span>下次检查 {dateLabel(state.nextCheckAt)}</span>
            )}
            {pending && <Badge variant="secondary">检测中</Badge>}
            {stale && <Badge variant="outline">历史结果已过期</Badge>}
          </div>
          {state.requiresReview && (
            <Notice tone="warning">
              服务器地址已变更，保存设置后才能检测新地址，原有记录对应旧地址
            </Notice>
          )}
          {state.errorCode && (
            <Notice tone="warning">
              {codes[state.errorCode] || "上次检测未完成"}
            </Notice>
          )}
          <div
            className="space-y-1 rounded-xl bg-muted/20 p-2 sm:p-4"
            role="group"
            aria-label="探针连通状态"
          >
            {labels.map((carrier) => {
              const result = latest?.results.find(
                (o) => o.carrier === carrier.id,
              );
              const recent = state.history.slice(-48);
              const valid = recent.flatMap((r) =>
                r.results.filter(
                  (o) =>
                    o.carrier === carrier.id &&
                    (o.status === "up" || o.status === "down"),
                ),
              );
              const uptime = valid.length
                ? `${((valid.filter((o) => o.status === "up").length / valid.length) * 100).toFixed(1)}%`
                : "—";
              return (
                <div
                  key={carrier.id}
                  className="grid min-w-0 grid-cols-[minmax(0,5rem)_minmax(0,1fr)_auto] items-center gap-x-2 sm:grid-cols-[9rem_minmax(0,1fr)_14rem] sm:gap-x-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <h3 className="flex items-center gap-2 break-all text-sm font-medium">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: carrier.color }}
                      />
                      {carrier.name}
                    </h3>
                    {result?.city && <span className="sr-only">{result.city}</span>}
                  </div>
                  <div className="col-start-3 row-start-1 flex min-w-0 flex-col items-end gap-x-3 leading-tight sm:flex-row sm:items-center sm:justify-end">
                    <Badge
                      title={state.incidents?.[carrier.id] ? "连续检测失败，等待恢复" : result?.city}
                      variant={
                        result?.status === "down" ? "destructive" : "secondary"
                      }
                    >
                      {stale ? "结果已过期" : status(result)}
                    </Badge>
                    <strong className="text-sm font-semibold tabular-nums">
                      {result?.latencyMs === undefined
                        ? "—"
                        : `${result.latencyMs.toFixed(0)} ms`}
                    </strong>
                    <span
                      className="text-xs text-muted-foreground tabular-nums"
                      aria-label={`${carrier.name}观测可用率 ${uptime}`}
                    >
                      可用率 {uptime}
                    </span>
                  </div>
                  <div
                    className="col-start-2 row-start-1 flex h-7 min-w-0 gap-0.5"
                    role="group"
                    aria-label={`${carrier.name}最近 ${recent.length} 次检测`}
                  >
                    {recent.length ? recent.map((round, index) => {
                      const observation = round.results.find((item) => item.carrier === carrier.id);
                      const time = dateLabel(round.at);
                      const resultLabel = status(observation);
                      const reason = observation?.code && (codes[observation.code] || "未取得有效结果");
                      return (
                        <Tooltip key={`${round.at}-${index}`}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              tabIndex={index === recent.length - 1 ? 0 : -1}
                              aria-label={`${carrier.name} ${time} ${resultLabel}${reason ? `，${reason}` : ""}`}
                              className={`min-w-0 flex-1 rounded-[2px] hover:brightness-90 focus-visible:outline-2 focus-visible:outline-ring ${observation?.status === "up" ? "bg-emerald-500/80" : observation?.status === "down" ? "bg-destructive/80" : "bg-muted-foreground/25"}`}
                            />
                          </TooltipTrigger>
                          <TooltipContent sideOffset={4}>
                            <div className="space-y-1">
                              <p>{carrier.name}</p>
                              <p>{time}</p>
                              <p>{resultLabel}{observation?.latencyMs != null ? `，${observation.latencyMs.toFixed(0)} ms` : ""}</p>
                              {reason && <p>{reason}</p>}
                              {observation?.city && <p>{observation.city}</p>}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }) : <span className="flex-1 rounded-sm bg-muted-foreground/15" />}
                  </div>
                </div>
              );
            })}
          </div>
          {!state.probes && state.history.length > 0 && <p className="text-xs text-muted-foreground">历史检测可能来自不同探针。添加固定探针后可比较同一探针的延迟。</p>}
          <LatencyComparison rounds={state.history.slice(-48)} labels={labels} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            绿色为可达，红色为未连通，灰色为无结果；无结果不计入可用率。TCP
            检测不代表 UDP 代理协议可用
          </p>
        </Section>
      </section>
      <TaskDialog open={settingsOpen} onOpenChange={setSettingsOpen} title="监控设置" pending={busy}>
          <form
            aria-label="连通性监控设置"
            onSubmit={(event) => {
              event.preventDefault();
              void run("save");
            }}
          >
            <ErrorNotice
              error={readError || (!receiptUncertain ? error : null)}
            />
            {receiptUncertain && (
              <Notice tone="warning">
                正在核对操作结果，当前输入已保留
              </Notice>
            )}
            <div className="space-y-5">
              <Label className="flex items-center justify-between gap-4">
                定时监控
                <Switch
                  aria-label="定时监控"
                  checked={draft.enabled}
                  disabled={busy || pending}
                  onCheckedChange={(enabled) => change({ enabled })}
                />
              </Label>
              <label className="grid gap-2 text-sm font-medium">
                监控 IP
                <Input value={draft.monitorIp} disabled={busy || pending} placeholder="留空时使用服务器地址"
                  spellCheck={false} autoComplete="off" maxLength={64}
                  onChange={(event) => change({ monitorIp: event.target.value })} />
              </label>
              <fieldset className="min-w-0 space-y-3">
                <legend className="text-sm font-medium">固定探针</legend>
                {probeDraft.map((probe, index) => {
                  const patch = (values: Partial<Probe>) => change({
                    probes: probeDraft.map((item) => item.id === probe.id ? { ...item, ...values } : item),
                  });
                  return <div key={probe.id} className="space-y-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{probe.name || "新探针"}</span>
                      <div className="flex flex-wrap gap-2">
                      {state.probes?.some((item) => item.id === probe.id) && (
                        <ActionButton size="sm" variant="ghost" disabled={busy || pending}
                          onClick={() => patch({ id: randomUUID() })}>重新选取</ActionButton>
                      )}
                      <ActionButton size="sm" variant="ghost" disabled={busy || pending || probeDraft.length === 1}
                        onClick={() => change({ probes: probeDraft.filter((item) => item.id !== probe.id) })}>移除</ActionButton>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-1 text-sm">名称<Input aria-label={`探针 ${index + 1} 名称`} value={probe.name} maxLength={32} required disabled={busy || pending} placeholder="例如北京电信" onChange={(event) => patch({ name: event.target.value })} /></label>
                      <label className="grid gap-1 text-sm">国家代码<Input aria-label={`探针 ${index + 1} 国家代码`} value={probe.country} maxLength={2} pattern="[A-Z]{2}" required disabled={busy || pending} placeholder="CN" onChange={(event) => patch({ country: event.target.value.toUpperCase() })} /></label>
                      <label className="grid gap-1 text-sm">城市<Input aria-label={`探针 ${index + 1} 城市`} value={probe.city} maxLength={48} required disabled={busy || pending} placeholder="例如 Beijing" onChange={(event) => patch({ city: event.target.value })} /></label>
                      <label className="grid gap-1 text-sm">网络 ASN<Input aria-label={`探针 ${index + 1} 网络 ASN`} type="number" min={1} max={4294967295} value={probe.asn || ""} required disabled={busy || pending} placeholder="例如 4134" onChange={(event) => patch({ asn: Number(event.target.value) })} /></label>
                    </div>
                  </div>;
                })}
                <ActionButton variant="outline" size="sm" disabled={busy || pending || probeDraft.length >= 8} onClick={() => change({
                  probes: [...probeDraft, { id: randomUUID(), name: "", country: "CN", city: "", asn: 0 }],
                })}>添加探针</ActionButton>
                {draft.enabled && probeDraft.length * 60 / draft.intervalMinutes > 240 && (
                  <p className="text-xs text-muted-foreground">此频率会超过每小时 240 次的共享额度，部分检查将等待额度。</p>
                )}
                <p className="text-xs text-muted-foreground">首次检测按城市和 ASN 选择探针，后续复用同一探针。更换位置或重新选取探针会重置该探针的历史。</p>
              </fieldset>
              <div className="grid gap-5 sm:grid-cols-3">
                <label className="grid gap-2 text-sm font-medium">
                  检查频率
                  <ChoiceSelect
                    aria-label="检查频率"
                    disabled={busy || pending}
                    value={String(draft.intervalMinutes)}
                    onValueChange={(value) =>
                      value && change({ intervalMinutes: Number(value) })
                    }
                    options={[1, 5, 10, 15, 30, 60].map((value) => ({
                      value: String(value),
                      label: `每 ${value} 分钟`,
                    }))}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium">
                  检测方式
                  <ChoiceSelect
                    aria-label="检测方式"
                    disabled={busy || pending}
                    value={draft.protocol}
                    onValueChange={(protocol) =>
                      protocol && change({ protocol })
                    }
                    options={[
                      { value: "tcp", label: "TCP 端口" },
                      { value: "icmp", label: "ICMP Ping" },
                    ]}
                  />
                </label>
                {draft.protocol === "tcp" && (
                  <label className="grid gap-2 text-sm font-medium">
                    检测端口
                    <NumericInput
                      aria-label="检测端口"
                      disabled={busy || pending}
                      min={1}
                      max={65535}
                      value={draft.port}
                      onInputText={setPortText}
                      onValueChange={(port) => {
                        if (port !== null) change({ port });
                      }}
                    />
                  </label>
                )}
              </div>
              <Label className="flex items-center justify-between gap-4">
                站内告警
                <Switch
                  aria-label="站内告警"
                  checked={draft.notify}
                  disabled={busy || pending}
                  onCheckedChange={(notify) => change({ notify })}
                />
              </Label>
              <p className="text-sm text-muted-foreground">
                连续三次未连通后通知管理员，恢复后再次通知；同时遵循通知设置中的站内提醒开关
              </p>
              <p className="rounded-lg bg-muted/30 p-3 text-sm leading-relaxed text-muted-foreground">
                保存启用或点击检查后，监控地址和检测端口会提交给
                Globalping
                公共探针。免费检测额度由所有节点共享，额度不足时暂停检测
              </p>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  pending={busy && commit.variables === "save"}
                  type="submit"
                  disabled={
                    busy ||
                    pending ||
                    receiptUncertain ||
                    !!readError ||
                    (!dirty && state.revision > 0 && !state.requiresReview)
                  }
                >
                  保存监控设置
                </ActionButton>

              </div>
            </div>
          </form>
      </TaskDialog>
      <details className="min-w-0 space-y-4">
        <summary className="w-fit cursor-pointer rounded-md py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          检测记录
        </summary>
        <DataTable
          rowKey="id"
          rows={rows}
          page={page}
          onPageChange={setPage}
          pageSize={12}
          empty="暂无检测记录"
          minWidth={700}
          columns={[
            { title: "检测时间", render: (_, r) => dateLabel(r.at) },
            {
              title: "探针位置",
              render: (_, r) =>
                labels.find((c) => c.id === r.carrier)?.name || r.carrier,
            },
            {
              title: "状态",
              render: (_, r) =>
                r.status === "unknown"
                  ? codes[r.code || ""] || "无结果"
                  : status(r),
            },
            {
              title: "延迟",
              render: (_, r) =>
                r.latencyMs === undefined
                  ? "—"
                  : `${r.latencyMs.toFixed(1)} ms`,
            },
            {
              title: "探针",
              render: (_, r) => (r.city ? `${r.city} / AS${r.asn}` : "—"),
            },
            {
              title: "目标",
              render: (_, r) =>
                `${r.target}${r.protocol === "tcp" ? `:${r.port}` : ""} / ${r.protocol.toUpperCase()}`,
            },
          ]}
        />
      </details>
    </div>
  );
}
