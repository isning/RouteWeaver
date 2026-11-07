import {
  OperationalIntegerInput,
  operationalInteger,
} from "./OperationalIntegerInput";
import { ResourceToolbar, SearchField } from "@/ui-patterns/resource-toolbar";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ActionButton } from "@/ui-patterns/actions";
import { MultiChoice } from "@/ui-patterns/choice-select";
import { useConfirm } from "@/ui-patterns/confirmations";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesState,
  type Connection as FlowConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDown as ArrowDownOutlined,
  ArrowUp as ArrowUpOutlined,
  Trash2 as DeleteOutlined,
  Pencil as EditOutlined,
  Eye as EyeOutlined,
  MoreHorizontal,
  Plus as PlusOutlined,
  Save as SaveOutlined,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { toast } from "sonner";
import { APIError, list, request, saveRecord } from "./api";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { DataTable, TableRowActions } from "./DataTable";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { FleetBatchDetail, FleetPlanForm } from "./Fleet";
import {
  fleetActionLabel,
  type FleetAction,
  type FleetBatch,
} from "./fleet-model";
import { InstanceObservation } from "./Infrastructure";
import { coreName, loadInfrastructure } from "./infrastructure-data";
import {
  canEditLegacyPath,
  compilePath,
  normalizeDeployment,
  pathRewriteUnavailable,
} from "./infrastructure-model";
import { ListenerRefreshReview } from "./ListenerRefreshReview";
import { dateLabel, moveItem, newID, redact } from "./model";
import { useUnsavedChanges } from "./navigation";
import { publicationRejectionMessage } from "./publication-request";
import { routeGraphNodes, type RouteGraphNode } from "./route-graph-nodes";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import { ServerForwarding } from "./ServerForwarding";
import { TLSMaterial } from "./TLSMaterial";
import type {
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
  ServerProgram,
  ServerTLS,
  Validation,
} from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import type { PublicationOwner } from "./usePublicationRequest";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";
// Use the saved program identity, not newer inventory metadata. Stock SOCKS
// lacks Xray's default resolved-target guard and cannot expose allow exceptions.
const supportsDestinationExceptions = (program: ServerProgram) =>
  program.instance.adapterId === "routeweaver/managed-xray" ||
  (program.instance.adapterId === "routeweaver/xray" &&
    program.instance.version === "26.10.31" &&
    ["vless", "vmess", "trojan", "shadowsocks"].includes(
      program.listener.connection.protocol,
    ));

