import { ResourceHistory } from "./ResourceHistory";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, ChartNoAxesCombined, Cpu, MemoryStick, Info, RotateCw, Wallet } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { request } from "./api";
import { bytesLabel, dateLabel } from "./model";
import { phaseLabel } from "./infrastructure-model";
import { observationPath, observationStatus, sourceLabel, reasonLabel, type NodeObservationView } from "./observability-model";
import type { AgentState, HostRecord } from "./types";

const bytes = (value: number | null | undefined) => value == null ? "未确定"
  : Number.isSafeInteger(value) && value >= 0 ? bytesLabel(value) : "超出精确显示范围";
const rate = (value: number | null | undefined) => value == null ? "暂时无法计算"
  : Number.isFinite(value) && value >= 0 ? `${bytesLabel(Math.round(value))}/s` : "未确定";

/** Keep one contextual next action beside the explanation on wide screens,
 * and in reading order beneath it on narrow screens. */
export function ServerSetupTip({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
  return <Alert role="status" aria-label="服务器配置提示" className="flex items-start gap-3 p-4">
    <Info aria-hidden="true" className="size-4 shrink-0" />
    <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
      <div className="min-w-0 space-y-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{children}</AlertDescription>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>
    </div>
  </Alert>;
}

/** A recorded phase is not a heartbeat. Keep the server's current generation
 * authoritative, and do not reinterpret a prior nested failure as current. */
export function CoreStatusSummary({ instanceId }: { instanceId: string }) {
  const query = useQuery({
    queryKey: ["instance-state", instanceId],
    queryFn: () => request<AgentState>(`/agent/instances/${instanceId}/state`),
    refetchInterval: 30000,
  });
  const state = query.data?.instanceId === instanceId ? query.data : undefined;
  const phase = state?.phase;
  const label = phase ? phaseLabel(phase) : undefined;
  const currentLabel = label && label !== phase ? label : "状态待核对";
  const observed = state?.state?.observed;
  const needsReview = phase !== "pending-new-generation" && (
    ["validation_failed", "apply_failed", "blocked", "unknown"].includes(phase || "") || state?.state?.recoveryRequired
  );
  return <div className="min-w-0 space-y-1 text-sm" aria-label="核心状态摘要">
    <p className="text-xs text-muted-foreground">平台最近记录</p>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={needsReview ? "outline" : "secondary"}>{query.isPending ? "正在读取状态" : currentLabel}</Badge>
      {query.isError && <span className="text-muted-foreground">状态刷新失败</span>}
      {query.isPaused && <span className="text-muted-foreground">等待网络连接</span>}
    </div>
    {observed?.observedAt && <p className="text-xs text-muted-foreground">上次上报 {dateLabel(observed.observedAt)}</p>}
    {needsReview && <p className="text-xs text-muted-foreground">查看接入与配置，核对节点处理结果。</p>}
  </div>;
}

function Metric({ label, value, icon, children }: { label: string; value: ReactNode; icon: ReactNode; children?: ReactNode }) {
  return <div role="group" aria-label={label} className="min-w-0 space-y-2 rounded-lg border bg-background p-4 [overflow-wrap:anywhere]">
    <p className="flex items-center gap-2 text-sm text-muted-foreground"><span aria-hidden="true" className="[&>svg]:size-4">{icon}</span>{label}</p>
    <p className="break-words text-xl font-semibold tabular-nums tracking-tight">{value}</p>
    {children && <div className="space-y-1 text-xs text-muted-foreground">{children}</div>}
  </div>;
}

export function ServerResourceOverview({ host, onOpenResources }: { host: HostRecord; onOpenResources: () => void }) {
  const query = useQuery({
    queryKey: ["node-observation", host.id],
    queryFn: () => request<NodeObservationView>(observationPath(host.id)),
    refetchInterval: 30000,
  });
  const data = query.data?.nodeId === host.id && query.data.config ? query.data : undefined;
  const sample = data?.latest;
  const provider = data?.provider;
  const plan = data?.config.provider;
  const restriction = plan?.exhaustionAction === "suspend-managed" ? provider?.managedAdmissionReason : undefined;
  const stale = sample && observationStatus(sample.observedAt) !== "最近观测";
  const providerNeedsReview = plan && provider?.statusReason && ![
    "operator_entered_provider_statement", "operator_reconciled_nic_estimate", "operator_configured_unlimited",
  ].includes(provider.statusReason);
  return <section aria-label="服务器资源概览" className="min-w-0 space-y-3">
    {restriction && <Notice tone="warning" title={restriction === "provider-exhausted" ? "供应商额度已耗尽" : restriction === "provider-expired" ? "供应商服务已到期" : "供应商用量依据需要更新"} action={<ActionButton variant="outline" size="sm" onClick={onOpenResources}>核对额度与周期</ActionButton>}>
      托管线路暂停新连接与续期。请核对供应商周期与用量。
    </Notice>}
    <Card className="min-w-0 gap-4">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle>资源与流量</CardTitle>
            {sample && <p className="text-xs text-muted-foreground">{stale ? "较早的数据" : "数据更新时间"} {dateLabel(sample.observedAt)}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton variant="ghost" size="sm" leadingIcon={<RotateCw aria-hidden="true" />} aria-label="刷新资源概览" pending={query.isFetching} keepFocusableWhilePending onClick={() => query.refetch()} />
            <ActionButton variant="outline" size="sm" leadingIcon={<ChartNoAxesCombined aria-hidden="true" />} onClick={onOpenResources}>{!sample ? "设置采集与额度" : "查看资源与额度"}</ActionButton>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isError && <Notice tone="warning" role="status">{data ? "资源刷新失败，以下保留上次读取的数据。" : "无法读取资源数据，请重试。"}</Notice>}
        {!query.isPending && !query.isError && !data && <p role="status" className="text-sm text-muted-foreground">资源数据尚未确定，请刷新重试。</p>}
        {query.isPaused && <p role="status" className="text-sm text-muted-foreground">等待网络连接{data ? "，以下为上次读取的数据。" : "。"}</p>}
        {query.isPending && !query.isPaused && <p role="status" className="text-sm text-muted-foreground">正在读取资源数据…</p>}
        {!query.isPending && !query.isError && data && !sample && <div className="space-y-1 py-2">
          <p className="text-sm font-medium">{data?.config.observerInstanceId ? "尚未收到服务器资源数据" : "尚未设置服务器资源监控"}</p>
          <p className="text-sm text-muted-foreground">{data?.config.observerInstanceId ? "收到数据后，这里会显示 CPU、内存和网卡流量。若长时间没有数据，请检查监控设置和服务器连接。" : "选择一个核心负责上报这台服务器的资源数据，避免重复统计。"}</p>
        </div>}
        {(sample || plan) && <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {sample && <>
            <Metric icon={<Cpu />} label="CPU 使用率" value={sample.cpuPercent == null ? "暂时无法计算" : Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0 && sample.cpuPercent <= 100 ? `${sample.cpuPercent.toFixed(1)}%` : "未确定"}>
              {sample.cpuPercent == null && <p>需要连续两次有效数据才能计算。</p>}
              <p>1 分钟负载 {Number.isFinite(sample.metrics.load1) ? sample.metrics.load1.toFixed(2) : "未确定"}</p>
            </Metric>
            <Metric icon={<MemoryStick />} label="可用内存" value={bytes(sample.metrics.memoryAvailableBytes)}><p>总内存 {bytes(sample.metrics.memoryTotalBytes)}</p></Metric>
            <Metric icon={<ArrowDownUp />} label="计费网卡流量" value={rate(sample.receiveBytesPerSecond)}>
              {(sample.receiveBytesPerSecond == null || sample.transmitBytesPerSecond == null) && <p>需要连续两次有效数据才能计算网速。</p>}
              <p>接收 / 秒</p><p className="font-medium text-foreground">发送 {rate(sample.transmitBytesPerSecond)}</p>
              <p>{data?.config.billedInterfaces?.length ? data.config.billedInterfaces.join("、") : "尚未选择计费网卡"}</p>
            </Metric>
          </>}
          <Metric icon={<Wallet />} label="供应商剩余额度" value={!plan ? "未设置额度" : plan.mode === "unlimited" ? "不限量" : bytes(provider?.remainingBytes)}>
            {plan && <>
              <p>{plan.name}</p>
              {provider?.source && provider.source !== "none" && <p>{sourceLabel(provider.source)}</p>}
              {provider?.observedAt && <p><span>{provider.fresh ? "截至" : "较早的用量记录"}</span><span className="block">{dateLabel(provider.observedAt)}</span></p>}
              {!provider?.observedAt && plan.mode !== "unlimited" && <p>尚未取得可核对的周期用量</p>}
              {plan.expiresAt && <p>服务到期 {dateLabel(plan.expiresAt)}</p>}
            </>}
          </Metric>
        </div>}
        {stale && <p className="text-xs text-muted-foreground">无法确认这些数据反映最近 15 分钟的情况，请刷新后再查看。</p>}
        {providerNeedsReview && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
          <p className="min-w-0 break-words">{reasonLabel(provider!.statusReason)}</p>
          <ActionButton variant="ghost" size="sm" onClick={onOpenResources}>核对供应商用量</ActionButton>
        </div>}
      </CardContent>
    </Card>
    {data && <ResourceHistory nodeId={host.id} />}
    {data && <ProviderCycleSummary data={data} />}
    {data && <ProviderForecast data={data} readFailed={query.isError || query.isPaused} />}
  </section>;
}

/** A balance is not a time series. Display the recorded consumption and cycle
 * boundaries without inventing a burn-rate forecast or filling absent data. */
function ProviderCycleSummary({ data }: { data: NodeObservationView }) {
  const { provider, config: { provider: plan } } = data;
  const total = provider?.totalBytes;
  const used = provider?.usedBytes;
  if (!plan || plan.mode !== "limited" || total == null || used == null ||
      !Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(used) || used < 0) return null;
  const percent = used / total * 100;
  return <Card role="region" aria-label="周期额度消耗" className="min-w-0 gap-3">
    <CardHeader className="flex flex-wrap items-center justify-between gap-2">
      <CardTitle className="flex items-center gap-2 text-sm"><Wallet aria-hidden="true" className="size-4 text-muted-foreground" />周期额度消耗</CardTitle>
      <p className="text-sm font-semibold tabular-nums">{bytes(used)} <span className="font-normal text-muted-foreground">/ {bytes(total)}</span></p>
    </CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm tabular-nums text-muted-foreground">已用 {percent.toFixed(0)}%</p>
      <Progress aria-label="供应商额度使用比例" value={Math.min(100, percent)} className="h-2" />
      {provider.source && provider.source !== "none" && <p className="text-xs text-muted-foreground">用量来源：{sourceLabel(provider.source)}</p>}
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-2 text-xs text-muted-foreground">
        {plan.cycleStart && plan.cycleEnd && <p className="min-w-0 break-words">周期 {dateLabel(plan.cycleStart)} 至 {dateLabel(plan.cycleEnd)}</p>}
        {provider.observedAt && <p>{provider.fresh ? "用量截至" : "较早的用量记录"} {dateLabel(provider.observedAt)}</p>}
      </div>
    </CardContent>
  </Card>;
}

/** Derived by the backend from the continuous ledger, never from chart dots. */
export function ProviderForecast({ data, readFailed = false }: { data: NodeObservationView; readFailed?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  if (data.config.provider?.mode !== "limited") return null;
  const f = data.forecast;
  const stale = !data.provider.fresh || observationStatus(data.provider.observedAt, now) !== "最近观测";
  const reasons: Record<string, string> = {
    continuous_usage_required: "手工账单无法提供连续用量变化，暂不预测。",
    reconciliation_required: "请先核对本周期用量，再连续采集至少 24 小时。",
    less_than_24_hours: "核对后连续采集还不足 24 小时，暂不预测。",
    stale: "最近用量未更新，暂不预测。",
    no_observed_usage: "观察期间未记录到流量，无法估算耗尽日期。",
    cycle_not_current: "当前周期需要更新，暂不预测。",
    service_expired: "服务已到期，暂不预测。",
    projection_already_elapsed: "预计耗尽时间已过去，请刷新并核对实际用量。",
  };
  const boundaryExpired = !!f && ((f.status === "estimated" && (!f.exhaustedAt || !Number.isFinite(Date.parse(f.exhaustedAt)) || Date.parse(f.exhaustedAt) <= now)) || (!!f.horizon && (!Number.isFinite(Date.parse(f.horizon)) || Date.parse(f.horizon) <= now)));
  const usable = f && !readFailed && !stale && !boundaryExpired;
  const dateValid = f?.exhaustedAt && Number.isFinite(Date.parse(f.exhaustedAt));
  const heading = !usable ? "暂时无法预测" : f.status === "estimated" && dateValid ? `预计 ${dateLabel(f.exhaustedAt!)} 耗尽` : f.status === "beyond_horizon" ? "按当前平均用量，周期结束或服务到期前预计不会耗尽" : f.status === "exhausted" ? "已记录的额度已用完" : "暂时无法预测";
  return <Card role="region" aria-label="流量耗尽预测" className="min-w-0 gap-3">
    <CardHeader><CardTitle className="text-sm">流量耗尽预测</CardTitle></CardHeader>
    <CardContent className="space-y-2 text-sm">
      <p className="font-medium">{heading}</p>
      {(!usable || f.status === "unavailable") && <p className="text-muted-foreground">{readFailed ? "资源读取失败，暂不展示先前预测。" : boundaryExpired ? "预测时间或周期已到，请刷新并核对实际用量。" : stale ? "最近用量未更新，暂不预测。" : reasons[f?.reason || ""] || "需要有效周期额度和连续、已核对的用量记录。"}</p>}
      {usable && f.basisStart && f.basisEnd && <p className="text-xs text-muted-foreground">依据 {dateLabel(f.basisStart)} 至 {dateLabel(f.basisEnd)} 的所选网卡 IN+OUT 增量{f.averageBytesPerSecond != null && Number.isFinite(f.averageBytesPerSecond) ? `，平均 ${f.averageBytesPerSecond > 0 && f.averageBytesPerSecond < 1 ? "<1 B/s" : rate(f.averageBytesPerSecond)}` : ""}。</p>}
      {usable && f.horizon && <p className="text-xs text-muted-foreground">仅推算至 {dateLabel(f.horizon)}。</p>}
      <p className="text-xs text-muted-foreground">假设之后保持核对以来的平均用量，不代表供应商账单或保证；短时突发可能提前耗尽。此预测不会自动停机。</p>
    </CardContent>
  </Card>;
}
