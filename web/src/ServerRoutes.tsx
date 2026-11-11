import { addServerConnector, connectorAddReason, removeServerConnector } from "./server-connector-collection";
import { ServerConnectorConnectionDialog } from "./ServerConnectorConnectionDialog";
import { PolicyUserEntryTask, type PolicyUserEntryTaskProps } from "./PolicyUserEntryTask";
import { connectorInputError } from "./server-connector-editor";
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
  Pencil as EditOutlined,
  Eye as EyeOutlined,
  MoreHorizontal,
  Plus as PlusOutlined,
  Save as SaveOutlined,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
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
import { dateLabel, newID, redact } from "./model";
import { useUnsavedChanges } from "./navigation";
import { publicationRejectionMessage } from "./publication-request";
import { routeGraphNodes, type RouteGraphNode } from "./route-graph-nodes";
import { ServerPathSummary, ServerPathWorkspace } from "./ServerPathWorkspace";
import { ServerMixedPathWorkspace } from "./ServerMixedPathWorkspace";
import { compileOrderedServerPath, orderedPathChangeReason, readOrderedServerPath, type OrderedServerHop } from "./server-path-model";
import { ServerForwarding, matchLabel } from "./ServerForwarding";
import { ServerPolicyEditor, canEditRuleList, canEditRuleCondition, ruleConditionError, programEditReason } from "./ServerPolicyEditor";
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
    const context = new URLSearchParams(hash.split("?")[1] || "");
    const target = context.get("deployment");
    editSequence.current++;
    setEntryLoading(false);
    setEntryRetry(null);
    setRequestedEntry(context.has("entryEndpoint") ? hash : null);
    setEditing((current) => (current?.id === target ? current : null));
  });
  const viewHash = location.hash;
  const query = useQuery({
    queryKey: ["infrastructure"],
    queryFn: loadInfrastructure,
  });
  const inventoryClient = useQueryClient();
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
    editSequence.current++;
    setEntryLoading(false);
    setEntryRetry(null);
    setSelected(null);
    setPlanning({ deploymentId: id, action });
  };
  const [editError, setEditError] = useState<Error | null>(null);
  const editSequence = useRef(0);
  const [refreshEndpoint, setRefreshEndpoint] = useState<string>();
  const [requestedEntry, setRequestedEntry] = useState<string | null>(() =>
    new URLSearchParams(location.hash.split("?")[1] || "").has("entryEndpoint")
      ? location.hash : null,
  );
  const [entryLoading, setEntryLoading] = useState(false);
  const [entryRetry, setEntryRetry] = useState<string | null>(null);
  useEffect(() => () => { editSequence.current++; }, []);
  const edit = async (value?: ServerDeployment, endpointId?: string) => {
    const sequence = ++editSequence.current;
    setEntryLoading(false);
    setEntryRetry(null);
    setRequestedEntry(null);
    setEditError(null);
    try {
      // Editing owns the revealed intent verbatim. View normalization would
      // silently replace absent/null policy collections before the first edit.
      const full = value
        ? await request<ServerDeployment>(`/server-deployments/${value.id}/reveal`)
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
      const context = new URLSearchParams(location.hash.split("?")[1] || "");
      editSequence.current++;
      setEntryLoading(false);
      setEntryRetry(null);
      setRequestedEntry(context.has("entryEndpoint") ? location.hash : null);
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
      requestedEntry !== null ||
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
    requestedEntry,
    query.data,
    query.isFetching,
  ]);
  useEffect(() => {
    if (requestedEntry === null || editing || selected || planning || task ||
        !query.data || !query.isSuccess || query.isFetching || query.isPaused || query.isError) return;
    const origin = requestedEntry;
    setRequestedEntry(null);
    if (location.hash !== origin) return;
    const context = new URLSearchParams(origin.split("?")[1] || "");
    const ids = context.getAll("entryEndpoint");
    const endpoint = ids.length === 1 && ids[0]
      ? query.data.endpoints.find((candidate) => candidate.id === ids[0]) : undefined;
    const instance = query.data.instances.find((candidate) => candidate.id === endpoint?.instanceId);
    const host = query.data.hosts.find((candidate) => candidate.id === instance?.hostId);
    if (context.has("deployment") || !endpoint || !instance || !host) {
      setRequestedDeployment(null);
      setEditError(new Error("找不到指定的入口监听，请返回服务器选择当前可用的端点。"));
      return;
    }
    if (context.getAll("returnHost").length > 1 || context.getAll("returnInstance").length > 1 ||
        (context.has("returnHost") && context.get("returnHost") !== host.id) ||
        (context.has("returnInstance") && context.get("returnInstance") !== instance.id)) {
      setEditError(new Error("入口监听与原服务器不一致，请返回服务器重新选择。"));
      return;
    }
    const sequence = ++editSequence.current;
    setEntryLoading(true);
    setEntryRetry(null);
    setEditError(null);
    void (async () => {
      try {
        // A contextual link identifies one endpoint; it never authorizes saving,
        // publishing, refreshing another listener, or adopting summary secrets.
        const revealed = await request<ManagedEndpoint>(`/managed-endpoints/${encodeURIComponent(endpoint.id)}/reveal`);
        if (sequence !== editSequence.current || location.hash !== origin) return;
        if (revealed.id !== endpoint.id || revealed.instanceId !== instance.id)
          throw new Error("入口监听的所属核心已变化，请返回服务器重新选择。");
        // Query notifications can arrive after this response. Read the current
        // cache, not the last render, before adopting the endpoint's owner.
        const current = inventoryClient.getQueryState<Infrastructure>(["infrastructure"]);
        if (current?.status !== "success" || current.fetchStatus !== "idle" || !current.data)
          throw new Error("服务器清单尚未确认，请重新读取入口。");
        const registered = current.data.endpoints.find((candidate) => candidate.id === endpoint.id);
        const owner = current.data.instances.find((candidate) => candidate.id === instance.id);
        if (!owner || registered?.instanceId !== instance.id || owner.hostId !== host.id ||
            owner.adapterId !== instance.adapterId || owner.version !== instance.version ||
            !current.data.hosts.some((candidate) => candidate.id === host.id))
          throw new Error("入口监听的所属核心已变化，请返回服务器重新选择。");
        const next = compilePath(newDeployment(), [endpoint.id], {
          ...current.data,
          endpoints: current.data.endpoints.map((candidate) => candidate.id === endpoint.id ? revealed : candidate),
        });
        const completed = replaceView(origin, () => {
          setNewRecord(true);
          setRefreshEndpoint(undefined);
          setSelected(null);
          setEditing(next);
        });
        if (!completed && sequence === editSequence.current && location.hash === origin)
          setEntryRetry(origin);
      } catch (error) {
        if (sequence === editSequence.current && location.hash === origin) {
          setEditError(error as Error);
          setEntryRetry(origin);
        }
      } finally {
        if (sequence === editSequence.current) setEntryLoading(false);
      }
    })();
  }, [requestedEntry, editing, selected, planning, task, query.data, query.isSuccess, query.isFetching, query.isPaused, query.isError, inventoryClient]);
  const inventory = query.data;
  const returnHref = returnContext.get("line")
    ? `#published-routes?line=${encodeURIComponent(returnContext.get("line")!)}${returnContext.get("user") ? `&user=${encodeURIComponent(returnContext.get("user")!)}` : ""}`
    : undefined;
  const returnInstance = inventory?.instances.find((instance) =>
    instance.id === returnContext.get("returnInstance") && instance.hostId === returnContext.get("returnHost"),
  );
  const returnServerHref = returnInstance && inventory?.hosts.some((host) => host.id === returnInstance.hostId)
    ? `#servers?host=${encodeURIComponent(returnInstance.hostId)}&instance=${encodeURIComponent(returnInstance.id)}`
    : undefined;
  const finishEditor = (value?: ServerDeployment) => {
    const context = new URLSearchParams(viewHash.split("?")[1] || "");
    if (!value && !context.has("entryEndpoint")) {
      setEditing(null);
      return true;
    }
    if (context.has("entryEndpoint")) {
      context.delete("entryEndpoint");
      if (value) context.set("deployment", value.id);
      return replaceView(`#routes${context.size ? `?${context}` : ""}`, () => {
        setEditing(null);
        if (value) setSelected(value);
      });
    }
    return replaceView(viewHash, () => {
      setEditing(null);
      if (value) setSelected(value);
    });
  };
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
      {entryLoading && <p role="status" className="text-sm text-muted-foreground">正在读取入口监听…</p>}
      {entryRetry && <ActionButton variant="outline" onClick={() => setRequestedEntry(entryRetry)}>重新读取入口</ActionButton>}
      {returnServerHref && !returnHref && <ActionButton variant="link" asChild><a href={returnServerHref}>返回原服务器</a></ActionButton>}
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
                        onClick={() => {
                          editSequence.current++;
                          setEntryLoading(false);
                          setEntryRetry(null);
                          setSelected(d);
                        }}
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
          onClose={() => { finishEditor(); }}
          onSaved={finishEditor}
          returnServerHref={returnServerHref}
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
function programsIn(value: ServerDeployment): ServerProgram[] {
  return Array.isArray(value.ir.programs) ? value.ir.programs : [];
}