const newDeployment = (): ServerDeployment => {
  const id = newID("deployment");
  return {
    id,
    name: "",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id,
      topologyRevision: newID("topology"),
      programs: [],
    },
  };
};
export function ServerRoutesPage({
  publicationRequests,
}: {
  publicationRequests?: PublicationOwner;
} = {}) {
  const replaceView = useWorkspaceViewEntry((hash) => {
    const target = new URLSearchParams(hash.split("?")[1] || "").get(
      "deployment",
    );
    setEditing((current) => (current?.id === target ? current : null));
  });
  const viewHash = location.hash;
  const query = useQuery({
    queryKey: ["infrastructure"],
    queryFn: loadInfrastructure,
  });
  const [editing, setEditing] = useState<ServerDeployment | null>(null);
  const [selected, setSelected] = useState<ServerDeployment | null>(null);
  const [newRecord, setNewRecord] = useState(false);
  const [search, setSearch] = useState("");
  const [planning, setPlanning] = useState<{
    deploymentId: string;
    action?: FleetAction;
  } | null>(null);
  const [returnContext, setReturnContext] = useState(
    () => new URLSearchParams(location.hash.split("?")[1] || ""),
  );
  const [task, setTask] = useState<string | null>(null);
  const [taskDeployment, setTaskDeployment] = useState<string>();
  const tasks = useQuery({
    queryKey: ["fleet-batches"],
    queryFn: () => list<FleetBatch>("/admin/fleet-batches"),
    enabled: !!planning,
  });
  const plan = (id: string, action?: FleetAction) => {
    if (
      action === "configure" &&
      publicationRequests?.pendingDeploymentId === id
    )
      return;
    setSelected(null);
    setPlanning({ deploymentId: id, action });
  };
  const [editError, setEditError] = useState<Error | null>(null);
  const editSequence = useRef(0);
  const [refreshEndpoint, setRefreshEndpoint] = useState<string>();
  const edit = async (value?: ServerDeployment, endpointId?: string) => {
    const sequence = ++editSequence.current;
    setEditError(null);
    try {
      const full = value
        ? normalizeDeployment(
            await request<ServerDeployment>(
              `/server-deployments/${value.id}/reveal`,
            ),
          )
        : newDeployment();
      if (sequence !== editSequence.current) return;
      setEditing(full);
      setRefreshEndpoint(endpointId);
      setNewRecord(!value);
      setSelected(null);
    } catch (error) {
      if (sequence === editSequence.current) setEditError(error as Error);
    }
  };
  const [requestedDeployment, setRequestedDeployment] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] || "").get("deployment"),
  );
  useEffect(() => {
    const changed = () => {
      const target = new URLSearchParams(location.hash.split("?")[1] || "").get(
        "deployment",
      );
      setSelected((current) => (current?.id === target ? current : null));
      setReturnContext(new URLSearchParams(location.hash.split("?")[1] || ""));
      setRequestedDeployment(
        new URLSearchParams(location.hash.split("?")[1] || "").get(
          "deployment",
        ),
      );
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    // Keep the latest destination pending until Save/Close resolves the editor.
    // A hash change must never stack a detail drawer over an active draft.
    if (
      editing ||
      planning ||
      task ||
      !requestedDeployment ||
      !query.data ||
      query.isFetching
    )
      return;
    const deployment = query.data.deployments.find(
      (d) => d.id === requestedDeployment,
    );
    if (deployment) setSelected(deployment);
    else setEditError(new Error("找不到指定的转发路径，请从列表中选择。"));
    setRequestedDeployment(null);
  }, [
    editing,
    planning,
    task,
    requestedDeployment,
    query.data,
    query.isFetching,
  ]);
  const inventory = query.data;
  const returnHref = returnContext.get("line")
    ? `#published-routes?line=${encodeURIComponent(returnContext.get("line")!)}${returnContext.get("user") ? `&user=${encodeURIComponent(returnContext.get("user")!)}` : ""}`
    : undefined;
  return (
    <>
      <PageHeader
        title="转发路径"
        action={
          <ActionButton
            leadingIcon={<PlusOutlined aria-hidden="true" />}
            onClick={() => edit()}
            variant="default"
          >
            新建转发路径
          </ActionButton>
        }
      />
      <ErrorNotice error={editError} />
      {!selected && !editing && !planning && !task && (
        <PublicationNotice
          owner={publicationRequests}
          targetName={
            inventory?.deployments.find(
              (d) => d.id === publicationRequests?.envelope?.deploymentId,
            )?.name
          }
        />
      )}
      {returnHref && (
        <p>
          <a href={returnHref}>返回原线路开通进度</a>
          <span className="mt-1 block">
            当前处理转发路径，线路与所选用户会保留。
          </span>
        </p>
      )}
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        {inventory && (
          <Section variant="plain">
            <ResourceToolbar
              label="查找转发路径"
              search={
                <SearchField
                  placeholder="搜索转发路径"
                  aria-label="搜索转发路径"
                  value={search}
                  onValueChange={setSearch}
                  type="search"
                />
              }
            />
            {inventory.deployments.length ? (
              <DataTable
                rowKey="id"
                rows={inventory.deployments.filter((d) =>
                  d.name.toLowerCase().includes(search.toLowerCase()),
                )}
                count={{ total: inventory.deployments.length, unit: "条转发路径", filtered: !!search }}
                minWidth={690}
                columns={[
                  {
                    title: "转发路径",
                    render: (_, d) => (
                      <button
                        className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setSelected(d)}
                      >
                        {d.name}
                      </button>
                    ),
                  },
                  {
                    title: "监听与转发",
                    className: "min-w-48",
                    render: (_, d) => (
                      <ServerForwarding
                        programs={d.ir.programs}
                        inventory={inventory}
                        compact
                      />
                    ),
                  },
                  {
                    title: "目标实例",
                    render: (_, d) => `${d.ir.programs.length} 个`,
                  },
                  {
                    title: "配置草稿",
                    render: (_, d) => (
                      <Badge variant="secondary">
                        {d.diagnostics?.length ? "需要调整" : "已保存"}
                      </Badge>
                    ),
                  },
                  {
                    title: "修改时间",
                    render: (_, d) => dateLabel(d.updatedAt),
                  },
                  {
                    title: "操作",
                    align: "right",
                    render: (_, d) => (
                      <TableRowActions name={d.name}>
                        <ActionButton
                          aria-label={`编辑转发路径 ${d.name}`}
                          onClick={() => edit(d)}
                          variant="ghost"
                          size="sm"
                        >
                          编辑
                        </ActionButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <ActionButton
                              aria-label={`更多转发路径操作 ${d.name}`}
                              variant="ghost"
                              size="icon-sm"
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </ActionButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => plan(d.id)}>
                              批量操作
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableRowActions>
                    ),
                  },
                ]}
              />
            ) : (
              <EmptyState
                title="暂无服务器转发路径"
                action={
                  <ActionButton onClick={() => edit()} variant="default">
                    新建转发路径
                  </ActionButton>
                }
              />
            )}
          </Section>
        )}
      </QueryState>
      {inventory && editing && (
        <ServerRouteEditor
          initial={editing}
          initialRefreshEndpoint={refreshEndpoint}
          inventory={inventory}
          isNew={newRecord}
          onClose={() => setEditing(null)}
          onSaved={(value) =>
            replaceView(viewHash, () => {
              setEditing(null);
              setSelected(value);
            })
          }
        />
      )}
      {inventory && selected && (
        <ServerRouteDetail
          key={`${selected.id}:${selected.revisionToken || "unreviewed"}`}
          deployment={selected}
          publicationRequests={publicationRequests}
          inventory={inventory}
          onReload={setSelected}
          onClose={() => {
            setSelected(null);
            const context = new URLSearchParams(
              location.hash.split("?")[1] || "",
            );
            if (context.get("deployment") === selected.id) {
              context.delete("deployment");
              replaceView(`#routes${context.size ? `?${context}` : ""}`);
            }
          }}
          onEdit={(endpointId) => edit(selected, endpointId)}
          onPlan={(action) => plan(selected.id, action)}
          returnHref={returnHref}
        />
      )}
      {inventory && planning && (
        <QueryState
          loading={!!planning && tasks.isPending}
          paused={tasks.isPaused}
          loadingLayout="table"
          error={tasks.error}
          retry={() => tasks.refetch()}
        >
          {tasks.data && (
            <FleetPlanForm
              key={`${planning.deploymentId}:${planning.action || "choose"}`}
              inventory={inventory}
              pendingDeploymentId={publicationRequests?.pendingDeploymentId}
              history={tasks.data}
              initialDeploymentId={planning.deploymentId}
              initialAction={planning.action}
              onClose={() => {
                setSelected(
                  inventory.deployments.find(
                    (item) => item.id === planning.deploymentId,
                  ) || null,
                );
                setPlanning(null);
              }}
              onCreated={(batch) => {
                setTaskDeployment(planning.deploymentId);
                setPlanning(null);
                setTask(batch.id);
                tasks.refetch();
              }}
            />
          )}
        </QueryState>
      )}
      {task && (
        <FleetBatchDetail
          id={task}
          onClose={() => {
            setTask(null);
            setSelected(
              inventory?.deployments.find(
                (item) => item.id === taskDeployment,
              ) || null,
            );
          }}
        />
      )}
    </>
  );
}
function ServerRouteEditor({
  initial,
  initialRefreshEndpoint,
  inventory,
  isNew,
  onClose,
  onSaved,
}: {
  initial: ServerDeployment;
  initialRefreshEndpoint?: string;
  inventory: Infrastructure;
  isNew: boolean;
  onClose: () => void;
  onSaved: (d: ServerDeployment) => boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const materialGenerations = useRef<Record<string, number>>({});
  const pendingMaterials = useRef(new Set<string>());
  const [materialPending, setMaterialPending] = useState(false);
  const markMaterialPending = (id: string, pending: boolean) => {
    if (pending) pendingMaterials.current.add(id);
    else pendingMaterials.current.delete(id);
    setMaterialPending(pendingMaterials.current.size > 0);
  };
  const invalidateMaterial = (id: string) => {
    materialGenerations.current[id] = (materialGenerations.current[id] || 0) + 1;
    markMaterialPending(id, false);
  };
  const { confirm: confirmDiscard, confirming: discardConfirming } =
    useDiscardConfirmation(initial.id);
  const [discardClosing, setDiscardClosing] = useState(false);
  const [refreshingListener, setRefreshingListener] = useState(
    initialRefreshEndpoint,
  );
  const [pendingEndpoints, setPendingEndpoints] = useState<
    Record<string, boolean>
  >({});
  const markPending = (key: string, pending: boolean) =>
    setPendingEndpoints((previous) =>
      previous[key] === pending ? previous : { ...previous, [key]: pending },
    );
  const draftRevision = useRef(0);
  const [pathLoading, setPathLoading] = useState(false);
  const [view, setView] = useState("ordered");
  const [error, setError] = useState<Error | null>(null);
  const [dirty, setDirty] = useState(false);
  const [graphNodes, setGraphNodes, onGraphNodesChange] =
    useNodesState<RouteGraphNode>([]);
  const [announcement, setAnnouncement] = useState("");
  const [jsonOpen, setJSONOpen] = useState(false);
  const [json, setJSON] = useState("");
  const [jsonBaseline, setJSONBaseline] = useState("");
  const jsonDirty = jsonOpen && json !== jsonBaseline;
  const message = toast,
    confirm = useConfirm();
  const client = useQueryClient();
  const path = useMemo(
    () => draft.ir.programs.map((p) => p.listener.id),
    [draft.ir.programs],
  );
  useEffect(() => {
    setGraphNodes((previous) => routeGraphNodes(inventory, path, previous));
  }, [inventory, path, setGraphNodes]);
  const selectionPending =
    path.some((id) => pendingEndpoints[id]) ||
    pendingEndpoints[`add-${path.join("/")}`];
  useUnsavedChanges(dirty || selectionPending || materialPending || jsonDirty);
  const save = useMutation({
    mutationFn: (_complete: typeof onSaved) => {
      if (pendingMaterials.current.size)
        throw new Error("请等待 TLS 文件读取完成，或取消读取后再保存。");
      return saveRecord<ServerDeployment>("server-deployments", latestDraft.current, isNew);
    },
    onSuccess: (value, complete) => {
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      if (complete(value)) message.success("转发路径草稿已保存");
    },
    onError: setError,
  });
  const update = (next: ServerDeployment) => {
    draftRevision.current++;
    setPathLoading(false);
    latestDraft.current = next;
    setDraft(next);
    setDirty(true);
    setError(null);
  };
  const chainEditable = canEditLegacyPath(draft, inventory);
  const updatePath = async (ids: string[]) => {
    if (!chainEditable) {
      setError(new Error(pathRewriteUnavailable));
      return;
    }
    const revision = ++draftRevision.current;
    setPathLoading(true);
    setError(null);
    try {
      // Summary records never carry usable credentials. Reveal only explicitly selected path endpoints.
      const endpoints = await Promise.all(
        ids.map((id) =>
          request<ManagedEndpoint>(`/managed-endpoints/${id}/reveal`),
        ),
      );
      if (revision !== draftRevision.current) return;
      const revealed = new Map(
        endpoints.map((endpoint) => [endpoint.id, endpoint]),
      );
      const next = compilePath(draft, ids, {
        ...inventory,
        endpoints: inventory.endpoints.map(
          (endpoint) => revealed.get(endpoint.id) || endpoint,
        ),
      });
      next.ir.topologyRevision = newID("topology");
      update(next);
      setAnnouncement(
        `路径已更新：${next.ir.programs.map((p) => p.listener.name).join("，然后到")}`,
      );
    } catch (e) {
      if (revision === draftRevision.current) {
        setError(e as Error);
        setPathLoading(false);
      }
    }
  };
  const updateProgram = (index: number, patch: Partial<ServerProgram>) =>
    update({
      ...draft,
      ir: {
        ...draft.ir,
        topologyRevision: newID("topology"),
        programs: draft.ir.programs.map((p, i) =>
          i === index ? { ...p, ...patch } : p,
        ),
      },
    });
  const updateReality = (
    index: number,
    patch: Partial<NonNullable<ServerTLS["reality"]>>,
  ) => {
    const program = draft.ir.programs[index];
    const existing = program.tls?.reality;
    const clientTLS = program.listener.connection.tls;
    updateProgram(index, {
      tls: {
        ...program.tls,
        reality: {
          privateKey: existing?.privateKey ?? "",
          handshakeServer:
            existing?.handshakeServer ?? clientTLS?.serverName ?? "",
          handshakePort: existing?.handshakePort ?? 443,
          shortIds: existing?.shortIds?.length
            ? existing.shortIds
            : [clientTLS?.reality?.shortId ?? ""],
          serverNames: existing?.serverNames?.length
            ? existing.serverNames
            : [clientTLS?.serverName ?? ""],
          ...patch,
        },
      },
    });
  };
  const editIntent = () => {
    const text = JSON.stringify(draft.ir, null, 2);
    setJSON(text);
    setJSONBaseline(text);
    setJSONOpen(true);
  };
  const closeJSON = () => {
    const discard = () => {
      setJSON(jsonBaseline);
      setJSONOpen(false);
    };
    if (!jsonDirty) return discard();
    confirm({
      title: "放弃尚未应用的 JSON 修改？",
      description: "仅放弃 JSON 文本修改，保留之前的转发路径草稿。",
      confirmLabel: "放弃 JSON 修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: discard,
    });
  };
  const close = () =>
    dirty || selectionPending || materialPending || jsonDirty
      ? confirm({
          title: "放弃尚未保存的转发路径修改？",
          description: "保留已保存的配置。",
          confirmLabel: "放弃修改",
          cancelLabel: "继续编辑",
          destructive: true,
          onConfirm: onClose,
        })
      : onClose();
  const connect = (connection: FlowConnection) => {
    if (!connection.source || !connection.target) return;
    if (path.length && path.at(-1) !== connection.source) {
      setError(new Error("请从当前路径的出口连接到下一跳。"));
      return;
    }
    updatePath(
      path.length
        ? [...path, connection.target]
        : [connection.source, connection.target],
    );
  };
  const graphEdges = path.slice(1).map((id, index) => ({
    id: `${path[index]}-${id}`,
    source: path[index],
    target: id,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#267a5a" },
    style: { stroke: "#267a5a", strokeWidth: 2.5 },
  }));
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title={isNew ? "新建转发路径" : `编辑 ${initial.name}`}
      open={!discardClosing}
      onOpenChange={(next) => {
        if (!next)
          (() => {
            if (!save.isPending) close();
          })();
      }}
      onReady={() =>
        ((visible) => {
          if (!visible && discardClosing) onClose();
        })(true)
      }
      onClosed={() => {
        ((visible) => {
          if (!visible && discardClosing) onClose();
        })(false);
      }}
      size="xl"
      pending={!!discardConfirming}
      footer={
        <ActionButton
          leadingIcon={<SaveOutlined aria-hidden="true" />}
          pending={save.isPending}
          disabled={
            !draft.name.trim() ||
            pathLoading ||
            selectionPending ||
            materialPending ||
            jsonDirty ||
            (save.error instanceof APIError && save.error.status === 409)
          }
          onClick={() => save.mutate(onSaved)}
          variant="default"
        >
          保存草稿
        </ActionButton>
      }
    >
      <div inert={save.isPending} className="space-y-5">
        <ErrorNotice error={error} />
        {save.error instanceof APIError && save.error.status === 409 && (
          <Notice
            tone="warning"
            title="转发路径已被其他修改更新。当前输入保留，但不能覆盖新版本。"
            action={
              <ActionButton
                onClick={() =>
                  confirmDiscard(
                    {
                      title: "放弃当前修改并返回？",
                      description: "重新打开编辑时会读取完整的新版本。",
                      confirmLabel: "放弃修改并返回",
                      cancelLabel: "保留当前输入",
                    },
                    async (stillCurrent) => {
                      await client.invalidateQueries({
                        queryKey: ["infrastructure"],
                      });
                      if (stillCurrent()) setDiscardClosing(true);
                    },
                  )
                }
                variant="outline"
              >
                放弃修改并返回
              </ActionButton>
            }
          />
        )}
        {pathLoading && (
          <p role="status" className="muted text-sm text-muted-foreground">
            正在读取所选端点的完整连接设置…
          </p>
        )}
        <label className="standalone-label grid gap-2 text-sm font-medium">
          转发路径名称
          <Input
            aria-label="转发路径名称"
            value={draft.name}
            onChange={(e) => update({ ...draft, name: e.target.value })}
            placeholder="例如：FRA → 英国"
          />
        </label>
        <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              {chainEditable ? "入口与出口" : "监听与转发"}
            </h2>
            {chainEditable && (
              <p className="mt-1 text-sm text-muted-foreground">
                按入口、中转、出口的顺序选择服务器与端点。
              </p>
            )}
          </div>
          {chainEditable && (
            <Tabs
              value={view}
              onValueChange={(next) => {
                setPendingEndpoints({});
                setView(next);
              }}
              defaultValue={"ordered"}
              className="w-full space-y-4"
            >
              <TabsList className="h-auto max-w-full flex-wrap">
                <TabsTrigger key={"ordered"} value={"ordered"}>
                  {"\u987A\u5E8F\u7F16\u8F91"}
                </TabsTrigger>
                <TabsTrigger key={"graph"} value={"graph"}>
                  {"\u56FE\u5F62\u7F16\u8F91"}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
        {!chainEditable ? (
          <div className="server-policy-edit space-y-3 rounded-lg border p-4">
            <p>当前转发由各监听的规则和默认去向决定。</p>
            <ActionButton onClick={editIntent} variant="outline">
              编辑转发设置
            </ActionButton>
          </div>
        ) : view === "graph" ? (
          <>
            <div className="graph-canvas h-[480px] min-h-80 overflow-hidden rounded-lg border bg-muted/20">
              <ReactFlow
                nodes={graphNodes}
                edges={graphEdges}
                onConnect={connect}
                onNodeClick={(_, node) => {
                  if (!path.length) updatePath([node.id]);
                }}
                onNodesChange={onGraphNodesChange}
                fitView
                deleteKeyCode={null}
                minZoom={0.25}
                maxZoom={1.7}
              >
                <Background gap={23} color="#d8e2d1" />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
            <p className="muted text-sm text-muted-foreground mt-3">
              点击端点选择入口，从路径末端连接下一跳。拖动只调整图形布局。
            </p>
          </>
        ) : (
          <div className="ordered-path space-y-3">
            {draft.ir.programs.map((p, index) => (
              <div
                key={p.listener.id}
                className="hop-row grid min-w-0 gap-3 rounded-lg border p-4 [&_.server-endpoint-select]:w-full [&_.server-endpoint-select]:min-w-0"
              >
                <span className="hop-position inline-flex w-fit items-center rounded-md bg-muted px-2 py-1 text-xs font-medium">
                  {index === 0
                    ? "入口"
                    : index === path.length - 1
                      ? "出口"
                      : `中转 ${index}`}
                </span>
                <ServerEndpointSelect
                  inventory={inventory}
                  label={`第 ${index + 1} 跳`}
                  unavailableReason="不可选端点的核心已在路径中使用；请选择其他核心的端点。"
                  value={p.listener.id}
                  current={{ endpoint: p.listener, hostId: p.instance.hostId }}
                  displayCurrentSnapshot
                  allowedIds={inventory.endpoints
                    .filter(
                      (e) =>
                        e.id === p.listener.id ||
                        !draft.ir.programs.some(
                          (other, i) =>
                            i !== index && other.instance.id === e.instanceId,
                        ),
                    )
                    .map((e) => e.id)}
                  onPendingChange={(pending) =>
                    markPending(p.listener.id, pending)
                  }
                  onChange={(id) =>
                    updatePath(path.map((v, i) => (i === index ? id : v)))
                  }
                />
                <div
                  className="flex flex-wrap items-center justify-end gap-2"
                  role="group"
                  aria-label={`第 ${index + 1} 跳顺序操作`}
                >
                  <ActionButton
                    aria-label={`上移第 ${index + 1} 跳`}
                    leadingIcon={<ArrowUpOutlined aria-hidden="true" />}
                    disabled={index === 0}
                    onClick={() => updatePath(moveItem(path, index, index - 1))}
                    variant="ghost"
                  />
                  <ActionButton
                    aria-label={`下移第 ${index + 1} 跳`}
                    leadingIcon={<ArrowDownOutlined aria-hidden="true" />}
                    disabled={index === path.length - 1}
                    onClick={() => updatePath(moveItem(path, index, index + 1))}
                    variant="ghost"
                  />
                  <ActionButton
                    aria-label={`移除第 ${index + 1} 跳`}
                    leadingIcon={<DeleteOutlined aria-hidden="true" />}
                    onClick={() =>
                      updatePath(path.filter((_, i) => i !== index))
                    }
                    variant="ghost"
                  />
                </div>
              </div>
            ))}
            <div className="add-hop flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-4">
              <ServerEndpointSelect
                key={path.join("/")}
                inventory={inventory}
                label={path.length ? "下一跳" : "入口"}
                unavailableReason="不可选端点的核心已在路径中使用；请选择其他核心的端点。"
                allowedIds={inventory.endpoints
                  .filter(
                    (e) =>
                      !draft.ir.programs.some(
                        (p) => p.instance.id === e.instanceId,
                      ),
                  )
                  .map((e) => e.id)}
                onPendingChange={(pending) =>
                  markPending(`add-${path.join("/")}`, pending)
                }
                onChange={(id) => updatePath([...path, id])}
              />
            </div>
            {!inventory.endpoints.length && (
              <p className="muted text-sm text-muted-foreground">
                先在「服务器」中配置监听端点，再编排路径。
              </p>
            )}
          </div>
        )}
        {draft.ir.programs.length > 0 && (
          <div className="settings-section space-y-5 rounded-xl border bg-card p-5">
            {chainEditable && (
              <h2 className="text-base font-semibold tracking-tight">
                监听转发
              </h2>
            )}
            <ServerForwarding
              programs={draft.ir.programs}
              inventory={inventory}
              onRefreshListener={setRefreshingListener}
            />
          </div>
        )}
        <Accordion type="multiple" defaultValue={[]} className="w-full">
          {[
            {
              key: "tls",
              label: "TLS \u8BC1\u4E66\u4E0E\u5B89\u5168\u53C2\u6570",
              children: draft.ir.programs.some(
                (p) => p.listener.connection.tls?.enabled,
              ) ? (
                draft.ir.programs.map(
                  (p, index) =>
                    p.listener.connection.tls?.enabled && (
                      <div
                        key={p.listener.id}
                        className="settings-section space-y-5 rounded-xl border bg-card p-5"
                      >
                        <h3 className="text-sm font-semibold">
                          {p.listener.name}
                        </h3>
                        {!p.listener.connection.tls?.reality && (
                          <>
                            <div className="form-grid grid gap-4 sm:grid-cols-2 mt-4">
                              <label>
                                证书文件路径
                                <Input
                                  value={p.tls?.certificatePath}
                                  placeholder="certs/server.crt"
                                  onChange={(e) =>
                                    updateProgram(index, {
                                      tls: {
                                        ...p.tls,
                                        certificatePath: e.target.value,
                                      },
                                    })
                                  }
                                />
                              </label>
                              <label>
                                私钥文件路径
                                <Input
                                  value={p.tls?.keyPath}
                                  placeholder="certs/server.key"
                                  onChange={(e) =>
                                    updateProgram(index, {
                                      tls: {
                                        ...p.tls,
                                        keyPath: e.target.value,
                                      },
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <TLSMaterial
                              key={`${p.listener.id}:${materialGenerations.current[p.listener.id] || 0}`}
                              value={p.tls || {}}
                              onPendingChange={(pending) => markMaterialPending(p.listener.id, pending)}
                              onChange={(tls) => {
                                const current = latestDraft.current;
                                if (!current.ir.programs.some((program) => program.listener.id === p.listener.id)) return;
                                update({
                                  ...current,
                                  ir: {
                                    ...current.ir,
                                    topologyRevision: newID("topology"),
                                    programs: current.ir.programs.map((program) =>
                                      program.listener.id === p.listener.id ? { ...program, tls } : program,
                                    ),
                                  },
                                });
                              }}
                            />
                            <p className="muted text-sm text-muted-foreground">
                              文件路径相对于此次配置包，仅使用包内文件。
                            </p>
                          </>
                        )}
                        {p.listener.connection.tls?.reality && (
                          <div className="form-grid grid gap-4 sm:grid-cols-2 mt-4">
                            <label>
                              REALITY 服务端私钥
                              <Input
                                value={p.tls?.reality?.privateKey}
                                onChange={(e) =>
                                  updateReality(index, {
                                    privateKey: e.target.value,
                                  })
                                }
                                type="password"
                              />
                            </label>
                            <label>
                              握手目标
                              <Input
                                value={p.tls?.reality?.handshakeServer}
                                onChange={(e) =>
                                  updateReality(index, {
                                    handshakeServer: e.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    ),
                )
              ) : (
                <p className="muted text-sm text-muted-foreground">
                  当前端点未启用 TLS。可在「服务器 →
                  监听端点」中设置连接安全参数。
                </p>
              ),
            },
            {
              key: "destinations",
              label:
                "\u9AD8\u7EA7\uFF1A\u5185\u90E8\u76EE\u6807\u8BBF\u95EE\u4F8B\u5916",
              children: (
                <>
                  {draft.ir.programs.some(supportsDestinationExceptions) && (
                    <p className="muted text-sm text-muted-foreground">
                      仅为确实需要提供的内部服务添加明确网段；留空保留默认限制。修改后需重新应用。
                    </p>
                  )}
                  {draft.ir.programs.some(supportsDestinationExceptions) ? (
                    draft.ir.programs.map(
                      (p, index) =>
                        supportsDestinationExceptions(p) && (
                          <label
                            key={p.listener.id}
                            className="standalone-label grid gap-2 text-sm font-medium"
                          >
                            {p.listener.name}允许访问的内部网段
                            <span className="text-muted-foreground text-xs font-normal">
                              {p.instance.adapterId === "routeweaver/xray"
                                ? "用于 Xray 直接出站的目标；中转连接保留原设置。"
                                : "用于受管入口的用户目标；中转连接保留原设置。"}
                            </span>
                            <MultiChoice
                              aria-label={`${p.listener.name}允许访问的内部网段`}
                              options={[]}
                              value={p.destinationPolicy?.allowCidrs || []}
                              placeholder="例如 10.20.0.0/16，默认不允许"
                              onValueChange={(allowCidrs) =>
                                updateProgram(index, {
                                  destinationPolicy: allowCidrs.length
                                    ? { allowCidrs }
                                    : undefined,
                                })
                              }
                              creatable
                            />
                          </label>
                        ),
                    )
                  ) : (
                    <p className="muted text-sm text-muted-foreground">
                      当前路径没有支持目标访问例外的入口。
                    </p>
                  )}
                </>
              ),
            },
            {
              key: "native",
              label:
                "\u9AD8\u7EA7\uFF1A\u5B8C\u6574\u670D\u52A1\u7AEF\u610F\u56FE",
              children: (
                <>
                  <p className="muted text-sm text-muted-foreground">
                    编辑命名连接器、服务器规则与资源。服务器意图独立于个人客户端配置。
                  </p>
                  <ActionButton onClick={editIntent} variant="outline">
                    编辑服务端意图
                  </ActionButton>
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
      </div>
      {refreshingListener && (
        <ListenerRefreshReview
          draft={draft}
          inventory={inventory}
          endpointId={refreshingListener}
          getRevision={() => draftRevision.current}
          onClose={() => setRefreshingListener(undefined)}
          onApply={(next, revision) => {
            if (revision !== draftRevision.current) return false;
            invalidateMaterial(refreshingListener);
            update({
              ...next,
              ir: { ...next.ir, topologyRevision: newID("topology") },
            });
            setRefreshingListener(undefined);
            setAnnouncement("监听设置已更新到草稿，尚未保存。");
            return true;
          }}
        />
      )}
      <TaskDialog
        bodyProps={{ className: "space-y-5" }}
        title="服务端配置意图"
        open={jsonOpen}
        onOpenChange={(next) => {
          if (!next) closeJSON();
        }}
        size="lg"
        contentProps={{ onFocusCapture: revealFocusedPolicyModalControl }}
        footer={
          <>
            <ActionButton variant="outline" onClick={closeJSON}>
              {"\u53D6\u6D88"}
            </ActionButton>
            <ActionButton
              onClick={() => {
                try {
                  const ir = JSON.parse(json);
                  if (!Array.isArray(ir.programs))
                    throw new Error("\u7F3A\u5C11 programs \u6570\u7EC4");
                  draft.ir.programs.forEach((program) => invalidateMaterial(program.listener.id));
                  update({ ...draft, ir });
                  setJSONBaseline(json);
                  setJSONOpen(false);
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              {"\u5E94\u7528\u5230\u8349\u7A3F"}
            </ActionButton>
          </>
        }
      >
        <p className="muted text-sm text-muted-foreground">
          先应用到草稿，再保存草稿；取消时可选择放弃本次 JSON 修改。
        </p>
        <Textarea
          className="json-editor min-h-64 font-mono text-xs"
          rows={22}
          aria-label="服务端配置意图 JSON 文本"
          value={json}
          onChange={(e) => setJSON(e.target.value)}
          spellCheck={false}
        />
      </TaskDialog>
    </TaskSheet>
  );
}
const managedPrincipalsRequired =
  "MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required";

function hasManagedEntrySetupGap(
  diagnostics: string[],
  programs: ServerProgram[],
) {
  // This exact diagnostic can also mean a non-VLESS listener. Limit recovery to
  // the verified first-use shape; it says nothing about existing account grants
  // or whether this saved snapshot is still current.
  const program = programs.length === 1 ? programs[0] : undefined;
  return (
    diagnostics.includes(managedPrincipalsRequired) &&
    program?.instance.adapterId === "routeweaver/managed-xray" &&
    program.instance.version === "26.3.27-rw1" &&
    program.listener.authentication === "principals" &&
    program.listener.connection.protocol === "vless" &&
    !program.principals?.length
  );
}

function ServerRouteDiagnostics({
  diagnostics,
  programs,
  managedEntry,
  type = "warning",
}: {
  diagnostics: string[];
  programs: ServerProgram[];
  managedEntry?: { deploymentName: string; href: string };
  type?: "warning" | "error";
}) {
  const onlyEntrySetup =
    !!managedEntry &&
    diagnostics.every((item) => item === managedPrincipalsRequired);
  return (
    <Notice
      tone={type}
      title={onlyEntrySetup ? "草稿缺少可用用户入口" : "草稿需要调整"}
    >
      {
        <>
          <p>
            {onlyEntrySetup
              ? "草稿已保存，当前不能应用。"
              : "当前草稿不能应用。请先修复问题，再重新检查。"}
          </p>
          {!onlyEntrySetup && (
            <ul>
              {diagnostics.map((diagnostic, index) => {
                if (managedEntry && diagnostic === managedPrincipalsRequired)
                  return <li key={index}>草稿缺少可用用户入口。</li>;
                // Other diagnostics retain their existing field-path handling;
                // never infer a cause from similar English text or a code prefix.
                const tls = /^programs\[(\d+)\]\.tls:/.exec(diagnostic);
                const program = tls ? programs[Number(tls[1])] : undefined;
                return (
                  <li key={index}>
                    {program && tls
                      ? `第 ${Number(tls[1]) + 1} 段（${program.listener.name}）的 TLS 设置未通过检查。请编辑转发路径，检查「TLS 证书与安全参数」。`
                      : diagnostic}
                  </li>
                );
              })}
            </ul>
          )}
          {managedEntry && (
            <div className="space-y-2">
              <p>
                在线路页选择使用「{managedEntry.deploymentName}」的公开线路；若还没有，先配置公开线路。
              </p>
              <p>
                在线路详情中选择用户，核对「用户授权」和「独立入口与运行确认」。按需准备入口后，返回重新检查。
              </p>
              {!onlyEntrySetup && (
                <ActionButton variant="outline" asChild>
                  <a href={managedEntry.href}>前往线路</a>
                </ActionButton>
              )}
            </div>
          )}
          {diagnostics.length > 0 && (
            <Accordion type="multiple" defaultValue={[]} className="w-full">
              {[
                {
                  key: "diagnostics",
                  label: "\u6280\u672F\u8BE6\u60C5",
                  children: (
                    <ul>
                      {diagnostics.map((diagnostic, index) => (
                        <li key={index}>{diagnostic}</li>
                      ))}
                    </ul>
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
          )}
        </>
      }
    </Notice>
  );
}
function serverInventoryMismatch(error: unknown, deployment: ServerDeployment) {
  const mismatch =
    error instanceof APIError && error.status === 422
      ? (error.details as
          | {
              code?: string;
              endpointId?: string;
              instanceId?: string;
            }
          | undefined)
      : undefined;
  if (
    mismatch?.code === "SERVER_LISTENER_CHANGED" &&
    deployment.ir.programs.some((p) => p.listener.id === mismatch.endpointId)
  )
    return { kind: "listener" as const, endpointId: mismatch.endpointId };
  if (
    mismatch?.code === "SERVER_INSTANCE_CHANGED" &&
    deployment.ir.programs.some((p) => p.instance.id === mismatch.instanceId)
  )
    return { kind: "instance" as const };
  return undefined;
}
function ServerInventoryNotice({
  error,
  deployment,
  onEdit,
}: {
  error: Error | null | undefined;
  deployment: ServerDeployment;
  onEdit: (endpointId?: string) => void;
}) {
  const mismatch = serverInventoryMismatch(error, deployment);
  if (mismatch?.kind === "listener")
    return (
      <Notice
        tone="warning"
        title="监听设置已变化，草稿尚未更新"
        action={
          <ActionButton
            onClick={() => onEdit(mismatch.endpointId)}
            variant="outline"
          >
            查看监听更新
          </ActionButton>
        }
      >
        {
          "\u5148\u6BD4\u8F83\u5F53\u524D\u76D1\u542C\u4E0E\u8349\u7A3F\u4E2D\u7684\u8BBE\u7F6E\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u66F4\u65B0\u3002"
        }
      </Notice>
    );
  if (mismatch?.kind === "instance")
    return (
      <Notice
        tone="warning"
        title="核心实例设置已变化"
        action={
          <ActionButton onClick={() => onEdit()} variant="outline">
            编辑并核对
          </ActionButton>
        }
      >
        {"请先核对核心实例；更新监听时保留实例设置。"}
      </Notice>
    );
  return <ErrorNotice error={error} />;
}
function PublicationNotice({
  owner,
  onReload,
  onDismiss,
  targetName,
  recoveryRef,
}: {
  recoveryRef?: Ref<HTMLButtonElement>;
  owner?: PublicationOwner;
  targetName?: string;
  onReload?: () => void;
  onDismiss?: () => void;
}) {
  const result = owner?.result;
  useEffect(() => {
    const acknowledgeVisible = () => {
      if (
        document.visibilityState === "visible" &&
        result &&
        owner?.available &&
        !owner.cleared &&
        !owner.cleanupError
      )
        owner.acknowledgeDisplayed();
    };
    acknowledgeVisible();
    document.addEventListener("visibilitychange", acknowledgeVisible);
    return () =>
      document.removeEventListener("visibilitychange", acknowledgeVisible);
  }, [result, owner?.cleared, owner?.cleanupError, owner?.available]);
  if (!owner) return null;
  if (!owner.envelope)
    return owner.error ? (
      <Notice
        tone="warning"
        title={owner.error}
        action={
          !owner.storageReady && (
            <ActionButton
              disabled={!owner.available}
              onClick={owner.retryStorage}
              variant="outline"
            >
              重新读取本页记录
            </ActionButton>
          )
        }
      />
    ) : null;
  const accepted = result?.status === "publication-accepted";
  return (
    <section aria-label="该次提交" className="mb-5">
      <p>
        目标转发路径：
        <strong>{targetName || owner.envelope.deploymentId}</strong>
      </p>
      <Notice
        tone={result ? (accepted ? "info" : "warning") : "warning"}
        title={
          result
            ? accepted
              ? "该次提交已接收"
              : "该次提交未被接收"
            : "提交结果待确认"
        }
      >
        {result
          ? accepted
            ? "提交已接收，实际应用结果请查看实例状态。"
            : publicationRejectionMessage(result.detail)
          : "关闭仅退出当前页面；返回后可继续核对本次提交的结果。"}
      </Notice>
      {owner.error &&
        owner.error !== "提交结果尚未确认，请核对该次提交记录。" && (
          <p role="status">{owner.error}</p>
        )}
      {owner.cleanupError && (
        <p role="status">结果已确认，但本页恢复记录尚未清理。</p>
      )}
      <div className={"flex flex-wrap items-center gap-2"}>
        {!result && (
          <ActionButton
            className="min-h-11"
            ref={recoveryRef}
            aria-label="查询提交结果"
            aria-busy={owner.busy}
            disabled={!owner.available || owner.busy}
            onClick={() => void owner.reconcile()}
            variant={owner.absent ? "outline" : "default"}
          >
            查询提交结果
          </ActionButton>
        )}
        {!result && owner.absent && (
          <ActionButton
            className="min-h-11"
            disabled={!owner.available || owner.busy}
            onClick={() => void owner.resend()}
            variant="default"
          >
            恢复本次提交
          </ActionButton>
        )}
        {!result && owner.absent && (
          <span>使用原请求及其标识恢复本次提交。</span>
        )}
        {result?.status === "definitively-rejected" && onReload && (
          <ActionButton
            className="min-h-11"
            disabled={!owner.available || !owner.cleared}
            onClick={onReload}
            variant="default"
          >
            重新载入转发路径
          </ActionButton>
        )}
        {result?.status === "definitively-rejected" && owner.cleared && (
          <ActionButton
            className="min-h-11"
            disabled={!owner.available}
            onClick={() => {
              if (owner.dismissRejected()) onDismiss?.();
            }}
            variant={onReload ? "outline" : "default"}
          >
            关闭结果
          </ActionButton>
        )}
        {owner.cleanupError && (
          <ActionButton
            className="min-h-11"
            disabled={!owner.available}
            onClick={owner.acknowledgeDisplayed}
            variant="outline"
          >
            清理本页记录
          </ActionButton>
        )}
        {!onReload && (
          <ActionButton className="min-h-11" variant="outline" asChild>
            <a
              href={`#routes?deployment=${encodeURIComponent(owner.envelope.deploymentId)}`}
            >
              继续处理该转发路径
            </a>
          </ActionButton>
        )}
      </div>
    </section>
  );
}
function ServerRouteDetail({
  deployment,
  publicationRequests,
  inventory,
  onClose,
  onEdit,
  onPlan,
  onReload,
  returnHref,
}: {
  deployment: ServerDeployment;
  publicationRequests?: PublicationOwner;
  inventory: Infrastructure;
  onClose: () => void;
  onEdit: (endpointId?: string) => void;
  onPlan: (action?: FleetAction) => void;
  onReload: (deployment: ServerDeployment) => void;
  returnHref?: string;
}) {
  const [review, setReview] = useState(false);
  const recoveryAction = useRef<HTMLButtonElement>(null);
  const reviewSurface = useRef<HTMLDivElement>(null);
  const closeRecovery = useRef<{
    actorId: string;
    deploymentId: string;
    operationId: string;
    focus: Element | null;
  } | null>(null);
  const currentReviewOwner = useRef({
    review,
    deploymentId: deployment.id,
    publicationRequests,
  });
  currentReviewOwner.current = {
    review,
    deploymentId: deployment.id,
    publicationRequests,
  };
  const closeReview = () => {
    const owner = publicationRequests,
      envelope = owner?.envelope;
    const focus = document.activeElement;
    closeRecovery.current =
      owner?.available &&
      !owner.result &&
      envelope?.deploymentId === deployment.id &&
      reviewSurface.current?.contains(focus)
        ? {
            actorId: envelope.actorId,
            deploymentId: envelope.deploymentId,
            operationId: envelope.operationId,
            focus,
          }
        : null;
    setReview(false);
  };
  const restoreReviewFocus = () => {
    const closing = closeRecovery.current;
    closeRecovery.current = null;
    const current = currentReviewOwner.current,
      owner = current.publicationRequests,
      envelope = owner?.envelope;
    const target = recoveryAction.current,
      active = document.activeElement;
    if (
      !closing ||
      !mounted.current ||
      current.review ||
      current.deploymentId !== closing.deploymentId ||
      !owner?.available ||
      owner.result ||
      envelope?.actorId !== closing.actorId ||
      envelope.deploymentId !== closing.deploymentId ||
      envelope.operationId !== closing.operationId ||
      document.visibilityState !== "visible" ||
      !document.hasFocus() ||
      !target?.isConnected ||
      target.disabled ||
      target.getClientRects().length === 0 ||
      (active !== closing.focus && active !== document.body)
    )
      return;
    target.focus({ preventScroll: true });
  };
  type OpenedDraft = {
    id: string;
    revisionToken: string;
  };
  const [checked, setCheck] = useState<(Validation & OpenedDraft) | null>(null);
  const opened = useRef({
    id: deployment.id,
    revisionToken: deployment.revisionToken || "",
  });
  opened.current = {
    id: deployment.id,
    revisionToken: deployment.revisionToken || "",
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = (value: OpenedDraft) =>
    value.id === opened.current.id &&
    value.revisionToken === opened.current.revisionToken;
  const check = checked && isCurrent(checked) ? checked : null;
  const [lease, setLease] = useState<number | string>(300);
  const [allow, setAllow] = useState(false);
  const [quota, setQuota] = useState(false);
  const diagnostics = check?.diagnostics ?? deployment.diagnostics ?? [];
  const needsAdjustment = check ? !check.valid : diagnostics.length > 0;
  const managedEntry = hasManagedEntrySetupGap(
    diagnostics,
    deployment.ir.programs,
  )
    ? { deploymentName: deployment.name, href: returnHref || "#published-routes" }
    : undefined;
  const onlyEntrySetup =
    !!managedEntry &&
    diagnostics.every((item) => item === managedPrincipalsRequired);
  const client = useQueryClient();
  const draftChanged = (error: unknown) =>
    error instanceof APIError &&
    error.status === 409 &&
    (
      error.details as
        | {
            code?: string;
          }
        | undefined
    )?.code === "SERVER_DRAFT_CHANGED";
  const staleError = () =>
    new APIError("转发路径已变化，请重新载入并检查。", 409, {
      code: "SERVER_DRAFT_CHANGED",
    });
  const reload = useMutation({
    mutationFn: async () => {
      const visible = { ...opened.current };
      const rejectedOperation = publicationRequests?.envelope?.operationId;
      const value = await request<ServerDeployment>(
        `/server-deployments/${deployment.id}`,
      );
      if (value.id !== deployment.id || !value.revisionToken)
        throw new Error("无法取得完整转发路径，请重试。");
      return { value: normalizeDeployment(value), visible, rejectedOperation };
    },
    onSuccess: ({ value, visible, rejectedOperation }) => {
      if (!mounted.current || !isCurrent(visible)) return;
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      publicationRequests?.finishRejectedReload(value.id, rejectedOperation);
      onReload(value);
    },
  });
  const validate = useMutation({
    mutationFn: (visible: OpenedDraft) => {
      if (!visible.revisionToken) throw staleError();
      return request<Validation>(`/server-deployments/${visible.id}/validate`, {
        method: "POST",
        headers: { "If-Match": visible.revisionToken },
        body: "{}",
      });
    },
    onSuccess: (value, visible) => {
      if (!isCurrent(visible)) return;
      setCheck({ ...value, ...visible });
      setReview(true);
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (!check || !isCurrent(check)) throw staleError();
      if (!publicationRequests?.available)
        throw new Error("请先确认当前管理员身份，再提交修改。");
      const parsedLease = operationalInteger(lease, 30, 3600);
      if (parsedLease === undefined)
        throw new Error("权限有效期须为 30–3600 的整数秒，且不能留空。");
      await publicationRequests.start(deployment.id, {
        leaseSeconds: parsedLease,
        accessAllowed: allow,
        quotaCertain: quota,
        expectedFingerprint: check.fingerprint || "",
      });
    },
    onError: (error) => {
      if (draftChanged(error)) {
        setCheck(null);
        setAllow(false);
        setQuota(false);
      }
    },
  });
  const receipt =
    publicationRequests?.envelope?.deploymentId === deployment.id
      ? publicationRequests.result
      : null;
  useEffect(() => {
    if (!receipt) return;
    setCheck(null);
    setAllow(false);
    setQuota(false);
    setReview(false);
    if (receipt.status === "publication-accepted")
      client.invalidateQueries({ queryKey: ["instance-state"] });
  }, [receipt]);
  const acceptedCurrentSubmission =
    receipt?.status === "publication-accepted" &&
    publicationRequests?.cleared &&
    !publicationRequests.cleanupError;
  const resetDismissedReview = () => {
    setCheck(null);
    setAllow(false);
    setQuota(false);
    setReview(false);
    validate.reset();
    publish.reset();
  };
  const publicationBlocked =
    !publicationRequests?.available ||
    publicationRequests.blocked ||
    publicationRequests.result?.status === "definitively-rejected";
  const recoverInventory = (endpointId?: string) => {
    setReview(false);
    setCheck(null);
    setAllow(false);
    setQuota(false);
    publish.reset();
    validate.reset();
    onEdit(endpointId);
  };
  const staleReview =
    draftChanged(validate.error) || draftChanged(publish.error);
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title={deployment.name}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      footer={
        <div className={"flex flex-wrap items-center gap-2"}>
          {returnHref && (
            <ActionButton variant="outline" asChild>
              <a href={returnHref}>返回线路</a>
            </ActionButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ActionButton variant="outline">实例操作</ActionButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {Object.entries(fleetActionLabel).map(([key, label]) => (
                <DropdownMenuItem
                  key={key}
                  disabled={
                    key === "configure" &&
                    publicationRequests?.pendingDeploymentId === deployment.id
                  }
                  onSelect={() => onPlan(key as FleetAction)}
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ActionButton
            leadingIcon={<EditOutlined aria-hidden="true" />}
            onClick={() => onEdit()}
            variant="outline"
          >
            编辑转发路径
          </ActionButton>
        </div>
      }
    >
      <ServerForwarding
        programs={deployment.ir.programs}
        inventory={inventory}
      />
      <div className="deployment-actions flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <p className="muted text-sm text-muted-foreground">
          草稿更新于 {dateLabel(deployment.updatedAt)}
        </p>
        <div className={"flex flex-wrap items-center gap-2"}>
          <ActionButton
            leadingIcon={<EyeOutlined aria-hidden="true" />}
            disabled={
              staleReview ||
              reload.isPending ||
              !!publicationRequests?.blocked ||
              publicationRequests?.result?.status === "definitively-rejected"
            }
            pending={validate.isPending}
            onClick={() => {
              publish.reset();
              reload.reset();
              setCheck(null);
              setReview(false);
              setAllow(false);
              setQuota(false);
              validate.mutate({
                id: deployment.id,
                revisionToken: deployment.revisionToken || "",
              });
            }}
            variant={
              needsAdjustment || staleReview || acceptedCurrentSubmission
                ? "outline"
                : "default"
            }
          >
            {needsAdjustment
              ? "重新检查"
              : acceptedCurrentSubmission
                ? "再次检查并应用"
                : "查看修改并应用"}
          </ActionButton>
          {needsAdjustment &&
            (onlyEntrySetup && managedEntry ? (
              <ActionButton variant="default" asChild>
                <a href={managedEntry.href}>前往线路</a>
              </ActionButton>
            ) : (
              <ActionButton onClick={() => onEdit()} variant="default">
                编辑并修复
              </ActionButton>
            ))}
          <ActionButton
            disabled={
              publicationRequests?.pendingDeploymentId === deployment.id
            }
            onClick={() => onPlan("configure")}
            variant="outline"
          >
            分阶段应用修改
          </ActionButton>
        </div>
      </div>
      {staleReview && !review ? (
        <Notice
          className="server-review-notice my-4"
          tone="warning"
          title="转发路径已变化"
          action={
            <ActionButton
              pending={reload.isPending}
              onClick={() => reload.mutate()}
              variant="default"
            >
              重新载入转发路径
            </ActionButton>
          }
        >
          {
            "\u5F53\u524D\u4ECD\u663E\u793A\u65E7\u8DEF\u5F84\u3002\u91CD\u65B0\u8F7D\u5165\u540E\u518D\u6B21\u68C0\u67E5\u3002"
          }
        </Notice>
      ) : (
        <ServerInventoryNotice
          error={validate.error}
          deployment={deployment}
          onEdit={recoverInventory}
        />
      )}
      {!review && <ErrorNotice error={reload.error} />}
      {!review && (
        <PublicationNotice
          recoveryRef={recoveryAction}
          owner={publicationRequests}
          onDismiss={resetDismissedReview}
          targetName={
            inventory.deployments.find(
              (d) => d.id === publicationRequests?.envelope?.deploymentId,
            )?.name
          }
          onReload={
            publicationRequests?.envelope?.deploymentId === deployment.id
              ? () => reload.mutate()
              : undefined
          }
        />
      )}
      {needsAdjustment && (
        <ServerRouteDiagnostics
          diagnostics={diagnostics}
          programs={deployment.ir.programs}
          managedEntry={managedEntry}
        />
      )}
      <Section title="目标实例" description="运行结果由对应 Agent 回传。">
        {deployment.ir.programs.map((p) => (
          <div
            className="target-status flex items-center gap-2"
            key={p.instance.id}
          >
            <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
              <h3 className="text-sm font-semibold">
                <span className="block">
                  {
                    inventory.hosts.find((h) => h.id === p.instance.hostId)
                      ?.name
                  }
                </span>
                <span className="mt-1 block text-muted-foreground font-normal">
                  {coreName(p.instance)}
                </span>
              </h3>
              <span className="muted text-sm text-muted-foreground">
                {p.listener.name}
              </span>
            </div>
            <InstanceObservation instanceId={p.instance.id} />
          </div>
        ))}
      </Section>
      <TaskDialog
        bodyProps={{ className: "space-y-5" }}
        title="应用转发路径修改"
        open={review}
        footer={
          check && !check.valid ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              <ActionButton onClick={() => setReview(false)} variant="outline">
                返回
              </ActionButton>
              {onlyEntrySetup && managedEntry ? (
                <ActionButton variant="default" asChild>
                  <a href={managedEntry.href}>前往线路</a>
                </ActionButton>
              ) : (
                <ActionButton onClick={() => onEdit()} variant="default">
                  编辑并修复
                </ActionButton>
              )}
            </div>
          ) : check?.valid && !publicationRequests?.blocked ? (
            <div className="w-full space-y-3">
              <div className="space-y-1 text-sm leading-relaxed">
                <p>
                  <strong className="font-medium">
                    将更新 {deployment.ir.programs.length} 个核心实例
                  </strong>
                  。已有连接可能中断；应用后会分别核对实际状态。
                </p>
                <p className="text-muted-foreground">
                  权限有效期 {lease} 秒；到期后需重新确认权限才能继续运行。
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-start gap-2 text-sm leading-relaxed">
                  <Checkbox
                    checked={allow}
                    onCheckedChange={(checked) =>
                      ((e) => setAllow(e.target.checked))({
                        target: { checked: checked === true },
                      })
                    }
                  />
                  确认允许此转发路径提供访问
                </label>
                <label className="flex items-start gap-2 text-sm leading-relaxed">
                  <Checkbox
                    checked={quota}
                    onCheckedChange={(checked) =>
                      ((e) => setQuota(e.target.checked))({
                        target: { checked: checked === true },
                      })
                    }
                  />
                  已确认目标实例可执行当前额度策略
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <ActionButton
                  onClick={() => setReview(false)}
                  variant="outline"
                >
                  返回
                </ActionButton>
                <ActionButton
                  disabled={
                    publicationBlocked ||
                    !check.valid ||
                    !check.fingerprint ||
                    !allow ||
                    !quota
                  }
                  pending={publish.isPending}
                  onClick={() => publish.mutate()}
                  variant="default"
                >
                  确认并应用
                </ActionButton>
              </div>
            </div>
          ) : null
        }
        onOpenChange={(next) => {
          if (!next) closeReview();
        }}
        onClosed={() => {
          restoreReviewFocus();
        }}
        size="lg"
        contentRef={reviewSurface}
      >
        {review && (
          <PublicationNotice
            owner={publicationRequests}
            onDismiss={resetDismissedReview}
            targetName={
              inventory.deployments.find(
                (d) => d.id === publicationRequests?.envelope?.deploymentId,
              )?.name
            }
            onReload={
              publicationRequests?.envelope?.deploymentId === deployment.id
                ? () => reload.mutate()
                : undefined
            }
          />
        )}
        {!publicationRequests?.available && (
          <Notice
            tone="warning"
            title="当前管理员身份尚未确认，暂不能提交修改。"
          />
        )}
        {draftChanged(publish.error) ? (
          <Notice
            className="server-review-notice my-4"
            tone="warning"
            title="转发路径已变化"
            action={
              <ActionButton
                pending={reload.isPending}
                onClick={() => reload.mutate()}
                variant="default"
              >
                重新载入转发路径
              </ActionButton>
            }
          >
            {
              "\u6B64\u6B21\u4FEE\u6539\u672A\u63D0\u4EA4\u7ED9\u5B9E\u4F8B\u3002\u91CD\u65B0\u8F7D\u5165\u540E\u518D\u6B21\u68C0\u67E5\u3002"
            }
          </Notice>
        ) : (
          <ServerInventoryNotice
            error={publish.error}
            deployment={deployment}
            onEdit={recoverInventory}
          />
        )}
        <ErrorNotice error={reload.error} />
        {check && !check.valid && (
          <>
            <ServerRouteDiagnostics
              diagnostics={check.diagnostics}
              programs={deployment.ir.programs}
              managedEntry={managedEntry}
              type="error"
            />
          </>
        )}
        {check?.valid && !publicationRequests?.blocked && (
          <>
            <section aria-label="待应用转发" className="my-6">
              <h3 className="text-sm font-semibold">待应用转发</h3>
              <ServerForwarding
                programs={deployment.ir.programs}
                inventory={inventory}
              />
            </section>
            <Accordion type="multiple" defaultValue={[]} className="w-full">
              {[
                {
                  key: "policy",
                  label:
                    "\u65AD\u8054\u65F6\u7684\u6709\u6548\u671F\u4E0E\u751F\u6210\u6587\u4EF6",
                  children: (
                    <>
                      <label className="standalone-label grid gap-2 text-sm font-medium">
                        权限有效期（秒）
                        <OperationalIntegerInput
                          min={30}
                          max={3600}
                          value={lease}
                          onInputText={(raw) => {
                            setLease(raw);
                            setAllow(false);
                            setQuota(false);
                          }}
                        />
                      </label>
                      {check.artifacts.map((a) => (
                        <div key={a.path}>
                          <h4 className="text-sm font-medium">{a.path}</h4>
                          <CodePreview content={redact(a.content)} />
                        </div>
                      ))}
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
        )}
      </TaskDialog>
    </TaskSheet>
  );
}
