import { FieldSet, FieldLegend } from "@/components/ui/field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { useConfirm } from "@/ui-patterns/confirmations";
import { AppField, AppForm, useForm, useWatch } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { list, post } from "./api";
import { EmptyState, ErrorNotice, QueryState, Section } from "./components";
import { DataTable } from "./DataTable";
import {
  diagnosticActive,
  diagnosticKindLabel,
  diagnosticStatus,
  type AvailableDiagnosticPath,
  type DiagnosticJob,
  type DiagnosticKind,
  type DiagnosticTarget,
} from "./diagnostics-model";
import { bytesLabel, dateLabel, newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import type { CoreInstance, HostRecord } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
const base = "/admin/diagnostic-jobs";
export function DiagnosticsPanel({
  host,
  instances,
}: {
  host: HostRecord;
  instances: CoreInstance[];
}) {
  const client = useQueryClient();
  const targets = useQuery({
    queryKey: ["diagnostic-targets"],
    queryFn: () => list<DiagnosticTarget>("/admin/diagnostic-targets"),
  });
  const jobs = useQuery({
    queryKey: ["diagnostic-jobs"],
    queryFn: () => list<DiagnosticJob>(base),
    refetchInterval: (q) =>
      q.state.data?.some((j) => diagnosticActive(j.status)) ? 5000 : false,
  });
  const [creating, setCreating] = useState(false),
    [adding, setAdding] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const availableTargets = (targets.data || []).filter(
    (t) => t.nodeId === host.id,
  );
  const availableInstances = instances.filter((i) => i.hostId === host.id);
  const rows = (jobs.data || []).filter((j) => j.scope.nodeId === host.id);
  const selectedJob = rows.find((j) => j.id === selected);
  return (
    <>
      <Section
        className="embedded-section space-y-4"
        title="节点连接诊断"
        description="测试服务器直连或已应用线路的连通性、下载与上传性能。"
        extra={
          <ActionButton
            onClick={() => setCreating(true)}
            disabled={!availableTargets.length || !availableInstances.length}
            variant="outline"
          >
            新建测试
          </ActionButton>
        }
      >
        <QueryState
          loading={jobs.isPending || targets.isPending} paused={jobs.isPaused || targets.isPaused} loadingLayout="table"
          error={jobs.error || targets.error}
          retry={() => {
            jobs.refetch();
            targets.refetch();
          }}
        >
          {!availableTargets.length && (
            <EmptyState
              title="先登记测试目标"
              description="选择可用于测试的 HTTPS 地址，并声明它支持的测试方式。"
              action={
                <ActionButton onClick={() => setAdding(true)} variant="outline">
                  登记测试目标
                </ActionButton>
              }
            />
          )}
          {!!rows.length && (
            <DataTable
              rowKey="id"
              rows={rows}
              compact
              minWidth={440}
              pageSize={5}
              columns={[
                {
                  title: "测试",
                  render: (_, j) => (
                    <>
                      <strong>
                        {diagnosticKindLabel[j.kind]} · {j.target.name}
                      </strong>
                      <p className="muted text-sm text-muted-foreground">
                        {j.pathMode === "managed_route"
                          ? "已应用线路路径"
                          : "服务器直连"}{" "}
                        · {dateLabel(j.requestedAt)}
                      </p>
                    </>
                  ),
                },
                {
                  title: "结果",
                  render: (_, j) => (
                    <Badge variant="secondary">
                      {diagnosticStatus(j.status)}
                    </Badge>
                  ),
                },
                {
                  title: "",
                  render: (_, j) => (
                    <ActionButton
                      onClick={() => setSelected(j.id)}
                      aria-label="查看测试结果"
                      variant="outline"
                      size="sm"
                    >
                      详情
                    </ActionButton>
                  ),
                },
              ]}
            />
          )}
          {!!availableTargets.length && !rows.length && (
            <p className="inline-empty rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              尚未执行测试。选择目标与流量上限后，再提交到节点。
            </p>
          )}
          <Accordion type="multiple" defaultValue={[]} className="w-full">
            {[
              {
                key: "targets",
                label: `授权测试目标 · ${availableTargets.length}`,
                children: (
                  <>
                    <ul className="simple-list space-y-2 text-sm">
                      {availableTargets.map((t) => (
                        <li key={t.id}>
                          <strong>{t.name}</strong>
                          <p className="muted text-sm text-muted-foreground">
                            {t.url}
                          </p>
                          <small>
                            {t.methods
                              .map((m) => diagnosticKindLabel[m])
                              .join(" \u00B7 ")}
                          </small>
                        </li>
                      ))}
                    </ul>
                    <ActionButton
                      onClick={() => setAdding(true)}
                      variant="outline"
                    >
                      登记测试目标
                    </ActionButton>
                    <p className="muted text-sm text-muted-foreground">
                      目标地址固定保存。更换地址请登记新目标，不会改写既有测试记录。
                    </p>
                  </>
                ),
              },
            ].map((item) => (
              <AccordionItem key={String(item.key)} value={String(item.key)}>
                <AccordionTrigger>{item.label}</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-4">{item.children}</div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </QueryState>
      </Section>
      {adding && (
        <DiagnosticTargetForm host={host} onClose={() => setAdding(false)} />
      )}
      {creating && (
        <DiagnosticStartForm
          targets={availableTargets}
          instances={availableInstances}
          onClose={() => setCreating(false)}
          onCreated={(job) => {
            client.invalidateQueries({ queryKey: ["diagnostic-jobs"] });
            setCreating(false);
            setSelected(job.id);
          }}
        />
      )}
      <TaskSheet
        bodyProps={{ className: "space-y-5" }}
        title="测试详情"
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) (() => setSelected(null))();
        }}
        size="md"
      >
        {selectedJob && (
          <DiagnosticResult job={selectedJob} refresh={() => jobs.refetch()} />
        )}
      </TaskSheet>
    </>
  );
}
export function DiagnosticResult({
  job,
  refresh,
}: {
  job: DiagnosticJob;
  refresh: () => void;
}) {
  const confirm = useConfirm();
  const cancel = useMutation({
    mutationFn: () => post<DiagnosticJob>(`${base}/${job.id}/cancel`, {}),
    onSuccess: refresh,
  });
  const result = job.result;
  return (
    <>
      <ErrorNotice error={cancel.error} />
      <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
        <h3 className="text-sm font-semibold">
          {diagnosticKindLabel[job.kind]} · {job.target.name}
        </h3>
        <Badge variant="secondary">{diagnosticStatus(job.status)}</Badge>
      </div>
      <p className="inline-note break-words rounded-md bg-muted p-3 text-sm text-muted-foreground">
        测试路径：
        {job.pathMode === "managed_route"
          ? "入口核心 → 已配置中转/出口 → 测试目标"
          : "服务器 → 测试目标（直连出站）"}
      </p>
      {job.pathMode === "managed_route" && (
        <p className="muted text-sm text-muted-foreground">
          测试的是已应用连接路径，不测试公开入口 TLS
          或客户端接入认证。测试载荷不扣租户额度；每一跳的网卡与供应商流量仍会增加。
        </p>
      )}
      <p className="break-all text-sm">
        载荷方向：{job.kind === "download" ? "目标 → 服务器" : "服务器 → 目标"}{" "}
        · {job.target.url}
      </p>
      <p>
        提交于 {dateLabel(job.requestedAt)} · 最长 {job.timeoutSeconds} 秒
      </p>
      {result?.status === "succeeded" && result.bytesPerSecond != null && (
        <div className="observation-metric space-y-1 [&_strong]:block [&_strong]:text-xl">
          <span>本次应用载荷速率</span>
          <strong>{bytesLabel(Math.round(result.bytesPerSecond))}/s</strong>
        </div>
      )}
      {result?.costKnown ? (
        <p>
          实际测试载荷：发送 {bytesLabel(result.bytesSent)}，接收{" "}
          {bytesLabel(result.bytesReceived)}。
        </p>
      ) : (
        <p>
          {diagnosticActive(job.status)
            ? "测试计量尚未返回。"
            : "未收到完整计量，不能认定没有产生流量。"}
        </p>
      )}
      {job.kind === "upload" && result?.status === "succeeded" && (
        <p className="muted text-sm text-muted-foreground">
          上传结果确认本地请求发送和目标响应完成，不代表接收端已持久保存内容。
        </p>
      )}
      {result?.action && (
        <Notice
          tone={result.status === "succeeded" ? "info" : "warning"}
          title={result.action}
        />
      )}
      <p className="muted text-sm text-muted-foreground">
        {job.kind === "connectivity"
          ? "连通性仅发送 HEAD 请求，不下载测试正文。"
          : `测试载荷上限 ${bytesLabel(job.estimatedMaxBytes)}。`}
        载荷只计一次，不是各跳合计流量。协议与加密开销另计，这些数值不是供应商账单流量。
      </p>
      <div className={"flex flex-wrap items-center gap-2"}>
        <ActionButton onClick={refresh} variant="outline">
          刷新结果
        </ActionButton>
        {diagnosticActive(job.status) && job.status !== "cancel_requested" && (
          <ActionButton
            pending={cancel.isPending}
            onClick={() =>
              confirm({
                title: `取消对「${job.target.name}」的${diagnosticKindLabel[job.kind]}？`,
                description:
                  "节点收到后停止剩余测试。已经产生的流量不会撤销，取消请求不等于已停止。",
                confirmLabel: "请求取消",
                cancelLabel: "继续测试",
                onConfirm: () => cancel.mutateAsync().catch(() => {}),
              })
            }
            variant="destructive"
          >
            取消测试
          </ActionButton>
        )}
      </div>
      <Accordion type="multiple" defaultValue={[]} className="w-full">
        {[
          {
            key: "technical",
            label: "\u6267\u884C\u8BB0\u5F55",
            children: (
              <>
                <p>任务：{job.id}</p>
                <p>实例：{job.instanceId}</p>
                {job.managedPath && (
                  <>
                    <p>线路：{job.managedPath.routeId}</p>
                    <p>
                      路径：
                      {job.managedPath.hops
                        .map((h) => h.endpointId)
                        .join(" \u2192 ")}
                    </p>
                    <p>部署：{job.managedPath.deploymentId}</p>
                    <p>固定版本：{job.managedPath.fingerprint}</p>
                  </>
                )}
                {result && (
                  <>
                    <p>
                      阶段：{result.phase} · 结果代码：{result.code}
                    </p>
                    {!["dispatch", "recovery"].includes(result.phase) && (
                      <>
                        <p>
                          开始 {dateLabel(result.startedAt)} · 结束{" "}
                          {dateLabel(result.finishedAt)}
                        </p>
                        <p>
                          持续 {result.durationMs} 毫秒
                          {result.httpStatus
                            ? ` · HTTP ${result.httpStatus}`
                            : ""}
                        </p>
                      </>
                    )}
                  </>
                )}
              </>
            ),
          },
        ].map((item) => (
          <AccordionItem key={String(item.key)} value={String(item.key)}>
            <AccordionTrigger>{item.label}</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">{item.children}</div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </>
  );
}
function DiagnosticTargetForm({
  host,
  onClose,
}: {
  host: HostRecord;
  onClose: () => void;
}) {
  const [id] = useState(() => newID("probe-target"));
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (values: any) =>
      post<DiagnosticTarget>("/admin/diagnostic-targets", {
        id,
        nodeId: host.id,
        name: values.name,
        url: values.url,
        methods: values.methods,
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["diagnostic-targets"] });
      onClose();
    },
  });
  const { confirm: confirmDiscard } =
    useDiscardConfirmation("Diagnostics-editor");
  const close = () => {
    if (save.isPending) return;
    if (!dirty) return onClose();
    confirmDiscard(
      {
        title: "放弃未保存的测试目标？",
        description: "当前输入尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title="登记授权测试目标"
      open
      pending={save.isPending}
      footer={null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AppForm
        initialValues={{ methods: ["connectivity"] }}
        disabled={save.isPending}
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => save.mutate(values)}
      >
        <ErrorNotice error={save.error} />
        <AppField name="name" label="目标名称" rules={[{ required: true }]}>
          <Input maxLength={128} />
        </AppField>
        <AppField
          name="url"
          label="HTTPS 测试地址"
          rules={[
            { required: true },
            {
              validator: (_, value) => {
                try {
                  const url = new URL(value);
                  if (
                    url.protocol !== "https:" ||
                    url.username ||
                    url.password ||
                    url.search ||
                    url.hash
                  )
                    throw new Error();
                  return Promise.resolve();
                } catch {
                  return Promise.reject(
                    new Error("使用不含凭据、查询参数或片段的 HTTPS 地址"),
                  );
                }
              },
            },
          ]}
        >
          <Input placeholder="https://your-test-host.example/test" />
        </AppField>
        <AppField
          name="methods"
          label="目标支持的测试"
          rules={[{ required: true }]}
        >
          <DiagnosticMethods />
        </AppField>
        <p className="muted text-sm text-muted-foreground">
          只登记你有权用于测试的公开地址。下载目标需支持精确
          Range；上传必须使用专用诊断上传端点，PUT
          可能覆盖该地址的内容，不应填写文件或业务资源地址。不会发送账号凭据。
        </p>
        <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
          <ActionButton onClick={close} variant="outline">
            取消
          </ActionButton>
          <ActionButton
            type="submit"
            pending={save.isPending}
            variant="default"
          >
            保存测试目标
          </ActionButton>
        </div>
      </AppForm>
    </TaskDialog>
  );
}
export function DiagnosticStartForm({
  targets,
  instances,
  onClose,
  onCreated,
}: {
  targets: DiagnosticTarget[];
  instances: CoreInstance[];
  onClose: () => void;
  onCreated: (job: DiagnosticJob) => void;
}) {
  const [form] = useForm();
  const [id, setId] = useState(() => newID("probe"));
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const targetId = useWatch("targetId", form),
    kind = useWatch("kind", form) as DiagnosticKind | undefined;
  const pathMode = useWatch("pathMode", form) || "node_direct";
  const routeId = useWatch("publishedRouteId", form);
  const paths = useQuery({
    queryKey: ["diagnostic-paths"],
    queryFn: () => list<AvailableDiagnosticPath>("/admin/diagnostic-paths"),
    enabled: pathMode === "managed_route",
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const availablePaths = (paths.data || []).filter((path) =>
    instances.some(
      (instance) =>
        instance.id === path.instanceId && instance.hostId === path.nodeId,
    ),
  );
  const selectedPath = availablePaths.find(
    (path) => path.publishedRouteId === routeId,
  );
  const target = targets.find((t) => t.id === targetId);
  const save = useMutation({
    mutationFn: (values: any) =>
      post<DiagnosticJob>(base, {
        id,
        targetId: values.targetId,
        instanceId:
          values.pathMode === "managed_route"
            ? selectedPath!.instanceId
            : values.instanceId,
        pathMode: values.pathMode,
        ...(values.pathMode === "managed_route"
          ? { publishedRouteId: values.publishedRouteId }
          : {}),
        kind: values.kind,
        maxBytes: values.kind === "connectivity" ? 0 : values.maxKiB * 1024,
        timeoutSeconds: values.timeoutSeconds,
      }),
    onSuccess: onCreated,
  });
  const { confirm: confirmDiscard } =
    useDiscardConfirmation("Diagnostics-editor");
  const close = () => {
    if (save.isPending) return;
    if (!dirty) return onClose();
    confirmDiscard(
      {
        title: "放弃当前测试设置？",
        description: "当前输入尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title="新建连接测试"
      size="lg"
      open
      pending={save.isPending}
      footer={null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AppForm
        form={form}
        disabled={save.isPending}
        initialValues={{
          pathMode: "node_direct",
          timeoutSeconds: 10,
          maxKiB: 1024,
        }}
        onValuesChange={(changed) => {
          setDirty(true);
          if (!("confirmed" in changed)) {
            setId(newID("probe"));
            if ("targetId" in changed) form.setFieldValue("kind", undefined);
            if ("pathMode" in changed)
              form.setFieldValue("publishedRouteId", undefined);
            form.setFieldValue("confirmed", false);
          }
        }}
        onFinish={(values) => save.mutate(values)}
      >
        <ErrorNotice error={save.error} />
        <FieldSet className="min-w-0">
          <FieldLegend variant="label">执行路径</FieldLegend>
          <AppField
            name="pathMode"
            label="测试路径方式"
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={[
                { value: "node_direct", label: "服务器直连出站" },
                { value: "managed_route", label: "已应用线路的中转与出口" },
              ]}
            />
          </AppField>
          {pathMode === "node_direct" ? (
            <AppField
              name="instanceId"
              label="执行实例"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={instances.map((i) => ({
                  value: i.id,
                  label: i.name || i.adapterId,
                }))}
              />
            </AppField>
          ) : (
            <>
              <QueryState
                loading={pathMode === "managed_route" && paths.isPending} paused={paths.isPaused} loadingLayout="form"
                error={paths.error}
                retry={() => paths.refetch()}
              >
                <AppField
                  name="publishedRouteId"
                  label="已应用线路"
                  rules={[
                    { required: true },
                    {
                      validator: (_, value) =>
                        availablePaths.some(
                          (path) => path.publishedRouteId === value,
                        )
                          ? Promise.resolve()
                          : Promise.reject(
                              new Error("请选择当前可测试的已应用线路"),
                            ),
                    },
                  ]}
                  trigger="onValueChange"
                >
                  <ChoiceSelect
                    options={availablePaths.map((path) => ({
                      value: path.publishedRouteId,
                      label: `${path.name} · ${path.managedPath.hops.length} 跳`,
                    }))}
                  />
                </AppField>
                {!paths.isLoading && !paths.error && !availablePaths.length && (
                  <p className="inline-empty rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    此入口暂无可测试的已应用线路。请先应用线路，并确认每一跳的
                    Agent 在线回报。
                  </p>
                )}
              </QueryState>
              <ActionButton
                onClick={() => {
                  form.setFieldValue("confirmed", false);
                  paths.refetch();
                }}
                variant="outline"
                size="sm"
              >
                刷新可测试线路
              </ActionButton>
              <p className="muted text-sm text-muted-foreground">
                从入口核心经过已配置中转与出口访问目标，不测试公开入口 TLS
                或客户端接入认证。任务按提交时的已应用路径固定，途中变化不会认定测试成功。
              </p>
            </>
          )}
        </FieldSet>
        <FieldSet className="min-w-0 border-t pt-4">
          <FieldLegend variant="label">目标与测试上限</FieldLegend>
          <AppField
            name="targetId"
            label="授权目标"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={targets.map((t) => ({ value: t.id, label: t.name }))}
            />
          </AppField>
          {target && (
            <p className="inline-note break-words rounded-md bg-muted p-3 text-sm text-muted-foreground">
              测试路径：
              {pathMode === "managed_route"
                ? "入口核心 → 已配置中转/出口 → "
                : "服务器 → "}
              {target.url}
              {pathMode === "node_direct" ? "（直连出站）" : ""}
            </p>
          )}
          <AppField
            name="kind"
            label="测试方式"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect
              disabled={!target}
              options={(target?.methods || []).map((value) => ({
                value,
                label: diagnosticKindLabel[value],
              }))}
            />
          </AppField>
          <div className="form-grid grid gap-4 sm:grid-cols-2">
            <AppField
              name="timeoutSeconds"
              label="最长持续秒数"
              rules={[{ required: true }]}
              getValueFromEvent={(
                event: React.ChangeEvent<HTMLInputElement>,
              ) =>
                event.target.value === ""
                  ? undefined
                  : Number(event.target.value)
              }
            >
              <Input min={1} max={30} type="number" />
            </AppField>
            {kind && kind !== "connectivity" && (
              <AppField
                name="maxKiB"
                label="最大载荷（KiB）"
                rules={[{ required: true }]}
                getValueFromEvent={(
                  event: React.ChangeEvent<HTMLInputElement>,
                ) =>
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value)
                }
              >
                <Input min={1} max={16384} type="number" />
              </AppField>
            )}
          </div>
        </FieldSet>
        <p className="rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed text-muted-foreground">
          {kind === "connectivity"
            ? "仅发送 HEAD 请求，不下载测试正文，仍会产生协议流量。"
            : "上传或下载会消耗实际网络流量。上传另允许最多 16 KiB 的响应正文。"}
          载荷上限只计一次，不含各跳的协议与加密开销，不等于供应商账单流量。
          {pathMode === "managed_route" &&
            "测试载荷不扣租户额度，但各跳的网卡与供应商流量仍会增加。"}
        </p>
        {kind === "upload" && (
          <Notice tone="warning" title="上传将向此地址发送 PUT">
            {
              "PUT \u53EF\u80FD\u66FF\u6362\u76EE\u6807\u5185\u5BB9\u3002\u8BF7\u786E\u8BA4\u8FD9\u662F\u6388\u6743\u7684\u4E13\u7528\u8BCA\u65AD\u4E0A\u4F20\u7AEF\u70B9\uFF0C\u4E0D\u662F\u6587\u4EF6\u6216\u4E1A\u52A1\u8D44\u6E90\u5730\u5740\u3002"
            }
          </Notice>
        )}
        <AppField
          name="confirmed"
          rules={[
            {
              validator: (_, value) =>
                value
                  ? Promise.resolve()
                  : Promise.reject(new Error("请确认测试目标与流量上限")),
            },
          ]}
          trigger="onCheckedChange"
          valuePropName="checked"
          label={<>我确认目标与测试上限，提交后由节点执行</>}
        >
          <Checkbox />
        </AppField>
        <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
          <ActionButton onClick={close} variant="outline">
            取消
          </ActionButton>
          <ActionButton
            type="submit"
            pending={save.isPending}
            disabled={
              pathMode === "managed_route" &&
              (paths.isFetching || !!paths.error || !selectedPath)
            }
            variant="default"
          >
            提交测试
          </ActionButton>
        </div>
      </AppForm>
    </TaskDialog>
  );
}
function DiagnosticMethods({
  value = [],
  onChange,
  id,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
  id?: string;
}) {
  return (
    <div id={id} className="space-y-3">
      {[
        { value: "connectivity", label: "HEAD 连通性" },
        { value: "download", label: "Range 下载" },
        { value: "upload", label: "PUT 上传（可能覆盖目标内容）" },
      ].map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.includes(option.value)}
            onCheckedChange={(checked) =>
              onChange?.(
                checked
                  ? [...value, option.value]
                  : value.filter((item) => item !== option.value),
              )
            }
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
