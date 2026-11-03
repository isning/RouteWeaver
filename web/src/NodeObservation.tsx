import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useQuery } from "@tanstack/react-query";
import { RotateCw as ReloadOutlined } from "lucide-react";
import { useState } from "react";
import { request } from "./api";
import { EmptyState, QueryState, Section } from "./components";
import { DataTable } from "./DataTable";
import { bytesLabel, dateLabel } from "./model";
import {
  observationPath,
  observationStatus,
  reasonLabel,
  sourceLabel,
  type NodeObservationView,
} from "./observability-model";
import {
  ObservationConfigForm,
  ProviderMeasurementForm,
} from "./ObservationForms";
import type { CoreInstance, HostRecord } from "./types";
const exactBytes = (value: number | null | undefined) =>
  value == null
    ? "未确定"
    : Number.isSafeInteger(value) && value >= 0
      ? bytesLabel(value)
      : "超出精确显示范围";
const rate = (value: number | null | undefined) =>
  value == null ? "等待连续采样" : `${bytesLabel(Math.round(value))}/s`;
export function NodeObservation({
  host,
  instances,
}: {
  host: HostRecord;
  instances: CoreInstance[];
}) {
  const query = useQuery({
    queryKey: ["node-observation", host.id],
    queryFn: () => request<NodeObservationView>(observationPath(host.id)),
    refetchInterval: 30000,
  });
  const [config, setConfig] = useState<NodeObservationView | null>(null);
  const [measurement, setMeasurement] = useState<{
    kind: "baseline" | "statement";
    view: NodeObservationView;
  } | null>(null);
  const data = query.data,
    sample = data?.latest,
    plan = data?.config.provider,
    provider = data?.provider;
  const currentSample =
    !!sample && observationStatus(sample.observedAt) === "最近观测";
  const canBaseline = !!(
    currentSample &&
    plan &&
    Date.parse(plan.cycleStart || "") <= Date.now() &&
    Date.parse(plan.cycleEnd || "") > Date.now() &&
    data?.config.billedInterfaces?.length
  );
  return (
    <>
      <Section
        className="embedded-section space-y-4"
        title="资源与供应商额度"
        extra={
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              aria-label="刷新服务器资源数据"
              leadingIcon={<ReloadOutlined aria-hidden="true" />}
              onClick={() => query.refetch()}
              variant="outline"
            />
            <ActionButton
              disabled={!data}
              onClick={() => setConfig(data!)}
              variant="outline"
            >
              设置采集与额度
            </ActionButton>
          </div>
        }
      >
        <QueryState
          loading={query.isPending} paused={query.isPaused} loadingLayout="summary"
          error={query.error}
          retry={() => query.refetch()}
        >
          {!sample ? (
            <EmptyState
              title="尚未收到服务器资源数据"
              description={
                data?.config.observerInstanceId
                  ? "已选择采集实例，等待它上报主机资源。"
                  : "选择这台服务器上的一个采集实例，避免多个核心重复统计主机。"
              }
            />
          ) : (
            <>
              <div className="observation-meta flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>资源数据采集于 {dateLabel(sample.observedAt)}</span>
              </div>
              <div className="observation-grid grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Metric
                  label="CPU 使用率"
                  value={
                    sample.cpuPercent == null
                      ? "等待下一次采样"
                      : `${sample.cpuPercent.toFixed(1)}%`
                  }
                />
                <Metric
                  label="可用内存"
                  value={exactBytes(sample.metrics.memoryAvailableBytes)}
                  detail={`共 ${exactBytes(sample.metrics.memoryTotalBytes)}`}
                />
                <Metric
                  label="负载 · 1 / 5 / 15 分钟"
                  value={[
                    sample.metrics.load1,
                    sample.metrics.load5,
                    sample.metrics.load15,
                  ]
                    .map((n) => n.toFixed(2))
                    .join(" / ")}
                />
                <Metric
                  label="计费网卡 · 接收 / 发送"
                  value={`${rate(sample.receiveBytesPerSecond)} / ${rate(sample.transmitBytesPerSecond)}`}
                  detail={
                    data!.config.billedInterfaces?.join("、") ||
                    "尚未选择计费网卡"
                  }
                />
              </div>
              <Accordion type="multiple" defaultValue={[]} className="w-full">
                {[
                  {
                    key: "interfaces",
                    label: "\u67E5\u770B\u7F51\u5361\u7D2F\u8BA1\u8BA1\u6570",
                    children: (
                      <>
                        <p className="muted text-sm text-muted-foreground">
                          网卡累计计数不等于本周期供应商已用额度，也不参与用户倍率计费。
                        </p>
                        <DataTable
                          rowKey="name"
                          rows={sample.metrics.interfaces || []}
                          compact
                          pageSize={0}
                          columns={[
                            { title: "\u7F51\u5361", accessor: "name" },
                            {
                              title: "\u63A5\u6536\u7D2F\u8BA1",
                              render: (_, i) => exactBytes(i.receiveBytes),
                            },
                            {
                              title: "\u53D1\u9001\u7D2F\u8BA1",
                              render: (_, i) => exactBytes(i.transmitBytes),
                            },
                          ]}
                        />
                      </>
                    ),
                  },
                ].map((item) => (
                  <AccordionItem
                    key={String(item.key)}
                    value={String(item.key)}
                  >
                    <AccordionTrigger>{item.label}</AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-4">{item.children}</div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </>
          )}
          {data && !plan && (
            <div className="inline-note rounded-md bg-muted p-3 text-sm text-muted-foreground">
              尚未登记供应商周期与额度。服务器资源数据仍可独立查看。
            </div>
          )}
          {plan && provider && (
            <div className="provider-observation space-y-4 rounded-lg border p-4">
              <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-sm font-semibold break-words">
                    {plan.name}
                  </h3>
                  <p>
                    {plan.cycleId
                      ? `${dateLabel(plan.cycleStart)} 至 ${dateLabel(plan.cycleEnd)}`
                      : "不设额度周期"}
                  </p>
                </div>
                <Badge variant="secondary">
                  {plan.mode === "unlimited"
                    ? "供应商不限量"
                    : `${plan.allowance} ${plan.unit}`}
                </Badge>
              </div>
              {plan.exhaustionAction === "suspend-managed" && (
                <Notice
                  tone={provider.managedAdmissionReason ? "warning" : "info"}
                >
                  {provider.managedAdmissionReason === "provider-exhausted"
                    ? "供应商额度耗尽：该主机参与的托管线路暂停新连接与续期。"
                    : provider.managedAdmissionReason === "provider-expired"
                      ? "供应商服务已到期：该主机参与的托管线路暂停新连接与续期。"
                      : provider.managedAdmissionReason
                        ? "缺少当前有效的供应商用量依据：托管线路暂停新连接与续期。请更新当前周期的所选依据。"
                        : "托管连接暂停策略已配置；当前用量依据未阻止准入，实际连接仍需通过其余授权检查。"}
                </Notice>
              )}
              <div className="observation-grid grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {plan.cycleId && (
                  <Metric
                    label="本周期已用"
                    value={exactBytes(provider.usedBytes)}
                  />
                )}
                <Metric
                  label="剩余额度"
                  value={
                    plan.mode === "unlimited"
                      ? "不限量"
                      : exactBytes(provider.remainingBytes)
                  }
                />
              </div>
              {plan.mode === "limited" &&
                provider.usedBytes != null &&
                provider.totalBytes != null &&
                provider.totalBytes > 0 &&
                Number.isSafeInteger(provider.usedBytes) &&
                Number.isSafeInteger(provider.totalBytes) && (
                  <Progress
                    value={Math.min(
                      100,
                      Math.round(
                        (provider.usedBytes / provider.totalBytes) * 100,
                      ),
                    )}
                    aria-label="供应商周期额度使用比例"
                  />
                )}
              {(plan.cycleId || provider.observedAt) && (
                <p className="observation-meta flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {provider.source !== "none" && (
                    <Badge variant="secondary">
                      {sourceLabel(provider.source)}
                    </Badge>
                  )}
                  <span>
                    {provider.observedAt
                      ? `截至 ${dateLabel(provider.observedAt)}${provider.fresh ? "" : " · 不是实时余额"}`
                      : "尚未取得可核对的周期用量"}
                  </span>
                </p>
              )}
              {provider.statusReason &&
                ![
                  "operator_entered_provider_statement",
                  "operator_reconciled_nic_estimate",
                  "operator_configured_unlimited",
                ].includes(provider.statusReason) && (
                  <p className="muted text-sm text-muted-foreground">
                    {reasonLabel(provider.statusReason)}
                  </p>
                )}
              {plan.expiresAt && <p>服务到期：{dateLabel(plan.expiresAt)}</p>}
              {plan.cycleId && (
                <div className={"flex flex-wrap items-center gap-2"}>
                  <ActionButton
                    onClick={() =>
                      setMeasurement({ kind: "statement", view: data! })
                    }
                    variant="outline"
                  >
                    录入供应商用量
                  </ActionButton>
                  <ActionButton
                    disabled={!canBaseline}
                    onClick={() =>
                      setMeasurement({ kind: "baseline", view: data! })
                    }
                    variant="outline"
                  >
                    核对网卡估算基线
                  </ActionButton>
                </div>
              )}
              {plan.cycleId && !canBaseline && (
                <p className="muted text-sm text-muted-foreground">
                  核对网卡基线需要当前周期的新采样，并明确选择计费网卡。
                </p>
              )}
              <Accordion type="multiple" defaultValue={[]} className="w-full">
                {[
                  {
                    key: "reference",
                    label:
                      "\u7528\u91CF\u4F9D\u636E\u4E0E\u6838\u5BF9\u8BB0\u5F55",
                    children: (
                      <>
                        <p>
                          已采集网卡增量：
                          {exactBytes(provider.observedNicBytes)}
                          {provider.observedSince
                            ? ` · 自 ${dateLabel(provider.observedSince)}`
                            : " \u00B7 \u5C1A\u65E0\u8FDE\u7EED\u589E\u91CF"}
                        </p>
                        {data?.statement && (
                          <p>
                            供应商记录：{data.statement.reference} ·{" "}
                            {dateLabel(data.statement.observedAt)}
                          </p>
                        )}
                        {data?.baseline && (
                          <p>
                            基线说明：{data.baseline.reason} ·{" "}
                            {dateLabel(data.baseline.observedAt)}
                          </p>
                        )}
                        <p>
                          提醒依据：
                          {plan.notificationSource === "none"
                            ? "\u4E0D\u53D1\u9001\u989D\u5EA6\u63D0\u9192"
                            : sourceLabel(plan.notificationSource)}
                          。仅满足当前周期、连续覆盖及新鲜度要求时进入提醒评估。
                        </p>
                        <p>
                          {plan.exhaustionAction === "suspend-managed"
                            ? "托管连接暂停策略已配置：额度耗尽、依据缺失或过期时拒绝新连接与续期；现有连接按短租约结束。stock 内核不受控，不自动更换出口。"
                            : "配额耗尽仅提醒，不自动更换出口或修改线路。"}
                        </p>
                      </>
                    ),
                  },
                ].map((item) => (
                  <AccordionItem
                    key={String(item.key)}
                    value={String(item.key)}
                  >
                    <AccordionTrigger>{item.label}</AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-4">{item.children}</div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          )}
        </QueryState>
      </Section>
      {config && (
        <ObservationConfigForm
          initial={config}
          instances={instances.filter((i) => i.hostId === host.id)}
          onClose={() => setConfig(null)}
        />
      )}
      {measurement && (
        <ProviderMeasurementForm
          initial={measurement.view}
          kind={measurement.kind}
          onClose={() => setMeasurement(null)}
        />
      )}
    </>
  );
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="observation-metric min-w-0 space-y-2 rounded-lg border bg-muted/20 p-4 [&_span]:text-sm [&_span]:text-muted-foreground [&_strong]:block [&_strong]:break-words [&_strong]:text-xl [&_strong]:tabular-nums [&_small]:text-muted-foreground">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
