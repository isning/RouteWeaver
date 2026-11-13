import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, RotateCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

function Metric({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return <div role="group" aria-label={label} className="min-w-0 space-y-2 rounded-lg border bg-background p-4 [overflow-wrap:anywhere]">
    <p className="text-sm text-muted-foreground">{label}</p>
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
            <ActionButton variant="outline" size="sm" onClick={onOpenResources}>{!sample ? "设置采集与额度" : "查看资源与额度"}</ActionButton>
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
            <Metric label="CPU 使用率" value={sample.cpuPercent == null ? "暂时无法计算" : Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0 && sample.cpuPercent <= 100 ? `${sample.cpuPercent.toFixed(1)}%` : "未确定"}>
              {sample.cpuPercent == null && <p>需要连续两次有效数据才能计算。</p>}
              <p>1 分钟负载 {Number.isFinite(sample.metrics.load1) ? sample.metrics.load1.toFixed(2) : "未确定"}</p>
            </Metric>
            <Metric label="可用内存" value={bytes(sample.metrics.memoryAvailableBytes)}><p>总内存 {bytes(sample.metrics.memoryTotalBytes)}</p></Metric>
            <Metric label="计费网卡流量" value={rate(sample.receiveBytesPerSecond)}>
              {(sample.receiveBytesPerSecond == null || sample.transmitBytesPerSecond == null) && <p>需要连续两次有效数据才能计算网速。</p>}
              <p>接收 / 秒</p><p className="font-medium text-foreground">发送 {rate(sample.transmitBytesPerSecond)}</p>
              <p>{data?.config.billedInterfaces?.length ? data.config.billedInterfaces.join("、") : "尚未选择计费网卡"}</p>
            </Metric>
          </>}
          <Metric label="供应商剩余额度" value={!plan ? "未设置额度" : plan.mode === "unlimited" ? "不限量" : bytes(provider?.remainingBytes)}>
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
  </section>;
}
