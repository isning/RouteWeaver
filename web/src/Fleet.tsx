import { ResourceToolbar, SearchField, ToolbarFilter } from "@/ui-patterns/resource-toolbar";
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
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { useConfirm } from "@/ui-patterns/confirmations";
import { Notice } from "@/ui-patterns/notice";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { APIError, list, post, request } from "./api";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { DataTable } from "./DataTable";
import {
  fleetActionLabel,
  fleetStatus,
  fleetStrategyIssue,
  stagesFor,
  strategyAssignments,
  type CoreRelease,
  type FleetAction,
  type FleetBatch,
  type FleetInput,
  type FleetPlan,
  type FleetStrategy,
  type FleetTarget,
} from "./fleet-model";
import { coreName, loadInfrastructure } from "./infrastructure-data";
import { dateLabel, newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import type { Infrastructure } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
const base = "/admin/fleet-batches";
function serviceConsequence(
  input: Pick<FleetInput, "action" | "continuousService">,
): string {
  if (input.continuousService)
    return "授权与配置有效时继续续期；确认核心退出后，最多自动恢复 3 次，依次等待 5、10、20 秒。达到上限、结果未确认或权限变化时暂停，必须重新检查；不会自动恢复已撤销的权限。停止核心或提交未勾选持续运行的替代操作，会关闭原持续授权。仅退出 Agent 进程不等于关闭授权。";
  return input.action === "stop"
    ? "执行停止时会关闭所选实例的持续授权，不会再自动恢复。"
    : "本次不授予持续运行权限；执行时会关闭原有持续授权。现有核心仅保留当前有时限的运行授权，到期后停止。";
}
// Only this typed pre-creation rejection establishes that no batch was created.
// Unknown responses retain the transport's existing fallback and uncertainty.
function fleetCreateFeedback(error: Error | null): Error | null {
  if (
    error instanceof APIError &&
    error.status === 409 &&
    error.details !== null &&
    typeof error.details === "object" &&
    "code" in error.details &&
    error.details.code === "FLEET_REVIEW_CHANGED"
  )
    return new APIError(
      "计划需要重新核对，尚未创建批次。请重新预览后再创建。",
      error.status,
      error.details,
    );
  return error;
}
function fleetAttemptFeedback(
  attempt: FleetTarget["attempts"][number],
): string {
  switch (attempt.code) {
    case "review_required":
      return "当前计划需要重新检查。请重新预览后再安排执行。";
    case "authorization_or_configuration_changed":
      return "配置、凭据或账号权限已变化。请重新预览新批次。";
    case "enrollment_changed":
      return "该实例的节点授权已变化、过期或撤销。请核对授权后重新计划。";
    case "desired_superseded_review_required":
      // A previously queued attempt can become superseded; do not imply no write.
      return "此实例已有后续变更。请核对当前实例和批次状态。";
    case "previous_stage_no_longer_current":
      return "前一阶段的当前状态需要重新核对。请确认后再继续。";
    case "target_unsupported":
      return "此实例无法安全执行已核对的操作。请核对支持的能力和当前版本。";
    default:
      return attempt.detail || attempt.code || "";
  }
}
export function FleetPage({
  pendingDeploymentId,
}: {
  pendingDeploymentId?: string;
}) {
  const history = useQuery({
    queryKey: ["fleet-batches"],
    queryFn: () => list<FleetBatch>(base),
  });
  const infrastructure = useQuery({
    queryKey: ["infrastructure"],
    queryFn: loadInfrastructure,
  });
  const [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="执行任务"
        action={
          <ActionButton
            disabled={!infrastructure.data}
            onClick={() => setCreating(true)}
            variant="default"
          >
            计划变更
          </ActionButton>
        }
      />
      <QueryState
        loading={history.isPending || infrastructure.isPending} paused={history.isPaused || infrastructure.isPaused} loadingLayout="table"
        error={history.error || infrastructure.error}
        retry={() => {
          history.refetch();
          infrastructure.refetch();
        }}
      >
        <Section title="变更历史" variant="plain">
          {history.data?.length ? (
            <DataTable
              rowKey="id"
              rows={history.data}
              minWidth={650}
              columns={[
                {
                  title: "操作",
                  render: (_, b) => (
                    <button
                      className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelected(b.id)}
                    >
                      {fleetActionLabel[b.action]}
                    </button>
                  ),
                },
                {
                  title: "转发路径",
                  render: (_, b) =>
                    infrastructure.data?.deployments.find(
                      (d) => d.id === b.deploymentId,
                    )?.name || b.deploymentId,
                },
                {
                  title: "范围",
                  render: (_, b) =>
                    `${b.targets.length} 个实例 · ${b.affectedUsers} 位用户`,
                },
                {
                  title: "状态",
                  render: (_, b) => (
                    <Badge variant="secondary">{fleetStatus(b.status)}</Badge>
                  ),
                },
                { title: "创建时间", render: (_, b) => dateLabel(b.createdAt) },
                {
                  title: "",
                  render: (_, b) => (
                    <ActionButton
                      onClick={() => setSelected(b.id)}
                      variant="outline"
                    >
                      查看进度
                    </ActionButton>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState title="暂无批量变更" />
          )}
        </Section>
      </QueryState>
      {creating && infrastructure.data && (
        <FleetPlanForm
          inventory={infrastructure.data}
          pendingDeploymentId={pendingDeploymentId}
          history={history.data || []}
          onClose={() => setCreating(false)}
          onCreated={(batch) => {
            setCreating(false);
            setSelected(batch.id);
            history.refetch();
          }}
        />
      )}
      {selected && (
        <FleetBatchDetail id={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
export function FleetPlanForm({
  inventory,
  history,
  initialDeploymentId = "",
  initialAction,
  initialTargetIds = [],
  pendingDeploymentId,
  onClose,
  onCreated,
}: {
  inventory: Infrastructure;
  history: FleetBatch[];
  initialDeploymentId?: string;
  initialAction?: FleetAction;
  initialTargetIds?: string[];
  pendingDeploymentId?: string;
  onClose: () => void;
  onCreated: (batch: FleetBatch) => void;
}) {
  const [action, setAction] = useState<FleetAction>(
      initialAction || "configure",
    ),
    [deploymentId, setDeployment] = useState(initialDeploymentId);
  const [targetIds, setTargets] = useState<string[]>(initialTargetIds),
    [assignments, setAssignments] = useState<Record<string, number>>({});
  const [strategy, setStrategy] = useState<FleetStrategy>("together");
  // A new review never inherits an earlier batch's continuing authorization.
  const [continuousService, setContinuousService] = useState(false);
  const canContinue = action === "start" || action === "configure";
  const strategyIssue = fleetStrategyIssue(strategy, targetIds.length);
  const effectiveAssignments =
    strategy === "custom"
      ? assignments
      : strategyAssignments(targetIds, strategy);
  const [targetReleaseId, setRelease] = useState<string>();
  const lifecycle = action === "install" || action === "upgrade";
  const releases = useQuery({
    queryKey: ["core-releases"],
    queryFn: () => list<CoreRelease>("/admin/core-releases"),
    enabled: lifecycle,
  });
  const selectedRelease = releases.data?.find((r) => r.id === targetReleaseId);
  const [sourceBatchId, setSource] = useState<string>(),
    [leaseSeconds, setLease] = useState(300);
  const [group, setGroup] = useState<string>(),
    [tags, setTags] = useState<string[]>([]),
    [search, setSearch] = useState("");
  const filterId = useId();
  const [review, setReview] = useState<{
      plan: FleetPlan;
      input: FleetInput;
      leaseSeconds: number;
    } | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [dirty, setDirty] = useState(false);
  const directPending =
    action === "configure" &&
    !!pendingDeploymentId &&
    deploymentId === pendingDeploymentId;
  const pendingRef = useRef(pendingDeploymentId);
  pendingRef.current = pendingDeploymentId;
  const blocksConfigure = (input: FleetInput) =>
    input.action === "configure" &&
    !!pendingRef.current &&
    input.deploymentId === pendingRef.current;
  const revision = useRef(0);
  useEffect(() => {
    if (!directPending) return;
    revision.current++;
    setReview(null);
    setConfirmed(false);
  }, [directPending]);
  const feedbackId = useId();
  const form = useRef<HTMLDivElement>(null);
  const pendingStatus = useRef<HTMLDivElement>(null);
  const previewAction = useRef<HTMLButtonElement>(null);
  const createAction = useRef<HTMLButtonElement>(null);
  const focusBeforeCreate = useRef<HTMLElement | null>(null);
  const wasCreating = useRef(false);
  useUnsavedChanges(dirty);
  const touch = () => {
    revision.current++;
    setReview(null);
    setConfirmed(false);
    setDirty(true);
  };
  const deployment = inventory.deployments.find((d) => d.id === deploymentId);
  const instances = inventory.instances.filter((i) =>
    deployment?.ir.programs.some((p) => p.instance.id === i.id),
  );
  const visible = instances.filter((i) => {
    const host = inventory.hosts.find((h) => h.id === i.hostId);
    return (
      (!group || host?.group === group) &&
      tags.every((tag) => host?.tags?.includes(tag)) &&
      `${coreName(i)} ${host?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  const input = (): FleetInput => ({
    action,
    deploymentId,
    targetIds,
    stages: stagesFor(targetIds, effectiveAssignments),
    ...(canContinue ? { continuousService } : {}),
    ...(action === "rollback" ? { sourceBatchId } : {}),
    ...(lifecycle ? { targetReleaseId } : {}),
  });
  const inspect = useMutation({
    mutationFn: async () => {
      if (blocksConfigure(input()))
        throw new Error("此转发路径有提交结果待处理，请先确认该次提交结果。");
      if (strategyIssue) throw new Error(strategyIssue);
      const version = revision.current,
        body = input();
      if (!deploymentId) throw new Error("请选择保存的转发路径。");
      if (
        targetIds.some(
          (id) => !instances.some((instance) => instance.id === id),
        )
      )
        throw new Error("所选实例已不属于此转发路径，请重新选择执行范围。");
      if (lifecycle && !targetReleaseId)
        throw new Error("请选择目录中的目标核心版本。");
      if (action === "rollback" && !sourceBatchId)
        throw new Error("请选择要回退到的历史配置。");
      const plan = await post<FleetPlan>(`${base}/preview`, body);
      if (
        (plan.continuousService === true) !==
        (body.continuousService === true)
      )
        throw new Error("服务未确认所选的持续运行模式，请刷新后重新预览。");
      return { version, input: body, leaseSeconds, plan };
    },
    onSuccess: (value) => {
      if (value.version === revision.current && !blocksConfigure(value.input))
        setReview(value);
    },
  });
  const create = useMutation({
    mutationFn: () => {
      if (!review || blocksConfigure(review.input))
        throw new Error("此转发路径有提交结果待处理，请先确认该次提交结果。");
      return post<FleetBatch>(base, {
        ...review!.input,
        expectedFingerprint: review!.plan.fingerprint,
        leaseSeconds: review!.leaseSeconds,
      });
    },
    onSuccess: onCreated,
    onError: (error) => {
      if (error instanceof APIError && error.status === 409) {
        setReview(null);
        setConfirmed(false);
      }
    },
  });
  useLayoutEffect(() => {
    const status = pendingStatus.current;
    if (create.isPending && !wasCreating.current) {
      const owner = focusBeforeCreate.current;
      // Inert may already have moved the owning control's focus to BODY.
      // Never take focus from Close or another independently focused element.
      if (
        owner?.isConnected &&
        owner.closest("[inert]") === form.current &&
        (document.activeElement === owner ||
          document.activeElement === document.body)
      )
        status?.focus();
    } else if (
      !create.isPending &&
      wasCreating.current &&
      create.isError &&
      status &&
      document.activeElement === status
    ) {
      // A conflict removes the old review; the next valid action is Preview.
      const target = review ? createAction.current : previewAction.current;
      if (target?.isConnected && !target.disabled)
        target.focus({ preventScroll: true });
    }
    wasCreating.current = create.isPending;
    if (!create.isPending) focusBeforeCreate.current = null;
  }, [create.isPending, create.isError, review]);
  const { confirm: confirmDiscard } = useDiscardConfirmation("fleet-plan");
  const close = () => {
    if (create.isPending) return;
    if (!dirty) return onClose();
    confirmDiscard(
      {
        title: "放弃未创建的批量变更计划？",
        description: "当前计划尚未创建。",
        confirmLabel: "放弃计划",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  const createError = fleetCreateFeedback(create.error);
  const previewError = inspect.error || (!review ? createError : null);
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title={
        initialDeploymentId
          ? `${deployment?.name || initialDeploymentId} · ${initialAction ? fleetActionLabel[initialAction] : "计划变更"}`
          : "计划批量变更"
      }
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="xl"
    >
      <div ref={form} inert={create.isPending} className="space-y-5">
        {directPending && (
          <Notice
            tone="warning"
            title="此转发路径有提交结果待处理"
            action={
              <ActionButton variant="outline" asChild>
                <a href={`#routes?deployment=${deploymentId}`}>
                  确认该次提交结果
                </a>
              </ActionButton>
            }
          />
        )}
        <div className="form-grid grid gap-4 sm:grid-cols-2">
          {initialAction ? (
            <div className="standalone-label grid gap-2 text-sm font-medium">
              操作<strong>{fleetActionLabel[initialAction]}</strong>
            </div>
          ) : (
            <label className="standalone-label grid gap-2 text-sm font-medium">
              操作
              <ChoiceSelect
                aria-label="批量操作"
                value={action}
                options={Object.entries(fleetActionLabel).map(
                  ([value, label]) => ({
                    value,
                    label,
                    disabled:
                      value === "configure" &&
                      !!pendingDeploymentId &&
                      deploymentId === pendingDeploymentId,
                  }),
                )}
                onValueChange={(value) => {
                  touch();
                  setContinuousService(false);
                  if (value) setAction(value as FleetAction);
                }}
              />
            </label>
          )}
          {initialDeploymentId ? (
            <div className="standalone-label grid gap-2 text-sm font-medium">
              转发路径<strong>{deployment?.name || initialDeploymentId}</strong>
              <p className="muted text-sm text-muted-foreground">
                仅对这条路径中的所选实例计划变更，不会切换或合并其他路径。
              </p>
            </div>
          ) : (
            <label className="standalone-label grid gap-2 text-sm font-medium">
              已保存的转发路径
              <ChoiceSelect
                aria-label="批量变更转发路径"
                value={deploymentId || undefined}
                options={inventory.deployments.map((d) => ({
                  value: d.id,
                  label: d.name,
                }))}
                onValueChange={(value) => {
                  touch();
                  setContinuousService(false);
                  setDeployment(value ?? "");
                  setTargets([]);
                  setAssignments({});
                  setSource(undefined);
                }}
              />
            </label>
          )}
        </div>
        {lifecycle && (
          <QueryState
            loading={lifecycle && releases.isPending} paused={releases.isPaused} loadingLayout="form"
            error={releases.error}
            retry={() => releases.refetch()}
          >
            <label className="standalone-label grid gap-2 text-sm font-medium">
              目标核心版本
              <ChoiceSelect
                aria-label="目标核心版本"
                value={targetReleaseId}
                options={(releases.data || []).map((r) => ({
                  value: r.id,
                  label: `${r.adapterId.replace("routeweaver/", "")} ${r.version} · ${r.platform}`,
                }))}
                onValueChange={(value) => {
                  touch();
                  setRelease(value);
                }}
              />
            </label>
            <p className="muted text-sm text-muted-foreground">
              {action === "install"
                ? "准备固定版本文件，不启动或替换当前运行的核心。"
                : "升级到不同的明确版本，当前连接可能中断。预览会检查实例当前版本与兼容性。"}
            </p>
            {selectedRelease?.adapterId === "routeweaver/xray" &&
              selectedRelease.version === "26.10.31" && (
                <Notice tone="warning" role="note">
                  此版本默认阻止 VLESS、VMess、Trojan、Shadowsocks
                  访问内网目标。
                  依赖内网服务的旧路径可能中断，需先评审目标版本配置与迁移方案；旧版本不能直接保存网段例外。
                  它使用内置 CA，不能直接沿用自定义系统 CA 信任。
                </Notice>
              )}
            {selectedRelease && (
              <Accordion type="multiple" defaultValue={[]} className="w-full">
                {[
                  {
                    key: "release",
                    label:
                      "\u7248\u672C\u6765\u6E90\u4E0E\u6587\u4EF6\u6458\u8981",
                    children: (
                      <>
                        <p className="break-all">{selectedRelease.url}</p>
                        <p className="break-all font-mono text-xs">
                          归档 SHA-256：{selectedRelease.archiveSHA256}
                        </p>
                        <p className="break-all font-mono text-xs">
                          可执行文件 SHA-256：{selectedRelease.executableSHA256}
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
            )}
          </QueryState>
        )}
        {action === "rollback" && (
          <>
            <label className="standalone-label grid gap-2 text-sm font-medium">
              历史配置
              <ChoiceSelect
                aria-label="回退到历史配置"
                value={sourceBatchId}
                options={history
                  .filter(
                    (b) =>
                      b.deploymentId === deploymentId &&
                      b.action !== "stop" &&
                      b.action !== "install" &&
                      targetIds.every((id) =>
                        b.targets.some(
                          (t) =>
                            t.instanceId === id && t.status === "succeeded",
                        ),
                      ),
                  )
                  .map((b) => ({
                    value: b.id,
                    label: `${dateLabel(b.createdAt)} · ${fleetActionLabel[b.action]}`,
                  }))}
                onValueChange={(value) => {
                  touch();
                  setSource(value);
                }}
              />
            </label>
            <p className="muted text-sm text-muted-foreground">
              回退历史配置，不恢复历史账号授权、凭据或过期策略；当前权限会重新检查。
            </p>
          </>
        )}
        {canContinue && (
          <div className="space-y-2 rounded-lg border p-4">
            <label className="flex items-start gap-2 text-sm font-medium">
              <Checkbox
                checked={continuousService}
                onCheckedChange={(checked) => {
                  touch();
                  setContinuousService(checked === true);
                }}
              />
              持续运行并有限自动恢复
            </label>
            <p className="text-sm text-muted-foreground">
              仅在授权与配置仍有效时继续续期；确认核心退出后可有限重启。未勾选则只执行本次有时限的操作。
            </p>
          </div>
        )}
        {action === "stop" && (
          <Notice tone="warning" title="停止会中断经过这些实例的连接">
            {
              "停止操作会关闭这些实例的持续运行授权；线路在重新检查、执行启动并确认完成前不可用。"
            }
          </Notice>
        )}
        <Section
          title="选择执行范围"
          description="同一阶段一起提交，后续阶段必须等待前一阶段全部确认成功。"
        >
          <label className="standalone-label grid gap-2 text-sm font-medium">
            执行顺序
            <ChoiceSelect
              aria-label="执行顺序"
              value={strategy}
              options={[
                { value: "together", label: "一起执行 · 同时提交所选实例" },
                { value: "sequential", label: "逐个执行 · 每次确认一个实例" },
                { value: "canary", label: "先试一个 · 成功后执行其余实例" },
                { value: "custom", label: "自定义分组 · 为实例指定阶段" },
              ]}
              onValueChange={(value) => {
                touch();
                if (value === "custom") setAssignments(effectiveAssignments);
                if (value) setStrategy(value);
              }}
            />
          </label>
          <p className="muted text-sm text-muted-foreground">
            执行顺序按勾选顺序生成；下方显示每个实例所在阶段。创建计划后仍需确认执行。
          </p>
          {strategyIssue && <Notice tone="warning" title={strategyIssue} />}
          <ResourceToolbar label="筛选执行范围" search={
            <SearchField
              aria-label="筛选批量变更实例"
              placeholder="按服务器或实例名称筛选"
              value={search}
              onValueChange={setSearch}
            />
          } filters={<>
            <ToolbarFilter label="服务器分组" controlId={`${filterId}-group`}>
            <ChoiceSelect
              id={`${filterId}-group`}
              clearable
              aria-label="筛选服务器分组"
              placeholder="所有分组"
              value={group}
              options={[
                ...new Set(
                  inventory.hosts
                    .map((h) => h.group)
                    .filter((value): value is string => Boolean(value)),
                ),
              ].map((value) => ({ value, label: value }))}
              onValueChange={setGroup}
            />
            </ToolbarFilter>
            <ToolbarFilter label="服务器标签" controlId={`${filterId}-tags`}>
            <MultiChoice
              id={`${filterId}-tags`}
              aria-label="筛选服务器标签"
              placeholder="所有标签"
              value={tags}
              options={[
                ...new Set(inventory.hosts.flatMap((h) => h.tags || [])),
              ].map((value) => ({ value, label: value }))}
              onValueChange={setTags}
            />
            </ToolbarFilter>
          </>} />
          <div className={"flex flex-wrap items-center gap-2"}>
            <span>已选择 {targetIds.length} 个实例</span>
            <ActionButton
              disabled={!visible.length}
              onClick={() => {
                touch();
                setTargets([
                  ...new Set([...targetIds, ...visible.map((i) => i.id)]),
                ]);
              }}
              variant="outline"
              size="sm"
            >
              选择筛选结果
            </ActionButton>
            <ActionButton
              disabled={!targetIds.length}
              onClick={() => {
                touch();
                setTargets([]);
              }}
              variant="outline"
              size="sm"
            >
              清空选择
            </ActionButton>
          </div>
          <DataTable
            rowKey="id"
            rows={visible}
            minWidth={520}
            pageSize={8}
            columns={[
              {
                title: "选择",
                width: 60,
                render: (_, i) => (
                  <Checkbox
                    aria-label={`选择实例 ${coreName(i)}`}
                    checked={targetIds.includes(i.id)}
                    onCheckedChange={(checked) =>
                      ((e) => {
                        touch();
                        setTargets(
                          e.target.checked
                            ? [...targetIds, i.id]
                            : targetIds.filter((id) => id !== i.id),
                        );
                      })({ target: { checked: checked === true } })
                    }
                  />
                ),
              },
              {
                title: "实例 / 服务器",
                render: (_, i) => (
                  <>
                    <strong>{coreName(i)}</strong>
                    <p className="muted text-sm text-muted-foreground">
                      {inventory.hosts.find((h) => h.id === i.hostId)?.name} ·{" "}
                      {i.version}
                    </p>
                  </>
                ),
              },
              {
                title: "阶段",
                render: (_, i) =>
                  strategy !== "custom" ? (
                    targetIds.includes(i.id) ? (
                      `第 ${effectiveAssignments[i.id]} 阶段`
                    ) : (
                      "未选择"
                    )
                  ) : (
                    <Input
                      aria-label={`${coreName(i)} 的执行阶段`}
                      min={1}
                      max={20}
                      disabled={!targetIds.includes(i.id)}
                      value={assignments[i.id] || 1}
                      type="number"
                      onChange={(event) =>
                        ((value) => {
                          touch();
                          setAssignments({
                            ...assignments,
                            [i.id]: value || 1,
                          });
                        })(
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                        )
                      }
                    />
                  ),
              },
            ]}
          />
        </Section>
        <Accordion type="multiple" defaultValue={[]} className="w-full">
          {[
            {
              key: "policy",
              label: "\u6267\u884C\u7B56\u7565\u6709\u6548\u671F",
              children: (
                <label className="standalone-label grid gap-2 text-sm font-medium">
                  有效秒数
                  <Input
                    aria-label="批量变更策略有效秒数"
                    min={30}
                    max={3600}
                    value={leaseSeconds}
                    type="number"
                    onChange={(event) =>
                      ((value) => {
                        touch();
                        setLease(value || 300);
                      })(
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                      )
                    }
                  />
                  <span className="muted text-sm text-muted-foreground">
                    这是节点执行策略的短期授权，不改变用户服务到期时间。
                  </span>
                </label>
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
        <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
          <ActionButton onClick={close} variant="outline">
            取消
          </ActionButton>
          <ActionButton
            ref={previewAction}
            aria-label="预览影响与差异"
            aria-describedby={
              previewError ? `${feedbackId}-preview` : undefined
            }
            aria-busy={inspect.isPending}
            pending={inspect.isPending}
            disabled={
              directPending ||
              !deploymentId ||
              !targetIds.length ||
              !!strategyIssue
            }
            onClick={() => {
              create.reset();
              inspect.mutate();
            }}
            variant="default"
          >
            预览影响与差异
          </ActionButton>
        </div>
        {previewError && (
          <div id={`${feedbackId}-preview`}>
            <ErrorNotice error={previewError} />
          </div>
        )}
        {review && (
          <Section title="变更检查">
            <p>
              转发路径：{deployment?.name || review.input.deploymentId} ·{" "}
              {fleetActionLabel[review.input.action]}
            </p>
            <p>
              {review.plan.targets.length} 个实例 · {review.plan.affectedUsers}{" "}
              位用户受影响
            </p>
            <p>
              {action === "install"
                ? "只准备目标版本文件，不启动或替换当前运行的核心。"
                : action === "stop"
                  ? "所选核心将停止，经过它们的线路暂时不可用。"
                  : "所选核心将重启，现有连接可能中断；后续阶段等待前序成功。"}
            </p>
            {review.input.continuousService ? (
              <Notice tone="info" title="持续运行授权">
                {serviceConsequence(review.input)}
              </Notice>
            ) : (
              <p className="text-sm text-muted-foreground">
                {serviceConsequence(review.input)}
              </p>
            )}
            {review.plan.diagnostics?.map((d, i) => (
              <Notice key={i} tone="warning" title={d} />
            ))}
            <FleetTargets targets={review.plan.targets} />
            <label className="flex items-start gap-2 text-sm leading-relaxed">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) =>
                  ((e) => setConfirmed(e.target.checked))({
                    target: { checked: checked === true },
                  })
                }
              />
              我已核对实例、阶段与影响范围
            </label>
            <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
              <ActionButton
                disabled={directPending || !confirmed || !review.plan.supported}
                ref={createAction}
                aria-label="创建待执行批次"
                aria-describedby={
                  create.error ? `${feedbackId}-create` : undefined
                }
                aria-busy={create.isPending}
                pending={create.isPending}
                onClick={() => {
                  const focused = document.activeElement;
                  focusBeforeCreate.current =
                    focused instanceof HTMLElement &&
                    form.current?.contains(focused)
                      ? focused
                      : null;
                  create.mutate();
                }}
                variant="default"
              >
                创建待执行批次
              </ActionButton>
            </div>
            {create.error && (
              <div id={`${feedbackId}-create`}>
                <ErrorNotice error={createError} />
              </div>
            )}
            <p className="muted text-sm text-muted-foreground">
              创建计划不会执行。下一步逐阶段确认开始。
            </p>
          </Section>
        )}
      </div>
      <div
        ref={pendingStatus}
        role="status"
        aria-atomic="true"
        tabIndex={create.isPending ? 0 : -1}
        style={create.isPending ? { paddingBlock: 8 } : undefined}
      >
        {create.isPending && <p>正在创建待执行批次…</p>}
      </div>
    </TaskSheet>
  );
}
function FleetTargets({
  targets,
  selected,
  onSelect,
}: {
  targets: FleetTarget[];
  selected?: string[];
  onSelect?: (ids: string[]) => void;
}) {
  return (
    <DataTable
      rowKey="instanceId"
      rows={targets}
      minWidth={610}
      pageSize={0}
      expandedRow={(t) => (
        <div className="space-y-3 break-words text-sm">
          <p>受影响线路：{t.affectedRouteIds?.join("、") || "无"}</p>
          <p>变更文件：{t.changes?.join("、") || "无文件内容变化"}</p>
          {t.configDiff?.map((diff) => (
            <details
              key={diff.path}
              className="rounded-lg border bg-muted/20 p-3 [&_summary]:cursor-pointer [&_summary]:font-medium [&_summary]:break-all [&_summary]:mb-3"
            >
              <summary>{diff.path}</summary>
              <div className="form-grid grid gap-4 sm:grid-cols-2">
                <div>
                  <h4 className="text-sm font-medium">变更前</h4>
                  <CodePreview content={diff.before || "（无）"} />
                </div>
                <div>
                  <h4 className="text-sm font-medium">变更后</h4>
                  <CodePreview content={diff.after || "（移除）"} />
                </div>
              </div>
            </details>
          ))}
          {t.diagnostics?.map((d, i) => (
            <Notice key={i} tone="warning" title={d} />
          ))}
          {t.attempts?.map((a) => (
            <p key={a.number}>
              第 {a.number} 次 · {fleetStatus(a.status)} ·{" "}
              {fleetAttemptFeedback(a)} ·{" "}
              {dateLabel(a.observedAt || a.queuedAt)}
            </p>
          ))}
        </div>
      )}
      columns={[
        ...(onSelect
          ? [
              {
                title: "重试",
                width: 60,
                render: (_: unknown, t: FleetTarget) => (
                  <Checkbox
                    aria-label={`选择重试 ${t.name || t.instanceId}`}
                    checked={selected?.includes(t.instanceId)}
                    disabled={t.status !== "failed"}
                    onCheckedChange={(checked) =>
                      ((e) =>
                        onSelect(
                          e.target.checked
                            ? [...(selected || []), t.instanceId]
                            : (selected || []).filter(
                                (id) => id !== t.instanceId,
                              ),
                        ))({ target: { checked: checked === true } })
                    }
                  />
                ),
              },
            ]
          : []),
        {
          title: "实例",
          render: (_, t) => (
            <>
              <strong>{t.name || t.instanceId}</strong>
              <p className="muted text-sm text-muted-foreground">
                {t.adapterId?.replace("routeweaver/", "")}{" "}
                {t.currentVersion && t.currentVersion !== t.coreVersion
                  ? `${t.currentVersion} → ${t.coreVersion}`
                  : t.coreVersion}
              </p>
            </>
          ),
        },
        { title: "阶段", render: (_, t) => t.stage + 1 },
        { title: "影响用户", accessor: "affectedUsers" },
        {
          title: "状态",
          render: (_, t) => (
            <Badge variant="secondary">
              {t.supported ? fleetStatus(t.status) : "不支持此操作"}
            </Badge>
          ),
        },
      ]}
    />
  );
}
// Only queued/pending are evidence of a submitted operation. Keep terminal,
// unknown and future statuses distinct, including mixed stages.
function stageFeedback(targets: FleetTarget[]): string {
  if (targets.every((target) => target.status === "succeeded"))
    return "本阶段已完成";
  const messages: string[] = [];
  if (
    targets.some(
      (target) => !target.supported || target.status === "unsupported",
    )
  )
    messages.push("有实例不支持此操作，请查看目标详情。");
  if (targets.some((target) => target.status === "failed"))
    messages.push("有实例失败，请在上方选择失败目标后重试");
  if (targets.some((target) => target.status === "superseded"))
    messages.push("有实例已被后续变更替代，请核对当前配置。");
  if (targets.some((target) => target.status === "unknown"))
    messages.push("有实例结果未确认，请先查看实际运行状态。");
  if (
    targets.some(
      (target) =>
        ![
          "planned",
          "queued",
          "pending",
          "succeeded",
          "failed",
          "unsupported",
          "superseded",
          "unknown",
        ].includes(target.status),
    )
  )
    messages.push("有实例状态无法识别，请刷新进度并核对实际运行状态。");
  if (targets.some((target) => ["queued", "pending"].includes(target.status)))
    messages.push("有实例已提交，等待节点确认。");
  if (targets.some((target) => target.status === "planned"))
    messages.push(
      targets.every((target) => target.status === "planned") &&
        messages.length === 0
        ? "等待前序阶段全部确认成功后才能执行"
        : "仍有实例尚未执行。",
    );
  return messages.join(" ");
}

export function FleetBatchDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    confirm = useConfirm();
  const query = useQuery({
    queryKey: ["fleet-batch", id],
    queryFn: () => request<FleetBatch>(`${base}/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 5000 : false),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [operation, setOperation] = useState<{
    endpoint: string;
    body: {
      requestId: string;
      stage?: number;
      targetIds?: string[];
    };
  } | null>(null);
  const execute = useMutation({
    mutationFn: (op: NonNullable<typeof operation>) =>
      post<FleetBatch>(`${base}/${id}/${op.endpoint}`, op.body),
    onSuccess: (value) => {
      client.setQueryData(["fleet-batch", id], value);
      client.invalidateQueries({ queryKey: ["fleet-batches"] });
      client.invalidateQueries({ queryKey: ["instance-state"] });
      setSelected([]);
      setOperation(null);
    },
    onError: () => query.refetch(),
  });
  const batch = query.data;
  const begin = (stage?: number) => {
    const retry = stage === undefined;
    const targetIds = selected.filter((id) =>
      batch?.targets.some((t) => t.instanceId === id && t.status === "failed"),
    );
    const op = {
      endpoint: retry ? "retry" : "execute",
      body: {
        requestId: newID("fleet-request"),
        ...(retry ? { targetIds } : { stage }),
      },
    };
    confirm({
      title: retry
        ? `重试 ${targetIds.length} 个失败实例？`
        : `执行第 ${stage! + 1} 阶段？`,
      description:
        (batch?.action === "install"
          ? "只准备目标版本文件，不启动或替换当前核心。"
          : batch?.action === "stop"
            ? "所选实例将停止，相关连接会中断。"
            : "所选实例将重启并应用已检查的配置，当前连接可能中断。成功实例不会重复执行。") +
        (batch ? serviceConsequence(batch) : ""),
      confirmLabel: retry ? "确认重试" : "确认执行",
      cancelLabel: "取消",
      onConfirm: () => {
        setOperation(op);
        return execute.mutateAsync(op).catch(() => {});
      },
    });
  };
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title="批量变更进度"
      open
      onOpenChange={(next) => {
        if (!next)
          (() => {
            if (!execute.isPending) onClose();
          })();
      }}
      size="xl"
    >
      <ErrorNotice error={execute.error} />
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="summary"
        error={query.error}
        retry={() => query.refetch()}
      >
        {batch && (
          <>
            <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold tracking-tight">
                  {fleetActionLabel[batch.action]}
                </h2>
                <p>
                  {dateLabel(batch.createdAt)} · {batch.affectedUsers}{" "}
                  位用户受影响
                </p>
              </div>
              <Badge variant="secondary">{fleetStatus(batch.status)}</Badge>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {batch.continuousService
                ? "本批次包含持续运行授权。当前授权与恢复状态可在实例详情查看。"
                : "本批次不授予持续运行权限。"}
            </p>
            <FleetTargets
              targets={batch.targets}
              selected={selected}
              onSelect={setSelected}
            />
            <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
              <ActionButton onClick={() => query.refetch()} variant="outline">
                刷新进度
              </ActionButton>
              <ActionButton
                disabled={
                  !selected.some((id) =>
                    batch.targets.some(
                      (t) => t.instanceId === id && t.status === "failed",
                    ),
                  ) || execute.isPending
                }
                onClick={() => begin()}
                variant="outline"
              >
                重试所选失败目标
              </ActionButton>
            </div>
            {operation && execute.isError && (
              <ActionButton
                pending={execute.isPending}
                onClick={() => execute.mutate(operation)}
                variant="outline"
              >
                重新提交同一请求
              </ActionButton>
            )}
            <Section title="分阶段执行">
              <div className="stage-actions grid gap-3">
                {[...new Set(batch.targets.map((t) => t.stage))]
                  .sort((a, b) => a - b)
                  .map((stage) => {
                    const targets = batch.targets.filter(
                        (t) => t.stage === stage,
                      ),
                      ready =
                        targets.every(
                          (t) => t.supported && t.status === "planned",
                        ) &&
                        batch.targets
                          .filter((t) => t.stage < stage)
                          .every((t) => t.status === "succeeded");
                    return (
                      <div
                        className="subscription-row flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                        key={stage}
                      >
                        <div>
                          <strong>
                            第 {stage + 1} 阶段 · {targets.length} 个实例
                          </strong>
                          <p className="muted text-sm text-muted-foreground">
                            {
                              targets.filter((t) => t.status === "succeeded")
                                .length
                            }{" "}
                            个已确认完成
                          </p>
                          {!ready && (
                            <p className="muted text-sm text-muted-foreground">
                              {stageFeedback(targets)}
                            </p>
                          )}
                        </div>
                        <ActionButton
                          disabled={!ready || execute.isPending}
                          onClick={() => begin(stage)}
                          variant="default"
                        >
                          执行第 {stage + 1} 阶段
                        </ActionButton>
                      </div>
                    );
                  })}
              </div>
            </Section>
            <p className="muted text-sm text-muted-foreground">
              等待确认或结果不明的实例不会自动重试。请先查看对应实例的实际运行状态。
              <a
                href={`#routes?deployment=${encodeURIComponent(batch.deploymentId)}`}
              >
                查看路径与实例状态
              </a>
            </p>
          </>
        )}
      </QueryState>
    </TaskSheet>
  );
}