export function ServerRouteEditor({
  initial,
  initialRefreshEndpoint,
  initialSection,
  returnServerHref,
  inventory,
  isNew,
  onClose,
  onSaved,
}: {
  initial: ServerDeployment;
  initialRefreshEndpoint?: string;
  initialSection?: "tls";
  returnServerHref?: string;
  inventory: Infrastructure;
  isNew: boolean;
  onClose: () => void;
  onSaved: (d: ServerDeployment) => boolean;
}) {
  const [draft, setDraft] = useState(initial);
  // Render empty/unsupported root lists without rewriting the saved intent.
  const programs = useMemo(() => Array.isArray(draft.ir.programs) ? draft.ir.programs : [], [draft.ir.programs]);
  const [entryTask, setEntryTask] = useState<Pick<PolicyUserEntryTaskProps, "deploymentId" | "listenerId" | "principal">>();
  const entryReturnFocus = useRef<string | undefined>(undefined);
  const [mixedExpandedHops, setMixedExpandedHops] = useState(new Set<string>());
  const [connectorTask, setConnectorTask] = useState<{ index: number; source: ServerProgram; connectorId: string; provisional?: ServerProgram }>();
  const connectorEditing = useRef(false);
  const policyBusy = useRef(false);
  const ruleReturnFocus = useRef<{ programIndex: number; ruleID?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const focus = ruleReturnFocus.current;
    if (!focus) return;
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-rule-program]")).find((item) => item.dataset.ruleProgram === String(focus.programIndex) && item.dataset.ruleId === focus.ruleID);
    const target = row?.querySelector<HTMLElement>("button, input") || Array.from(document.querySelectorAll<HTMLButtonElement>("[data-rule-add-program]")).find((item) => item.dataset.ruleAddProgram === String(focus.programIndex));
    if (target) { target.focus(); ruleReturnFocus.current = undefined; }
  }, [draft]);
  const connectorReturnFocus = useRef<{ programIndex: number; connectorId?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const focus = connectorReturnFocus.current;
    if (!focus) return;
    const program = programs[focus.programIndex];
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-connector-id]")).find((item) => item.dataset.connectorInstance === program?.instance.id && item.dataset.connectorListener === program?.listener.id && item.dataset.connectorId === focus.connectorId);
    const target = row?.querySelector<HTMLElement>("input, button") || Array.from(document.querySelectorAll<HTMLButtonElement>("[data-connector-add-program]")).find((item) => item.dataset.connectorAddProgram === String(focus.programIndex));
    if (target) { target.focus(); connectorReturnFocus.current = undefined; }
  }, [draft]);
  const sourceFence = useRef(false);
  const [sourceStale, setSourceStale] = useState(false);
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
  const [initialListenerReview, setInitialListenerReview] = useState(
    !!initialRefreshEndpoint,
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
  const viewChangeNoteId = useId();
  const [error, setError] = useState<Error | null>(null);
  const [dirty, setDirty] = useState(isNew && programsIn(initial).length > 0);
  const [graphNodes, setGraphNodes, onGraphNodesChange] =
    useNodesState<RouteGraphNode>([]);
  const [announcement, setAnnouncement] = useState("");
  const [jsonOpen, setJSONOpen] = useState(false);
  const [json, setJSON] = useState("");
  const [jsonBaseline, setJSONBaseline] = useState("");
  const [jsonError, setJSONError] = useState<string>();
  const jsonInput = useRef<HTMLTextAreaElement>(null);
  const jsonErrorMessage = useRef<HTMLParagraphElement>(null);
  const jsonErrorId = useId();
  const [jsonFailure, setJSONFailure] = useState(0);
  useLayoutEffect(() => {
    if (jsonOpen && jsonFailure) {
      jsonInput.current?.focus();
      // The editor can already fit while its following error is below the
      // short dialog's body clip. Reveal the message without moving focus.
      jsonErrorMessage.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [jsonFailure]);
  const jsonDirty = jsonOpen && json !== jsonBaseline;
  const confirm = useConfirm();
  const client = useQueryClient();
  const path = useMemo(
    () => programs.map((p) => p.listener.id),
    [programs],
  );
  useEffect(() => {
    setGraphNodes((previous) => routeGraphNodes(inventory, path, previous));
  }, [inventory, path, setGraphNodes]);
  const selectionPending =
    path.some((id) => pendingEndpoints[id]) ||
    pendingEndpoints[`add-${path.join("/")}`] || pendingEndpoints["ordered-add"];
  const viewChangeReason = pathLoading
    ? "正在读取所选端点，完成后可切换编辑方式。"
    : selectionPending
      ? "先完成或取消当前端点选择，再切换编辑方式。"
      : undefined;
  useUnsavedChanges(dirty || selectionPending || materialPending || jsonDirty);
  const save = useMutation({
    mutationFn: (_complete: typeof onSaved) => {
      if (connectorEditing.current) throw new Error("请先采用或取消连接参数修改。");
      if (sourceFence.current) throw new Error("用户入口可能已更新，请重新读取路径后再保存。");
      if (pendingMaterials.current.size)
        throw new Error("请等待 TLS 文件读取完成，或取消读取后再保存。");
      if (programsIn(latestDraft.current).some((program) => (program.rules || []).some((rule) =>
        canEditRuleCondition(program, latestDraft.current.ir.schemaVersion, rule) && !!ruleConditionError(program, latestDraft.current.ir.schemaVersion, rule.match))))
        throw new Error("请先修正规则条件，再保存草稿。");
      const connectorError = programsIn(latestDraft.current).map((program) => connectorInputError(program, latestDraft.current.ir.schemaVersion)).find(Boolean);
      if (connectorError) throw new Error(connectorError);
      return saveRecord<ServerDeployment>("server-deployments", latestDraft.current, isNew);
    },
    onSuccess: (value, complete) => {
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      complete(value);
    },
    onError: setError,
  });
  policyBusy.current = save.isPending || !!selectionPending || materialPending || jsonDirty || !!entryTask || connectorEditing.current;
  const update = (next: ServerDeployment) => {
    draftRevision.current++;
    setPathLoading(false);
    latestDraft.current = next;
    setDraft(next);
    setDirty(true);
    setError(null);
  };
  // A display-name edit does not invalidate an endpoint selection in flight.
  // Topology/policy edits still go through update and advance the revision fence.
  const rename = (name: string) => {
    const next = { ...latestDraft.current, name };
    latestDraft.current = next;
    setDraft(next);
    setDirty(true);
    setError(null);
  };
  const legacyChainEditable = (draft.ir.programs == null || Array.isArray(draft.ir.programs)) && canEditLegacyPath({ ...draft, ir: { ...draft.ir, programs } }, inventory);
  const orderedPath = readOrderedServerPath(draft, inventory);
  const chainEditable = legacyChainEditable || orderedPath.editable;
  // The policy section owns its exact runtime/schema/authorization reason.
  // Add a path-level explanation only when those sections do not already
  // explain why the ordered workspace is unavailable.
  const policyExplainsRestriction = programs.some((program) => !!programEditReason(program, draft.ir.schemaVersion));
  // Keep the same route overview whether or not external proxies are configured.
  const mixedWorkspace = orderedPath.editable;
  const updateOrderedPath = async (hops: OrderedServerHop[]) => {
    const source = latestDraft.current;
    const reason = orderedPathChangeReason(source, hops, inventory);
    if (reason) { setError(new Error(reason)); return false; }
    const revision = ++draftRevision.current;
    setPathLoading(true);
    setError(null);
    try {
      // Retained listeners keep the revealed draft snapshot. Only new choices
      // need a reveal; choosing an existing administrator proxy sends no secrets.
      const selected = hops.filter((hop): hop is Extract<OrderedServerHop, { kind: "managed" }> => hop.kind === "managed")
        .filter((hop) => !programsIn(source).some((program) => program.listener.id === hop.endpointId));
      const endpoints = await Promise.all(selected.map(async (hop) => {
        const expected = inventory.endpoints.find((endpoint) => endpoint.id === hop.endpointId);
        const endpoint = await request<ManagedEndpoint>(`/managed-endpoints/${hop.endpointId}/reveal`);
        if (endpoint.id !== hop.endpointId) throw new Error("读取到的监听与所选端点不一致，请重新选择。");
        if (!expected || endpoint.instanceId !== expected.instanceId)
          throw new Error("所选监听的所属核心已变化，请重新选择服务器和端点。");
        return endpoint;
      }));
      if (revision !== draftRevision.current || latestDraft.current.ir !== source.ir) return false;
      const revealed = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
      const next = compileOrderedServerPath(source, hops, {
        ...inventory, endpoints: inventory.endpoints.map((endpoint) => revealed.get(endpoint.id) || endpoint),
      });
      update({ ...next, name: latestDraft.current.name, ir: { ...next.ir, topologyRevision: newID("topology") } });
      setAnnouncement(hops.length ? "代理链顺序已更新到草稿，尚未保存。" : "路径已清空，请选择第一跳。");
      return true;
    } catch (error) {
      if (revision === draftRevision.current) { setError(error as Error); setPathLoading(false); }
      return false;
    }
  };
  const updatePath = async (ids: string[]) => {
    const source = latestDraft.current;
    if (!legacyChainEditable || (source.ir.programs != null && !Array.isArray(source.ir.programs))) {
      setError(new Error(pathRewriteUnavailable));
      return false;
    }
    // Keep the legacy empty-list and serialization behavior, but do not let
    // that presentation bypass the lossless/capability proof for a rewrite.
    const base = { ...source, ir: { ...source.ir, programs: programsIn(source) } };
    const hops: OrderedServerHop[] = ids.map((endpointId) => ({ kind: "managed", endpointId }));
    const reason = orderedPathChangeReason(base, hops, inventory);
    if (reason) { setError(new Error(reason)); return false; }
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
      if (revision !== draftRevision.current) return false;
      const revealed = new Map(
        endpoints.map((endpoint) => [endpoint.id, endpoint]),
      );
      const selectedInventory = {
        ...inventory,
        endpoints: inventory.endpoints.map(
          (endpoint) => revealed.get(endpoint.id) || endpoint,
        ),
      };
      const revealedReason = orderedPathChangeReason(base, hops, selectedInventory);
      if (revealedReason) throw new Error(revealedReason);
      const next = compilePath(base, ids, selectedInventory);
      next.ir.topologyRevision = newID("topology");
      update({ ...next, name: latestDraft.current.name });
      setAnnouncement(
        next.ir.programs.length
          ? `路径已更新：${next.ir.programs.map((p) => p.listener.name).join("，然后到")}，最后直接访问目标。`
          : "路径已清空，请选择第一跳。",
      );
      return true;
    } catch (e) {
      if (revision === draftRevision.current) {
        setError(e as Error);
        setPathLoading(false);
      }
      return false;
    }
  };
  const updateProgram = (index: number, patch: Partial<ServerProgram>) => {
    const current = latestDraft.current;
    update({
      ...current,
      ir: {
        ...current.ir,
        topologyRevision: newID("topology"),
        programs: programsIn(current).map((p, i) =>
          i === index ? { ...p, ...patch } : p,
        ),
      },
    });
  };
  const openConnectorConnection = (index: number, connectorId: string, focusLabel: string) => {
    if (connectorTask || connectorEditing.current || entryTask || save.isPending || pathLoading || selectionPending || materialPending || jsonDirty) return;
    const source = programsIn(latestDraft.current)[index];
    if (!source || source !== programs[index] || !source.connectors?.some((connector) => connector.id === connectorId)) return;
    connectorEditing.current = true;
    entryReturnFocus.current = focusLabel;
    setConnectorTask({ index, source, connectorId });
  };
  const updateReality = (
    index: number,
    patch: Partial<NonNullable<ServerTLS["reality"]>>,
  ) => {
    const program = programs[index];
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
    if (connectorEditing.current || pathLoading) return;
    const text = JSON.stringify(draft.ir, null, 2);
    setJSON(text);
    setJSONError(undefined);
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
    connectorEditing.current ? undefined : dirty || selectionPending || materialPending || jsonDirty
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
      setError(new Error("请从当前路径的最后一跳连接到下一跳。"));
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
  const listenerReview = refreshingListener ? (
    <ListenerRefreshReview
      draft={draft}
      inventory={inventory}
      endpointId={refreshingListener}
      getRevision={() => draftRevision.current}
      onClose={() => {
        setRefreshingListener(undefined);
        setInitialListenerReview(false);
      }}
      onApply={(next, revision) => {
        if (revision !== draftRevision.current) return false;
        invalidateMaterial(refreshingListener);
        update({
          ...next,
          ir: { ...next.ir, topologyRevision: newID("topology") },
        });
        setRefreshingListener(undefined);
        setInitialListenerReview(false);
        setAnnouncement("监听设置已更新到草稿，尚未保存。");
        return true;
      }}
    />
  ) : null;
  // The initial comparison is the first task surface. Mounting it inside an
  // already-open Sheet on the same commit lets the two modal scopes hide one
  // another. Keep this editor's draft and revision owner, but mount its Sheet
  // only after the user keeps or explicitly adopts the listener snapshot.
  if (connectorTask) return <ServerConnectorConnectionDialog
    key={`${initial.id}:${connectorTask.source.instance.id}:${connectorTask.source.listener.id}:${connectorTask.connectorId}`}
    program={connectorTask.provisional || programs[connectorTask.index]}
    schemaVersion={draft.ir.schemaVersion}
    connectorId={connectorTask.connectorId}
    isNew={!!connectorTask.provisional}
    onEditingChange={(editing) => { connectorEditing.current = editing; }}
    onClose={() => { connectorEditing.current = false; setConnectorTask(undefined); }}
    onApply={(next) => {
      const source = programsIn(latestDraft.current)[connectorTask.index];
      if (source !== connectorTask.source || source.instance.id !== next.instance.id || source.listener.id !== next.listener.id) return false;
      if (connectorTask.provisional) {
        const connector = next.connectors?.find((item) => item.id === connectorTask.connectorId);
        if (!connector) return false;
        const result = addServerConnector(source, latestDraft.current.ir.schemaVersion, connector);
        if (!result.program) return false;
        updateProgram(connectorTask.index, { connectors: result.program.connectors });
      } else updateProgram(connectorTask.index, { connectors: next.connectors });
      setAnnouncement("连接参数已采用到草稿，尚未保存。");
      return true;
    }}
  />;
  if (entryTask) return <PolicyUserEntryTask
    {...entryTask}
    onClose={() => setEntryTask(undefined)}
    onBeforeManage={() => {
      if (save.isPending || pendingMaterials.current.size || selectionPending || jsonDirty) return false;
      // Source management may revise credentials even when its response is lost.
      // Fence the captured IR before any source mutation controls become reachable.
      sourceFence.current = true;
      setSourceStale(true);
      void client.invalidateQueries({ queryKey: ["infrastructure"] });
      return true;
    }}
  />;
  if (initialListenerReview && listenerReview) return listenerReview;
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-6" }}
      title={isNew ? "新建转发路径" : `编辑 ${initial.name}`}
      open={!discardClosing}
      onOpenChange={(next) => {
        if (!next)
          (() => {
            if (!save.isPending) close();
          })();
      }}
      onReady={() => {
        if (entryReturnFocus.current) {
          const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((button) => button.getAttribute("aria-label") === entryReturnFocus.current);
          if (target) { target.focus(); entryReturnFocus.current = undefined; }
        }
      }}
      onClosed={() => {
        ((visible) => {
          if (!visible && discardClosing) onClose();
        })(false);
      }}
      size={chainEditable && view !== "graph" ? "lg" : "xl"}
      pending={!!discardConfirming}
      footer={
        <div className="flex w-full items-center justify-end gap-3">
          <ActionButton variant="outline" disabled={save.isPending} onClick={close}>取消</ActionButton>
          <ActionButton
            className="min-w-32 flex-1 sm:flex-none"
            leadingIcon={<SaveOutlined aria-hidden="true" />}
            pending={save.isPending}
            disabled={
              programs.some((program) => (program.rules || []).some((rule) => canEditRuleCondition(program, draft.ir.schemaVersion, rule) && !!ruleConditionError(program, draft.ir.schemaVersion, rule.match))) ||
              programs.some((program) => !!connectorInputError(program, draft.ir.schemaVersion)) ||
              !!connectorTask ||
              sourceStale ||
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
        </div>
      }
    >
      <div inert={save.isPending} className="space-y-6">
        <ErrorNotice error={error} />
        {draft.ir.programs != null && !Array.isArray(draft.ir.programs) && <Notice tone="warning" title="监听列表格式需要修复">原配置已保留。请使用完整 JSON 将监听列表修复为数组，再使用路径表单。</Notice>}
        {sourceStale && <Notice tone="warning" title="用户入口可能已更新">
          <p>当前草稿仍保留，保存已暂停。请重新读取路径，核对最新入口后再继续修改。</p>
          <ActionButton variant="outline" onClick={() => confirmDiscard({
            title: "重新读取并放弃当前草稿？",
            description: "放弃此处尚未保存的修改，返回路径列表后重新打开最新版本。已完成的入口管理操作不会撤销。",
            confirmLabel: "重新读取路径",
            cancelLabel: "保留草稿",
          }, async (stillCurrent) => {
            await client.invalidateQueries({ queryKey: ["infrastructure"] });
            if (stillCurrent()) setDiscardClosing(true);
          })}>重新读取路径</ActionButton>
        </Notice>}
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
        {pathLoading && view === "graph" && (
          <p role="status" className="muted text-sm text-muted-foreground">
            正在读取所选端点的完整连接设置…
          </p>
        )}
        {returnServerHref && <ActionButton variant="link" asChild><a href={returnServerHref}>返回原服务器</a></ActionButton>}
        <label className="standalone-label grid gap-2 text-sm font-medium">
          转发路径名称
          <Input
            aria-label="转发路径名称"
            value={draft.name}
            onChange={(e) => rename(e.target.value)}
            placeholder="例如：FRA → 英国"
          />
        </label>
        <section aria-label={chainEditable ? "路径编排" : "监听与转发"} className="min-w-0 overflow-hidden rounded-xl border bg-muted/20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3">
          <h2 className="text-sm font-semibold">
            {chainEditable ? "路径编排" : "监听与转发"}
          </h2>
        {legacyChainEditable && (
          <Tabs
            value={view}
            onValueChange={(next) => {
              if (viewChangeReason) return;
              draftRevision.current++;
              setPathLoading(false);
              setPendingEndpoints({});
              setView(next);
            }}
            defaultValue={"ordered"}
            className="min-w-0 space-y-2"
          >
            <TabsList className="h-auto max-w-full flex-wrap">
              <TabsTrigger key={"ordered"} value={"ordered"}
                disabled={view !== "ordered" && !!viewChangeReason}
                aria-describedby={viewChangeReason ? viewChangeNoteId : undefined}>
                {"\u987A\u5E8F\u7F16\u8F91"}
              </TabsTrigger>
              <TabsTrigger key={"graph"} value={"graph"}
                disabled={view !== "graph" && !!viewChangeReason}
                aria-describedby={viewChangeReason ? viewChangeNoteId : undefined}>
                {"\u56FE\u5F62\u7F16\u8F91"}
              </TabsTrigger>
            </TabsList>
            {viewChangeReason && <p id={viewChangeNoteId} className="text-sm text-muted-foreground">{viewChangeReason}</p>}
          </Tabs>
        )}
        </div>
        <div className="min-w-0 p-3 sm:p-4">
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
        {!legacyChainEditable && !orderedPath.editable && !policyExplainsRestriction && <p className="text-sm text-muted-foreground">{orderedPath.reason}</p>}
        {!chainEditable ? (
          <ServerPolicyEditor
            programs={programs}
            schemaVersion={draft.ir.schemaVersion}
            inventory={inventory}
            onDefaultActionChange={(index, defaultAction) => {
              updateProgram(index, { defaultAction });
              setAnnouncement("默认去向已更新到草稿，尚未保存。");
            }}
            onRuleActionChange={(index, ruleID, action) => {
              const program = programsIn(latestDraft.current)[index];
              if (
                !program ||
                typeof ruleID !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ruleID) ||
                program.listener.id !== programs[index]?.listener.id ||
                program.rules.filter((rule) => rule.id === ruleID).length !== 1
              ) return;
              updateProgram(index, {
                rules: program.rules.map((rule) =>
                  rule.id === ruleID ? { ...rule, action } : rule,
                ),
              });
              setAnnouncement("规则去向已更新到草稿，条件与顺序不变，尚未保存。");
            }}
            onRuleConditionChange={(index, ruleID, match) => {
              const program = programsIn(latestDraft.current)[index];
              const rule = program?.rules.find((item) => item.id === ruleID);
              if (!program || !rule || program.listener.id !== programs[index]?.listener.id ||
                  program.instance.id !== programs[index]?.instance.id ||
                  !canEditRuleCondition(program, latestDraft.current.ir.schemaVersion, rule)) return;
              updateProgram(index, { rules: program.rules.map((item) => item.id === ruleID ? { ...item, match } : item) });
              setAnnouncement("规则条件已更新到草稿，去向与顺序不变，尚未保存。");
            }}
            onConnectorsChange={(index, source, next) => {
              const program = programsIn(latestDraft.current)[index];
              if (!program || program !== source || program.instance.id !== next.instance.id || program.listener.id !== next.listener.id) return;
              updateProgram(index, { connectors: next.connectors });
              setAnnouncement("连接器已更新到草稿，规则引用不变，尚未保存。");
            }}
            onOpenUserEntry={(index, principalIndex, focusLabel) => {
              if (entryTask || save.isPending || selectionPending || materialPending || jsonDirty) return;
              const program = programsIn(latestDraft.current)[index];
              if (!program || program !== programs[index]) return;
              const principal = program.principals?.[principalIndex];
              if (!principal) return;
              entryReturnFocus.current = focusLabel;
              setEntryTask({ deploymentId: latestDraft.current.id, listenerId: program.listener.id,
                principal: { accountId: principal.accountId, subjectId: principal.subjectId, routeId: principal.routeId, credentialVersion: principal.credentialVersion } });
            }}
            onRuleListChange={(index, operation, ruleID) => {
              const source = programsIn(latestDraft.current)[index];
              if (!source || source !== programs[index] || !canEditRuleList(source, latestDraft.current.ir.schemaVersion)) return;
              const rules = source.rules || [];
              if (operation === "add") {
                const ids = new Set(rules.map((rule) => rule.id));
                let serial = 1;
                while (ids.has(`rule-${serial}`)) serial++;
                updateProgram(index, { rules: [...rules, { id: `rule-${serial}`, match: { op: "domain", value: "" }, action: { kind: "reject" } }] });
                setAnnouncement("新规则已添加到末尾，请填写条件并选择去向后保存。");
                return;
              }
              const position = rules.findIndex((rule) => rule.id === ruleID);
              if (position < 0) return;
              if (operation === "remove") {
                confirmDiscard({
                  title: `删除规则 ${position + 1}？`,
                  description: `删除 ${ruleID}（${matchLabel(rules[position].match)}）后，原本命中此规则的流量将继续匹配后续规则，或使用默认去向。仅修改草稿，尚未应用。`,
                  confirmLabel: "删除规则", cancelLabel: "保留规则",
                }, (stillCurrent) => {
                  if (!stillCurrent()) return;
                  if (programsIn(latestDraft.current)[index] !== source) {
                    setError(new Error("规则列表已变化，请重新选择要删除的规则。"));
                    return;
                  }
                  const next = rules.filter((rule) => rule.id !== ruleID);
                  ruleReturnFocus.current = { programIndex: index, ruleID: next[Math.min(position, next.length - 1)]?.id };
                  updateProgram(index, { rules: next });
                  setAnnouncement("规则已从草稿删除，尚未保存。");
                });
                return;
              }
              const target = position + (operation === "up" ? -1 : 1);
              if (target < 0 || target >= rules.length) return;
              const next = [...rules];
              [next[position], next[target]] = [next[target], next[position]];
              updateProgram(index, { rules: next });
              setAnnouncement("规则顺序已更新到草稿，先命中的规则决定去向，尚未保存。");
            }}
            onOpenConnectorConnection={openConnectorConnection}
            onAddConnector={(index, focusLabel) => {
              if (connectorEditing.current || entryTask || save.isPending || selectionPending || materialPending || jsonDirty) return;
              const source = programsIn(latestDraft.current)[index];
              if (!source || source !== programs[index] || connectorAddReason(source, latestDraft.current.ir.schemaVersion)) return;
              const ids = new Set((source.connectors || []).map((connector) => connector.id));
              let serial = 1;
              while (ids.has(`connector-${serial}`)) serial++;
              const connectorId = `connector-${serial}`;
              const provisional: ServerProgram = { ...source, connectors: [...(source.connectors || []), { id: connectorId, connection: { protocol: "socks", host: "", port: 1080 } }] };
              connectorEditing.current = true;
              entryReturnFocus.current = focusLabel;
              setConnectorTask({ index, source, connectorId, provisional });
            }}
            onRemoveConnector={(index, connectorId) => {
              if (connectorEditing.current || policyBusy.current) return;
              const source = programsIn(latestDraft.current)[index];
              if (!source || source !== programs[index] || removeServerConnector(source, latestDraft.current.ir.schemaVersion, connectorId).error) return;
              confirmDiscard({
                title: `删除连接器 ${connectorId}？`,
                description: "仅从当前草稿移除此连接器，不修改其他去向，也不会应用到核心。",
                confirmLabel: "删除连接器", cancelLabel: "保留连接器",
              }, (stillCurrent) => {
                if (!stillCurrent() || connectorEditing.current || policyBusy.current || programsIn(latestDraft.current)[index] !== source) return;
                const result = removeServerConnector(source, latestDraft.current.ir.schemaVersion, connectorId);
                if (!result.program) { setError(new Error(result.error || "连接器不能移除，请重新核对引用。")); return; }
                const oldIndex = source.connectors!.findIndex((connector) => connector.id === connectorId);
                const remaining = result.program.connectors || [];
                connectorReturnFocus.current = { programIndex: index, connectorId: remaining[Math.min(oldIndex, remaining.length - 1)]?.id };
                updateProgram(index, { connectors: result.program.connectors });
                setAnnouncement("连接器已从草稿移除，尚未保存。");
              });
            }}
            onRefreshListener={setRefreshingListener}
            onEditJSON={editIntent}
          />
        ) : view === "graph" && legacyChainEditable ? (
          <>
            <ServerPathSummary programs={programs} />
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
              点击端点选择第一跳，从路径末端连接下一跳。拖动只调整图形布局。
            </p>
          </>
        ) : mixedWorkspace && orderedPath.editable ? (
          <ServerMixedPathWorkspace expandedHops={mixedExpandedHops} onExpandedHopsChange={setMixedExpandedHops} programs={programs} inventory={inventory} schemaVersion={draft.ir.schemaVersion}
            hops={orderedPath.hops} connectorChoices={orderedPath.connectorChoices}
            onChangePath={updateOrderedPath}
            changeReason={(hops) => orderedPathChangeReason(draft, hops, inventory)}
            onPendingChange={markPending}
            onSelectionChange={() => { draftRevision.current++; setPathLoading(false); }}
            onEditConnector={(endpointId, connectorId, focusLabel) => {
              const index = programs.findIndex((program) => program.listener.id === endpointId);
              if (index >= 0) openConnectorConnection(index, connectorId, focusLabel);
            }}
            changing={pathLoading}
          />
        ) : (
          <ServerPathWorkspace
            programs={programs}
            inventory={inventory}
            onChangePath={updatePath}
            onPendingChange={markPending}
            onSelectionChange={() => {
              draftRevision.current++;
              setPathLoading(false);
            }}
            changing={pathLoading}
          />
        )}
        </div>
        </section>
        <Accordion type="multiple" defaultValue={initialSection ? [initialSection] : []} className="w-full">
          {chainEditable && programs.length > 0 && (
            <AccordionItem value="listener-details">
              <AccordionTrigger>监听快照与转发详情</AccordionTrigger>
              <AccordionContent>
                <ServerForwarding
                  programs={programs}
                  inventory={inventory}
                  onRefreshListener={setRefreshingListener}
                />
              </AccordionContent>
            </AccordionItem>
          )}
          {[
            {
              key: "tls",
              label: "TLS \u8BC1\u4E66\u4E0E\u5B89\u5168\u53C2\u6570",
              children: programs.some(
                (p) => p.listener.connection.tls?.enabled,
              ) ? (
                programs.map(
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
                                if (!programsIn(current).some((program) => program.listener.id === p.listener.id)) return;
                                update({
                                  ...current,
                                  ir: {
                                    ...current.ir,
                                    topologyRevision: newID("topology"),
                                    programs: programsIn(current).map((program) =>
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
                  {programs.some(supportsDestinationExceptions) && (
                    <p className="muted text-sm text-muted-foreground">
                      仅为确实需要提供的内部服务添加明确网段；留空保留默认限制。修改后需重新应用。
                    </p>
                  )}
                  {programs.some(supportsDestinationExceptions) ? (
                    programs.map(
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
                  <ActionButton onClick={editIntent} disabled={pathLoading} variant="outline">
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
      {listenerReview}
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
                  if (!ir || !Array.isArray(ir.programs))
                    throw new Error("\u7F3A\u5C11 programs \u6570\u7EC4");
                  programs.forEach((program) => invalidateMaterial(program.listener.id));
                  update({ ...draft, ir });
                  setJSONBaseline(json);
                  setJSONOpen(false);
                } catch (e) {
                  setJSONError(e instanceof SyntaxError ? "请输入有效的 JSON，再应用到草稿。" : (e as Error).message);
                  setJSONFailure((attempt) => attempt + 1);
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
          ref={jsonInput}
          aria-invalid={!!jsonError}
          aria-describedby={jsonError ? jsonErrorId : undefined}
          value={json}
          onChange={(e) => { setJSON(e.target.value); setJSONError(undefined); }}
          spellCheck={false}
        />
        {jsonError && <p ref={jsonErrorMessage} id={jsonErrorId} role="alert" className="text-sm text-destructive">{jsonError}</p>}
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
  const program = Array.isArray(programs) && programs.length === 1 ? programs[0] : undefined;
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
    programsIn(deployment).some((p) => p.listener.id === mismatch.endpointId)
  )
    return { kind: "listener" as const, endpointId: mismatch.endpointId };
  if (
    mismatch?.code === "SERVER_INSTANCE_CHANGED" &&
    programsIn(deployment).some((p) => p.instance.id === mismatch.instanceId)
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
  // Display projection only: retain the server snapshot for edits and CAS.
  const programs = programsIn(deployment);
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
    programs,
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
      description="转发路径草稿已保存"
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
        programs={programs}
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
          programs={programs}
          managedEntry={managedEntry}
        />
      )}
      <Section title="目标实例" description="运行结果由对应 Agent 回传。">
        {programs.map((p) => (
          <div
            role="group"
            aria-label={`目标实例 ${coreName(p.instance)}`}
            className="target-status grid min-w-0 gap-3 border-b py-4 first:pt-0 last:border-b-0 last:pb-0 wrap-anywhere"
            key={p.instance.id}
          >
            <div className="grid min-w-0 gap-2">
              <h3 className="text-sm font-semibold">
                <span className="block">
                  {
                    inventory.hosts.find((h) => h.id === p.instance.hostId)
                      ?.name
                  }
                </span>{" "}
                <span className="mt-1 block text-muted-foreground font-normal">
                  {coreName(p.instance)}
                </span>
              </h3>
              <span className="muted text-sm text-muted-foreground">
                {p.listener.name}
              </span>
            </div>
            <div className="grid min-w-0 gap-3">
              <InstanceObservation instanceId={p.instance.id} />
            </div>
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
                    将更新 {programs.length} 个核心实例
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
              programs={programs}
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
                programs={programs}
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







