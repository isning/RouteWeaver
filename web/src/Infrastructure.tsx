import { ScrollableTabsList } from "@/ui-patterns/scrollable-tabs-list";
import { InventoryEditor, type InventoryEditTask } from "./InventoryEditor";
import { loadInfrastructure, coreName } from "./infrastructure-data";
export { loadInfrastructure, coreName } from "./infrastructure-data";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { ActionButton } from "@/ui-patterns/actions";
import { AppField, AppForm, useForm } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Server as CloudServerOutlined,
  Pencil as EditOutlined,
  KeyRound as KeyOutlined,
  Plus as PlusOutlined,
  RotateCw as ReloadOutlined,
} from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PolicyDateInput } from "./PolicyDateInput";
import { AccountingRecovery } from "./AccountingRecovery";
import { post, request } from "./api";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { DataTable, TableRowActions } from "./DataTable";
import { DiagnosticsPanel } from "./Diagnostics";
import { phaseLabel } from "./infrastructure-model";
import { dateLabel, newID } from "./model";
import { hasUnsavedChanges, useUnsavedChanges } from "./navigation";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import { readServerWorkspace, serverWorkspaceHash, type ServerWorkspaceSection } from "./server-workspace";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";
import { NodeObservation } from "./NodeObservation";
import { ServerResourceOverview, CoreStatusSummary, ServerSetupTip } from "./ServerOverview";
import type {
  AgentState,
  CoreInstance,
  HostRecord,
  Infrastructure,
  ManagedEndpoint,
} from "./types";
function workspaceOwnership(
  inventory: Infrastructure,
  hostId: string,
  instanceId: string | undefined,
  createdHosts: HostRecord[],
  createdCores: CoreInstance[],
) {
  const currentHost = inventory.hosts.find((value) => value.id === hostId) || createdHosts.find((value) => value.id === hostId);
  const currentCore = instanceId ? inventory.instances.find((value) => value.id === instanceId) || createdCores.find((value) => value.id === instanceId) : null;
  const message = !currentHost ? "此服务器已从清单移除。请返回服务器清单重新选择。"
    : instanceId && !currentCore ? "此核心已从清单移除。请返回核心列表重新选择。"
    : currentCore && currentCore.hostId !== hostId ? "此核心已转移到其他服务器。请打开核心所在服务器后继续配置。" : null;
  return { currentHost, message };
}
function inventoryTaskScope(task: Pick<InventoryEditTask, "kind" | "value" | "hostId" | "instanceId"> | null) {
  if (!task?.hostId) return null;
  return {
    hostId: task.hostId,
    instanceId: task.kind === "core-instances" ? task.value?.id : task.instanceId,
  };
}
const requestedServerSetup = (hash: string) => {
  return hash.split("?")[0] === "#servers" ? hash : null;
};
export function ServersPage() {
  const client = useQueryClient();
  const workspace = useContext(WorkspaceHistoryContext);
  const [requestedSetup, setRequestedSetup] = useState(() => requestedServerSetup(location.hash));
  const editSequence = useRef(0);
  const knownViews = useRef(new Map<string, { host: HostRecord | null; instance: CoreInstance | null; section: ServerWorkspaceSection }>());
  const pendingView = useRef<{ hash: string; complete: () => void } | null>(null);
  const accepted = (hash: string) => {
    ++editSequence.current;
    if (workspace) { setEntity(null); setEnrollmentOpen(false); }
    const pending = pendingView.current;
    pendingView.current = null;
    if (pending?.hash === hash) {
      pending.complete();
      setRequestedSetup(null);
    } else {
      const known = knownViews.current.get(hash);
      if (known && (workspace || (!entity && !enrollmentOpen))) show(known.host, known.instance, known.section);
      else setRequestedSetup(requestedServerSetup(hash));
    }
  };
  const replaceView = useWorkspaceViewEntry(accepted);
  useEffect(() => {
    // The authenticated controller filters native events before publishing its
    // accepted event. Standalone embeds have only the native event path.
    if (workspace) return;
    const changed = () => accepted(location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  });
  const navigate = (hash: string, complete: () => void) => {
    if (location.hash === hash) return;
    pendingView.current = { hash, complete };
    if (workspace?.current) workspace.current.navigate(hash);
    else {
      // No authenticated controller exists in standalone embeds. Never bypass
      // an active task's guard there either.
      if (hasUnsavedChanges()) { pendingView.current = null; return; }
      history.pushState(null, "", hash);
      accepted(hash);
    }
  };
  const query = useQuery({ queryKey: ["infrastructure"], queryFn: loadInfrastructure });
  const [tab, setTab] = useState<InventoryEditTask["kind"]>("hosts");
  const [entity, setEntity] = useState<InventoryEditTask | null>(null);
  const [host, setHost] = useState<HostRecord | null>(null);
  const [instance, setInstance] = useState<CoreInstance | null>(null);
  const [section, setSection] = useState<ServerWorkspaceSection>("overview");
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [createdCores, setCreatedCores] = useState<CoreInstance[]>([]);
  const [createdHosts, setCreatedHosts] = useState<HostRecord[]>([]);
  // Retain display identity only. Revealed values and revision tokens belong to
  // the editor task, never to the inventory query cache or URL.
  const [savedListeners, setSavedListeners] = useState<ManagedEndpoint[]>([]);
  const [editError, setEditError] = useState<Error | null>(null);
  const [ownershipIssue, setOwnershipIssue] = useState<{ hostId: string; instanceId: string | null; message: string } | null>(null);
  const scopeIssue = ownershipIssue?.hostId === host?.id && ownershipIssue?.instanceId === (instance?.id || null) ? ownershipIssue.message : null;
  const [editorOwnershipIssue, setEditorOwnershipIssue] = useState<{ task: InventoryEditTask; message: string } | null>(null);
  const editorScopeIssue = editorOwnershipIssue && editorOwnershipIssue.task === entity ? editorOwnershipIssue.message : null;
  const readScopeIssue = (target?: ReturnType<typeof inventoryTaskScope>) => {
    // An inventory response can reach the cache before React receives its
    // scheduled notification. Check that authoritative owner at action time.
    const latest = client.getQueryState<Infrastructure>(["infrastructure"]);
    if (!latest?.data || latest.status !== "success" || latest.fetchStatus !== "idle") return scopeIssue;
    const pageIssue = host ? workspaceOwnership(latest.data, host.id, instance?.id, createdHosts, createdCores).message : null;
    const taskIssue = target ? workspaceOwnership(latest.data, target.hostId, target.instanceId, createdHosts, createdCores).message : null;
    return pageIssue || taskIssue || scopeIssue;
  };
  const pageCreateAction = useRef<HTMLButtonElement>(null);
  const pageOpener = useRef<{ hostId?: string; instanceId?: string } | null>(null);
  const hostResumeAction = useRef<string | null>(null);
  const hostActions = useRef(new Map<string, HTMLButtonElement>());
  const listActions = useRef(new Map<string, HTMLButtonElement>());
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const coreHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterSave = useRef(false);
  const data = useMemo(() => query.data && {
    ...query.data,
    hosts: [...query.data.hosts, ...createdHosts.filter((created) => !query.data!.hosts.some((saved) => saved.id === created.id))],
    instances: [...query.data.instances, ...createdCores.filter((created) => !query.data!.instances.some((saved) => saved.id === created.id))],
    endpoints: [...query.data.endpoints.filter((endpoint) => !savedListeners.some((saved) => saved.id === endpoint.id)), ...savedListeners],
  }, [query.data, createdHosts, createdCores, savedListeners]);
  useLayoutEffect(() => {
    // Only a completed authoritative inventory can revoke this page's owner.
    // Keep the task and any issued token mounted; block new scoped operations.
    if (!query.data || !query.isSuccess || query.isFetching || query.isError || query.isPaused) return;
    if (!host) { setOwnershipIssue(null); return; }
    const { currentHost, message } = workspaceOwnership(query.data, host.id, instance?.id, createdHosts, createdCores);
    if (message) {
      for (const [hash, view] of knownViews.current) {
        if (view.host?.id === host.id && (!currentHost || view.instance?.id === instance?.id)) knownViews.current.delete(hash);
      }
      ++editSequence.current;
      setOwnershipIssue((previous) => previous?.hostId === host.id && previous.instanceId === (instance?.id || null) && previous.message === message
        ? previous : { hostId: host.id, instanceId: instance?.id || null, message });
    } else setOwnershipIssue(null);
  }, [query.data, query.isSuccess, query.isFetching, query.isError, query.isPaused, host?.id, instance?.id, createdHosts, createdCores]);
  useLayoutEffect(() => {
    if (!entity) { setEditorOwnershipIssue(null); return; }
    if (!query.data || !query.isSuccess || query.isFetching || query.isError || query.isPaused) return;
    // Overview-origin tasks have their own original core even when the page
    // has no selected instance. Editing form choices does not change this owner.
    const target = inventoryTaskScope(entity);
    const message = target ? workspaceOwnership(query.data, target.hostId, target.instanceId, createdHosts, createdCores).message : null;
    setEditorOwnershipIssue((previous) => message
      ? previous?.task === entity && previous.message === message ? previous : { task: entity, message }
      : null);
  }, [entity, query.data, query.isSuccess, query.isFetching, query.isError, query.isPaused, createdHosts, createdCores]);
  useEffect(() => {
    if (!query.data || query.isFetching || query.isError || query.isPaused) return;
    for (const [hash, view] of knownViews.current) {
      if (!view.host) continue;
      const currentHost = query.data.hosts.find((value) => value.id === view.host!.id) || createdHosts.find((value) => value.id === view.host!.id);
      const currentCore = view.instance ? query.data.instances.find((value) => value.id === view.instance!.id) || createdCores.find((value) => value.id === view.instance!.id) : null;
      if (!currentHost || (view.instance && (!currentCore || currentCore.hostId !== view.host.id))) knownViews.current.delete(hash);
      else knownViews.current.set(hash, { ...view, host: currentHost, instance: currentCore || null });
    }
    const updatedHost = query.data.hosts.find((value) => value.id === host?.id);
    if (updatedHost && updatedHost !== host) setHost(updatedHost);
    const updatedInstance = query.data.instances.find((value) => value.id === instance?.id && value.hostId === host?.id);
    if (updatedInstance && updatedInstance !== instance) setInstance(updatedInstance);
    const unseenListeners = savedListeners.filter((saved) => !query.data!.endpoints.some((endpoint) =>
      endpoint.id === saved.id && endpoint.instanceId === saved.instanceId &&
      endpoint.name === saved.name && endpoint.connection.host === saved.connection.host &&
      endpoint.connection.port === saved.connection.port && endpoint.connection.protocol === saved.connection.protocol));
    if (unseenListeners.length !== savedListeners.length) setSavedListeners(unseenListeners);
    const unseenCores = createdCores.filter((created) => !query.data!.instances.some((saved) => saved.id === created.id));
    if (unseenCores.length !== createdCores.length) setCreatedCores(unseenCores);
    const unseenHosts = createdHosts.filter((created) => !query.data!.hosts.some((saved) => saved.id === created.id));
    if (unseenHosts.length !== createdHosts.length) setCreatedHosts(unseenHosts);
  }, [query.data, query.isFetching, query.isError, query.isPaused, createdCores, createdHosts, savedListeners]);
  const show = (selectedHost: HostRecord | null, selectedCore: CoreInstance | null, selectedSection: ServerWorkspaceSection = "overview") => {
    ++editSequence.current;
    setEditError(null);
    setRequestedSetup(null);
    setHost(selectedHost);
    setInstance(selectedCore);
    setSection(selectedSection);
    if (scopeIssue && selectedHost?.id === host?.id && selectedCore?.id === instance?.id) knownViews.current.delete(location.hash);
    else knownViews.current.set(location.hash, { host: selectedHost, instance: selectedCore, section: selectedSection });
    if (knownViews.current.size > 32) knownViews.current.delete(knownViews.current.keys().next().value!);
  };
  const openHost = (value: HostRecord) => {
    pageOpener.current = { hostId: value.id };
    navigate(serverWorkspaceHash(value.id), () => show(value, null));
  };
  const openInstance = (value: CoreInstance) => {
    const selectedHost = data?.hosts.find((candidate) => candidate.id === value.hostId);
    if (!selectedHost) { setEditError(new Error("找不到此核心所属的服务器，请刷新服务器清单。")); return; }
    if (!host) pageOpener.current = { instanceId: value.id };
    navigate(serverWorkspaceHash(value.hostId, value.id), () => show(selectedHost, value, "cores"));
  };
  const closeInstance = () => {
    if (!host || !instance) return;
    hostResumeAction.current = `instance:${instance.id}`;
    navigate(serverWorkspaceHash(host.id, undefined, "cores"), () => show(host, null, "cores"));
  };
  const backToList = () => navigate("#servers", () => show(null, null));
  const changeSection = (value: string) => {
    if (!host) return;
    const next = value as ServerWorkspaceSection;
    navigate(serverWorkspaceHash(host.id, instance?.id, next), () => show(host, instance, next));
  };
  const label = tab === "hosts" ? "服务器" : tab === "core-instances" ? "核心实例" : "监听端点";
  const edit = async (value: HostRecord | CoreInstance | ManagedEndpoint | null, kind: InventoryEditTask["kind"] = tab, hostId?: string, instanceId?: string) => {
    const target = inventoryTaskScope({ kind, value, hostId, instanceId });
    const issue = readScopeIssue(target);
    if (issue) { setEditError(new Error(issue)); return; }
    setRequestedSetup(null);
    const sequence = ++editSequence.current;
    setEditError(null);
    try {
      const full = kind === "managed-endpoints" && value
        ? await request<ManagedEndpoint>(`/managed-endpoints/${encodeURIComponent(value.id)}/reveal`)
        : value;
      if (sequence !== editSequence.current) return;
      const latestIssue = readScopeIssue(target);
      if (latestIssue) { setEditError(new Error(latestIssue)); return; }
      setEntity({ kind, value: full, hostId, instanceId,
        id: value?.id || newID(kind === "hosts" ? "host" : kind === "core-instances" ? "core" : "endpoint") });
    } catch (error) { if (sequence === editSequence.current) setEditError(error as Error); }
  };
  useEffect(() => {
    if (requestedSetup === null || entity || enrollmentOpen || location.hash !== requestedSetup) return;
    const origin = requestedSetup;
    const context = readServerWorkspace(origin);
    if (context?.hostId === null) {
      replaceView(origin, () => show(null, null));
      return;
    }
    // External deep links require a successful authoritative inventory. Local
    // selection and confirmed saves can keep their already-known identity.
    if (!query.data || !query.isSuccess || query.isFetching || query.isPaused || query.isError) return;
    const selectedHost = context && query.data.hosts.find((candidate) => candidate.id === context.hostId);
    const selectedInstance = context?.instanceId ? query.data.instances.find((candidate) => candidate.id === context.instanceId) : null;
    if (!context || !selectedHost || (context.instanceId && (!selectedInstance || selectedInstance.hostId !== selectedHost.id))) {
      replaceView(origin, () => {
        show(null, null);
        knownViews.current.delete(origin);
        setEditError(new Error("找不到匹配的服务器与核心，请从服务器清单重新选择。"));
      });
      return;
    }
    replaceView(origin, () => show(selectedHost, selectedInstance || null, context.section));
  }, [requestedSetup, entity, enrollmentOpen, query.data, query.isSuccess, query.isFetching, query.isPaused, query.isError, replaceView]);
  useLayoutEffect(() => {
    // Editors keep their invoking action mounted. Page navigation instead puts
    // keyboard focus at the new workspace or the exact restored list action.
    const target = host
      ? (hostResumeAction.current && hostActions.current.get(hostResumeAction.current)) ||
        (section === "cores" && instance ? coreHeading.current : workspaceHeading.current)
      : (pageOpener.current?.hostId ? listActions.current.get(`host:${pageOpener.current.hostId}`) :
        pageOpener.current?.instanceId ? listActions.current.get(`instance:${pageOpener.current.instanceId}`) : null) || pageCreateAction.current;
    hostResumeAction.current = null;
    queueMicrotask(() => {
      if (!document.querySelector('[data-task-overlay][data-state="open"]') && target?.isConnected)
        target.focus({ preventScroll: true });
    });
  }, [host?.id, instance?.id]);
  const records = host && data ? data.deployments.filter((deployment) => deployment.ir.programs.some((program) => program.instance.hostId === host.id)) : [];
  const hostCores = host && data ? data.instances.filter((core) => core.hostId === host.id) : [];
  const hostListeners = host && data ? data.endpoints.filter((endpoint) => hostCores.some((core) => core.id === endpoint.instanceId)) : [];
  const chooseCore = () => {
    if (!host || scopeIssue) return;
    // A chooser must clear a previously visited core, including when the
    // overview was opened from that core's detail. Use the guarded navigator
    // rather than only changing the tab while retaining its instance ID.
    navigate(serverWorkspaceHash(host.id, undefined, "cores"), () => show(host, null, "cores"));
  };
  const setupAction = (step: "core" | "listener") => {
    if (!host || scopeIssue) return;
    if (!hostCores.length) {
      hostResumeAction.current = "setup-core";
      edit(null, "core-instances", host.id);
    } else if (hostCores.length === 1) {
      if (step === "core" || hostListeners.length > 0) openInstance(hostCores[0]);
      else {
        hostResumeAction.current = "setup-listener";
        edit(null, "managed-endpoints", host.id, hostCores[0].id);
      }
    } else chooseCore();
  };
  const coreList = host && data ? (<>
            <Section
              title="核心实例"
              variant="plain"
              description={
                data.instances.some((i) => i.hostId === host!.id)
                  ? undefined
                  : "先添加核心，再配置监听端点"
              }
              extra={
                <ActionButton
                  disabled={!!scopeIssue}
                  ref={(node) => {
                    if (node) hostActions.current.set("add-core", node);
                    else hostActions.current.delete("add-core");
                  }}
                  onClick={() => {
                    hostResumeAction.current = "add-core";
                    edit(null, "core-instances", host!.id);
                  }}
                  variant={section === "overview" || data.instances.some((i) => i.hostId === host!.id) ? "outline" : "default"}
                >
                  添加核心
                </ActionButton>
              }
            >
              {data.instances
                .filter((i) => i.hostId === host!.id)
                .map((i) => (
                  <div
                    className="subscription-row flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                    key={i.id}
                  >
                    <div className="subscription-info min-w-0 space-y-1">
                      <h3 className="text-sm font-semibold">{coreName(i)}</h3>
                      <p>
                        <span className="block">版本 {i.version}</span>
                        {
                          data.endpoints.filter((e) => e.instanceId === i.id)
                            .length
                        }{" "}
                        个监听端点
                      </p>
                    </div>
                    {section === "overview" && <CoreStatusSummary instanceId={i.id} />}
                    <div className={"flex flex-wrap items-center gap-2"}>
                      <ActionButton
                        disabled={!!scopeIssue}
                        aria-label={`为 ${coreName(i)} 添加监听端点`}
                        ref={(node) => {
                          if (node) hostActions.current.set(i.id, node);
                          else hostActions.current.delete(i.id);
                        }}
                        onClick={() => {
                          hostResumeAction.current = i.id;
                          edit(null, "managed-endpoints", host!.id, i.id);
                        }}
                        variant="outline"
                      >
                        添加监听端点
                      </ActionButton>
                      <ActionButton
                        ref={(node) => {
                          if (node) hostActions.current.set(`instance:${i.id}`, node);
                          else hostActions.current.delete(`instance:${i.id}`);
                        }}
                        onClick={() => openInstance(i)}
                        variant={section === "overview" ? "outline" : "default"}
                      >
                        查看接入与配置
                      </ActionButton>
                    </div>
                  </div>
                ))}
            </Section>
  </>) : null;
  return (
    <>
      {!host ? (
        <>
          <ErrorNotice error={editError} />
      <PageHeader
        title="服务器"
        action={
          <ActionButton
            leadingIcon={<PlusOutlined aria-hidden="true" />}
            onClick={() => edit(null)}
            ref={pageCreateAction}
            variant="default"
          >
            添加{label}
          </ActionButton>
        }
      />
      {(query.isError || query.isPaused) && data && <Notice tone={query.isError ? "warning" : "info"}>
        {query.isPaused ? "等待网络连接，服务器清单尚未刷新。" : "服务器清单刷新失败，以下保留已有记录与刚保存的配置。"}
        {query.isError && <p>{query.error.message}</p>}
        <ActionButton onClick={() => query.refetch()} variant="outline" size="sm">刷新服务器清单</ActionButton>
      </Notice>}
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        loadingLayout="cards"
        error={data ? null : query.error}
        retry={() => query.refetch()}
      >
        {data && (
          <Section variant="plain">
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as InventoryEditTask["kind"])}
              defaultValue={"hosts"}
              className="w-full space-y-4"
            >
              <ScrollableTabsList>
                <TabsTrigger
                  key={"hosts"}
                  value={"hosts"}
                >{`服务器 ${data.hosts.length}`}</TabsTrigger>
                <TabsTrigger
                  key={"core-instances"}
                  value={"core-instances"}
                >{`核心实例 ${data.instances.length}`}</TabsTrigger>
                <TabsTrigger
                  key={"managed-endpoints"}
                  value={"managed-endpoints"}
                >{`监听端点 ${data.endpoints.length}`}</TabsTrigger>
              </ScrollableTabsList>
              <TabsContent key={"hosts"} value={"hosts"}>
                {data.hosts.length ? (
                  <div className="server-grid grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {data.hosts.map((value) => {
                      const cores = data.instances.filter((core) => core.hostId === value.id);
                      const listeners = data.endpoints.filter((endpoint) => cores.some((core) => core.id === endpoint.instanceId));
                      const paths = data.deployments.filter((deployment) => deployment.ir.programs.some((program) => program.instance.hostId === value.id));
                      const nextStep = !cores.length ? "添加运行核心" : !listeners.length ? "设置监听入口" : !paths.length ? "配置转发路径" : "查看配置与节点上报";
                      return (
                      <Card className="server-card min-w-0" key={value.id}>
                        <CardHeader>
                          <CardTitle>
                            <button
                              className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              ref={(node) => { if (node) listActions.current.set(`host:${value.id}`, node); else listActions.current.delete(`host:${value.id}`); }}
                              onClick={() => openHost(value)}
                            >
                              <CloudServerOutlined
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="break-words">{value.name}</span>
                            </button>
                          </CardTitle>
                          <CardDescription className="server-address break-all pl-6">
                            {value.address}
                          </CardDescription>
                          <CardAction>
                            <ActionButton
                              leadingIcon={<EditOutlined aria-hidden="true" />}
                              aria-label={`编辑服务器 ${value.name}`}
                              onClick={() => edit(value)}
                              variant="ghost"
                            />
                          </CardAction>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                            <span>{cores.length} 个已登记核心</span>
                            <span>{listeners.length} 个已保存监听</span>
                            <span>{paths.length} 条已保存路径</span>
                          </div>
                          <p className="text-sm">下一步：{nextStep}</p>
                          <ActionButton onClick={() => openHost(value)} aria-label={`进入服务器 ${value.name}`} variant="default" className="w-full">
                            进入服务器
                          </ActionButton>
                        </CardContent>
                      </Card>
                    ); })}
                  </div>
                ) : (
                  <EmptyState
                    title="暂无服务器"
                    action={
                      <ActionButton
                        onClick={() => edit(null)}
                        variant="default"
                      >
                        添加服务器
                      </ActionButton>
                    }
                  />
                )}
              </TabsContent>
              <TabsContent key={"core-instances"} value={"core-instances"}>
                {data.instances.length ? (
                  <DataTable
                    rowKey="id"
                    rows={data.instances}
                    count={{ total: data.instances.length, unit: "个核心实例" }}
                    minWidth={650}
                    columns={[
                      {
                        title: "\u6838\u5FC3",
                        render: (_, i) => (
                          <button
                            className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            ref={(node) => { if (node) listActions.current.set(`instance:${i.id}`, node); else listActions.current.delete(`instance:${i.id}`); }}
                            onClick={() => openInstance(i)}
                          >
                            {coreName(i)}{" "}
                            <Badge variant="secondary">{i.version}</Badge>
                          </button>
                        ),
                      },
                      {
                        title: "\u670D\u52A1\u5668",
                        render: (_, i) =>
                          data.hosts.find((h) => h.id === i.hostId)?.name ||
                          "\u670D\u52A1\u5668\u5DF2\u79FB\u9664",
                      },
                      {
                        title: "\u76D1\u542C\u7AEF\u70B9",
                        render: (_, i) =>
                          data.endpoints.filter((e) => e.instanceId === i.id)
                            .length,
                      },
                      {
                        title: "操作",
                        align: "right",
                        render: (_, i) => (
                          <TableRowActions name={coreName(i)}>
                            <ActionButton
                              onClick={() => openInstance(i)}
                              variant="outline"
                            >
                              查看状态
                            </ActionButton>
                            <ActionButton
                              aria-label={`编辑 ${coreName(i)}`}
                              onClick={() => edit(i)}
                              leadingIcon={<EditOutlined aria-hidden="true" />}
                              variant="ghost"
                            />
                          </TableRowActions>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <EmptyState
                    title="暂无核心实例"
                    action={
                      <ActionButton
                        onClick={() => edit(null)}
                        variant="default"
                      >
                        添加核心实例
                      </ActionButton>
                    }
                  />
                )}
              </TabsContent>
              <TabsContent
                key={"managed-endpoints"}
                value={"managed-endpoints"}
              >
                {data.endpoints.length ? (
                  <DataTable
                    rowKey="id"
                    rows={data.endpoints}
                    count={{ total: data.endpoints.length, unit: "个端点" }}
                    minWidth={680}
                    columns={[
                      { title: "\u7AEF\u70B9", accessor: "name" },
                      {
                        title: "\u670D\u52A1\u5668 / \u6838\u5FC3",
                        render: (_, e) => {
                          const i = data.instances.find(
                            (i) => i.id === e.instanceId,
                          );
                          return (
                            <span className="grid gap-1">
                              <span>
                                {data.hosts.find((h) => h.id === i?.hostId)
                                  ?.name || "\u2014"}
                              </span>{" "}
                              <span className="text-muted-foreground">
                                {coreName(i)}
                              </span>
                            </span>
                          );
                        },
                      },
                      {
                        title: "\u76D1\u542C\u5730\u5740",
                        render: (_, e) =>
                          `${e.connection.host}:${e.connection.port}`,
                      },
                      {
                        title: "\u534F\u8BAE",
                        render: (_, e) => (
                          <Badge variant="secondary">
                            {e.connection.protocol}
                          </Badge>
                        ),
                      },
                      {
                        title: "操作",
                        align: "right",
                        render: (_, e) => (
                          <TableRowActions name={e.name}>
                            <ActionButton
                              onClick={() => edit(e)}
                              variant="outline"
                            >
                              编辑
                            </ActionButton>
                          </TableRowActions>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <EmptyState
                    title="暂无监听端点"
                    action={
                      <ActionButton
                        onClick={() => edit(null)}
                        variant="default"
                      >
                        添加监听端点
                      </ActionButton>
                    }
                  />
                )}
              </TabsContent>
            </Tabs>
          </Section>
        )}
      </QueryState>
        </>
      ) : data && (
        <section role="region" aria-label={host.name} className="server-workspace min-w-0 space-y-5">
          <ActionButton onClick={backToList} variant="ghost" className="max-w-full">返回服务器清单</ActionButton>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <h1 ref={workspaceHeading} tabIndex={-1} className="break-words text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">{host.name}</h1>
              <p className="break-all text-sm text-muted-foreground">{host.address}</p>
              <Badge variant="secondary">服务器信息已登记</Badge>
            </div>
            <ActionButton onClick={() => edit(host, "hosts")} disabled={!!scopeIssue} variant="outline">编辑服务器</ActionButton>
          </header>
          {(query.isError || query.isPaused) && <Notice tone={query.isError ? "warning" : "info"}>
            {query.isPaused ? "等待网络连接，服务器清单尚未刷新。" : "服务器清单刷新失败，以下保留已有记录与刚保存的配置。"}
            {query.isError && <p>{query.error.message}</p>}
            <ActionButton onClick={() => query.refetch()} variant="outline" size="sm">刷新服务器清单</ActionButton>
          </Notice>}
          {scopeIssue && <Notice tone="warning" title="服务器与核心归属已变更">
            <p>{scopeIssue}</p>
            {instance && data.instances.some((value) => value.id === instance.id && value.hostId !== host.id) && <ActionButton variant="outline" onClick={() => {
              const current = data.instances.find((value) => value.id === instance.id);
              if (current) openInstance(current);
            }}>打开核心所在服务器</ActionButton>}
          </Notice>}
          <Tabs value={section} onValueChange={changeSection} className="min-w-0 space-y-4">
            <ScrollableTabsList>
              <TabsTrigger value="overview">概览</TabsTrigger>
              <TabsTrigger value="cores">核心与监听</TabsTrigger>
              <TabsTrigger value="records">配置记录</TabsTrigger>
              <TabsTrigger value="diagnostics">诊断</TabsTrigger>
            </ScrollableTabsList>
            <ErrorNotice error={instance && section === "cores" ? null : editError} />
            <TabsContent value="overview" className="space-y-4">
              {(!hostCores.length || !hostListeners.length || !records.length) && !scopeIssue && (
                <ServerSetupTip
                  title={!hostCores.length ? "添加第一个核心" : !hostListeners.length ? "添加监听入口" : "设置流量去向"}
                  action={!hostCores.length ? (
                    <ActionButton ref={(node) => { if (node) hostActions.current.set("setup-core", node); else hostActions.current.delete("setup-core"); }} onClick={() => setupAction("core")} variant="outline">开始配置核心</ActionButton>
                  ) : !hostListeners.length ? (
                    <ActionButton ref={(node) => { if (node) hostActions.current.set("setup-listener", node); else hostActions.current.delete("setup-listener"); }} onClick={() => setupAction("listener")} variant="outline">{hostCores.length === 1 ? "设置监听入口" : "选择核心与监听"}</ActionButton>
                  ) : hostListeners.length === 1 ? (
                    <ActionButton asChild variant="outline"><a href={`#routes?entryEndpoint=${encodeURIComponent(hostListeners[0].id)}&returnHost=${encodeURIComponent(host.id)}&returnInstance=${encodeURIComponent(hostListeners[0].instanceId)}`}>创建转发路径</a></ActionButton>
                  ) : <ActionButton onClick={chooseCore} variant="outline">选择监听入口</ActionButton>}
                >
                  {!hostCores.length ? "服务器地址已保存。添加核心后即可接入 Agent。" : !hostListeners.length ? "核心已登记。选择客户端连接的协议与监听地址。" : "监听入口已保存。创建转发路径后，检查并确认应用。"}
                </ServerSetupTip>
              )}
              <ServerResourceOverview host={host} onOpenResources={() => changeSection("diagnostics")} />
              {hostCores.length > 0 && coreList}
              {records.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                <div className="space-y-1"><p className="text-sm font-medium">转发配置</p><p className="text-sm text-muted-foreground">{records.length} 条已保存路径</p></div>
                <ActionButton onClick={() => changeSection("records")} variant="outline">查看转发配置</ActionButton>
              </div>}
              <Accordion type="multiple" className="w-full"><AccordionItem value="identity"><AccordionTrigger>技术标识</AccordionTrigger><AccordionContent><p className="break-all text-sm text-muted-foreground">服务器 ID：{host.id}</p></AccordionContent></AccordionItem></Accordion>
            </TabsContent>
            <TabsContent value="cores" className="space-y-4">
              {instance ? <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <ActionButton onClick={() => edit(instance, "core-instances", host.id)} disabled={!!scopeIssue} variant="outline">编辑核心</ActionButton>
                </div>
      <InstanceDetail
        onClose={closeInstance}
        scopeIssue={scopeIssue}
        readScopeIssue={readScopeIssue}
        headingRef={coreHeading}
        instance={instance}
        inventory={data}
        savedListeners={savedListeners}
        inventoryReadState={query.isPaused ? "paused" : query.isFetching ? "loading" : query.isError ? "error" : "ready"}
        inventoryError={query.error}
        onRefreshInventory={() => query.refetch()}
        enrollmentOpen={enrollmentOpen}
        onCloseEnrollment={() => setEnrollmentOpen(false)}
        onOpenEnrollment={() => {
          const issue = readScopeIssue();
          if (issue) { setEditError(new Error(issue)); return; }
          setRequestedSetup(null);
          ++editSequence.current;
          setEditError(null);
          setEnrollmentOpen(true);
        }}
        editError={editError}
        onEditEndpoint={(endpoint) => {
          if (!instance) return;
          edit(endpoint, "managed-endpoints", instance.hostId, instance.id);
        }}
      />
              </> : coreList}
            </TabsContent>
            <TabsContent value="records" className="space-y-4">
              <Section title="已保存的转发配置" variant="plain">
                {records.length ? records.map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                  <div className="min-w-0"><p className="break-words text-sm font-medium">{record.name}</p><p className="text-sm text-muted-foreground">{record.status === "draft" ? "草稿已保存" : "配置记录已保存"}</p></div>
                  <ActionButton asChild variant="outline"><a href={`#routes?deployment=${encodeURIComponent(record.id)}`}>查看转发路径 {record.name}</a></ActionButton>
                </div>) : <p className="text-sm text-muted-foreground">暂无关联的转发配置</p>}
              </Section>
            </TabsContent>
            <TabsContent value="diagnostics" className="space-y-4">
              <Tabs defaultValue="resources" className="space-y-4">
                <ScrollableTabsList><TabsTrigger value="resources">资源与额度</TabsTrigger><TabsTrigger value="connections">连接诊断</TabsTrigger></ScrollableTabsList>
                <TabsContent value="resources"><NodeObservation host={host} instances={data.instances} /></TabsContent>
                <TabsContent value="connections"><DiagnosticsPanel host={host} instances={data.instances} /></TabsContent>
              </Tabs>
            </TabsContent>
          </Tabs>
        </section>
      )}
      <InventoryEditor
        entity={entity}
        inventory={data}
        scopeIssue={scopeIssue || editorScopeIssue || undefined}
        readScopeIssue={() => readScopeIssue(inventoryTaskScope(entity)) || editorScopeIssue}
        onClose={() => setEntity(null)}
        onClosed={() => {
          if (!focusAfterSave.current) return;
          focusAfterSave.current = false;
          const target = section === "cores" && instance ? coreHeading.current : workspaceHeading.current;
          const focused = document.activeElement;
          if (target?.isConnected && (!focused || focused === document.body || focused.closest('[data-task-overlay][data-state="closed"]')))
            target.focus({ preventScroll: true });
        }}
        onHostCreated={(created) => {
          setCreatedHosts((current) => [...current.filter((saved) => saved.id !== created.id), created]);
          hostResumeAction.current = "add-core";
          replaceView(serverWorkspaceHash(created.id), () => { focusAfterSave.current = true; show(created, null); });
        }}
        onEndpointSaved={(saved) => {
          // The first-listener tip changes to the next task after save. Its
          // trigger can unmount, so return focus to the stable overview title.
          if (section === "overview") focusAfterSave.current = true;
          setSavedListeners((current) => [...current.filter((entry) => entry.id !== saved.id), {
            id: saved.id, instanceId: saved.instanceId, name: saved.name,
            connection: { host: saved.connection.host, port: saved.connection.port, protocol: saved.connection.protocol },
          }]);
        }}
        onCoreCreated={(created) => {
          setCreatedCores((current) => [...current.filter((saved) => saved.id !== created.id), created]);
          const selectedHost = data?.hosts.find((value) => value.id === created.hostId);
          if (selectedHost) replaceView(serverWorkspaceHash(selectedHost.id, created.id), () => { focusAfterSave.current = true; show(selectedHost, created, "cores"); });
        }}
      />
    </>
  );
}
// Interpret only the reconciler's explicit outcomes. An old observation is not
// evidence that its configuration is still running, even after pointer recovery.
function instanceApplyFeedback(data: AgentState) {
  const state = data.state;
  if (!state) return null;
  const failedPhase = [
    "validation_failed",
    "apply_failed",
    "unknown",
    "blocked",
  ].includes(state.phase);
  const inFlight = [
    "accepted",
    "native_validated",
    "applying",
    "applied_unobserved",
  ].includes(state.phase);
  if (!state.code && !failedPhase && (!state.recoveryRequired || inFlight))
    return null;
  if (
    !state.recoveryRequired &&
    ["artifact_installed", "local_session_stopped"].includes(state.code || "")
  )
    return null;

  let title = "实例结果需要核对";
  let explanation = "节点返回了尚未识别的处理结果，无法确认本次配置是否应用。";
  let nextStep =
    "请刷新实例状态并查看实例技术详情，核对节点记录后再决定是否重新检查并应用。";
  if (state.recoveryRequired || state.phase === "unknown") {
    title = "应用结果尚未确认";
    explanation = "尚不能确认本次配置是否应用，也不能确认旧配置仍在运行。";
    nextStep = "请先刷新实例状态并核对节点运行情况；结果明确前不要重复应用。";
  } else if (state.phase === "blocked" && state.code === "policy_restricted") {
    title = "节点已执行访问限制";
    explanation = "节点上次核对已确认该实例停止运行，访问限制已执行。";
    nextStep =
      "如需恢复运行，请先核对访问授权，再通过「实例操作」检查并确认新的启动计划。";
  } else if (state.phase === "validation_failed") {
    title = "配置未通过节点检查";
    explanation = "本次配置未通过节点校验，未进入应用步骤。";
    nextStep =
      "请查看实例技术详情并核对节点校验记录，编辑转发路径修复问题，再重新检查并确认应用。";
  } else if (
    state.phase === "apply_failed" &&
    ["recovered_not_applied", "activation_not_applied"].includes(
      state.code || "",
    )
  ) {
    title = "本次配置未应用";
    explanation =
      state.code === "recovered_not_applied"
        ? "节点核对后确认，本次配置未应用。"
        : "节点确认，本次配置未应用。";
    nextStep =
      "请返回对应的转发路径，核对配置与节点状态，重新检查并明确确认应用。";
  } else if (
    state.phase === "apply_failed" &&
    state.code === "runtime_not_running"
  ) {
    title = "节点报告核心未运行";
    explanation = "最近一次节点核对未发现该实例的运行进程。";
    nextStep =
      "请核对节点与转发路径，再通过「实例操作」检查并确认新的启动计划。";
  }
  if (data.phase === "pending-new-generation") {
    return {
      title:
        state.code === "policy_restricted"
          ? "上次节点处理记录"
          : "上次尝试需要处理",
      explanation: `上次记录：${explanation.replaceAll("本次", "上次")}`,
      nextStep:
        "新的配置正在等待节点确认；以上是上次尝试的记录，不代表这次应用失败。请先刷新实例状态，等待本次结果。",
    };
  }
  return { title, explanation, nextStep };
}

export function InstanceObservation({ instanceId }: { instanceId: string }) {
  const query = useQuery({
    queryKey: ["instance-state", instanceId],
    queryFn: () => request<AgentState>(`/agent/instances/${instanceId}/state`),
    // Terminal observations and failed reads can change without a local mutation.
    // Keep observing while mounted; fetching is not evidence of node liveness.
    refetchInterval: (q) =>
      [
        "queued",
        "accepted",
        "native_validated",
        "applying",
        "applied_unobserved",
        "unknown",
        "pending-new-generation",
      ].includes(q.state.data?.phase || "") ||
      (q.state.data?.serviceIntent?.running &&
        [
          "awaiting_observation",
          "running",
          "recovery_backoff",
          "recovery_queued",
        ].includes(q.state.data.serviceIntent.status))
        ? 5000
        : 30000,
  });
  const data = query.data;
  const feedback = data ? instanceApplyFeedback(data) : null;
  return (
    <QueryState
      loading={query.isPending}
      paused={query.isPaused}
      loadingLayout="summary"
      error={data ? null : query.error}
      retry={() => query.refetch()}
    >
      {data && (
        <>
          {(query.isFetching || query.isPaused || query.isError) && (
            <Notice tone={query.isError ? "warning" : "info"}>
              {query.isPaused ? "等待网络连接，以下为上次读取的实例记录。"
                : query.isFetching ? "正在刷新，以下为上次读取的实例记录。"
                : "刷新失败，以下为上次读取的实例记录。"}
              {query.isError && <p>{query.error.message}</p>}
            </Notice>
          )}
          <div className="instance-phase flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1"><p className="text-xs text-muted-foreground">平台最近记录的实例状态</p><Badge variant="secondary">{phaseLabel(data.phase)}</Badge></div>
            <ActionButton
              leadingIcon={<ReloadOutlined aria-hidden="true" />}
              aria-label="刷新实例状态"
              keepFocusableWhilePending
              pending={query.isFetching}
              onClick={() => query.refetch()}
              variant="ghost"
              size="sm"
            />
          </div>
          {data.serviceIntent ? (
            <div
              className="space-y-2 rounded-lg border p-3"
              aria-label="持续服务授权"
            >
              <p className="text-sm font-medium">
                {(
                  {
                    awaiting_observation: "持续服务等待节点确认",
                    running: "持续服务已授权",
                    recovery_backoff: "自动恢复等待重试",
                    recovery_queued: "自动恢复已提交",
                    crash_loop_blocked: "自动恢复已暂停",
                    review_required: "持续服务需要重新检查",
                    disabled: "持续服务授权已关闭",
                    superseded: "持续服务授权已被后续操作替代",
                  } as Record<string, string>
                )[data.serviceIntent.status] || "持续服务状态待确认"}
              </p>
              <p className="text-sm text-muted-foreground">
                已用自动恢复次数：{data.serviceIntent.automaticAttempts} / 3
              </p>
              {data.serviceIntent.nextAttemptAt && (
                <p className="text-sm text-muted-foreground">
                  下次尝试：{dateLabel(data.serviceIntent.nextAttemptAt)}
                </p>
              )}
              {["crash_loop_blocked", "review_required"].includes(
                data.serviceIntent.status,
              ) && (
                <p className="text-sm">
                  请核对当前配置、权限与节点状态，再重新检查并明确创建新的持续运行计划。结果未确认时不会自动重放。
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                此处为平台保存的授权记录，不代表核心当前在线；请结合节点上报时间核对运行结果。
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">未设置持续服务授权</p>
          )}
          {data.state?.observed && (
            <p className="muted text-sm text-muted-foreground">
              最近节点上报 {dateLabel(data.state.observed.observedAt)}
            </p>
          )}
          {feedback && (
            <Notice tone="warning" title={feedback.title} aria-label="实例处理建议">
              <p>{feedback.explanation}</p>
              <p>{feedback.nextStep}</p>
            </Notice>
          )}
          <Accordion type="multiple" defaultValue={[]} className="w-full">
            {[
              {
                key: "details",
                label: "\u5B9E\u4F8B\u6280\u672F\u8BE6\u60C5",
                children: (
                  <CodePreview content={JSON.stringify(data, null, 2)} />
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
    </QueryState>
  );
}
function InstanceDetail({
  scopeIssue,
  readScopeIssue,
  onClose,
  headingRef,
  instance,
  inventory,
  savedListeners,
  inventoryReadState,
  inventoryError,
  onRefreshInventory,
  onOpenEnrollment,
  enrollmentOpen,
  onCloseEnrollment,
  editError,
  onEditEndpoint,
}: {
  scopeIssue: string | null;
  readScopeIssue: () => string | null;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  instance: CoreInstance | null;
  inventory?: Infrastructure;
  savedListeners: ManagedEndpoint[];
  inventoryReadState: "loading" | "paused" | "error" | "ready";
  inventoryError: Error | null;
  onRefreshInventory: () => void;
  onOpenEnrollment: () => void;
  enrollmentOpen: boolean;
  onCloseEnrollment: () => void;
  editError: Error | null;
  onEditEndpoint: (endpoint: ManagedEndpoint | null) => void;
}) {
  const retained = savedListeners.filter((saved) => saved.instanceId === instance?.id);
  const endpoints = inventory?.endpoints.filter((endpoint) => endpoint.instanceId === instance?.id);
  const deployments = inventory?.deployments.filter((deployment) =>
    deployment.ir.programs.some((program) => program.instance.id === instance?.id),
  );
  return (
    <section role="region" aria-label={instance ? `${inventory?.hosts.find((h) => h.id === instance.hostId)?.name || instance.hostId}的${coreName(instance)}` : undefined} className="min-w-0 space-y-5">
      {instance && (
        <>
          <ActionButton onClick={onClose} variant="ghost">返回核心列表</ActionButton>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">核心配置已登记</p>
            <h2 ref={headingRef} tabIndex={-1} className="break-words text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">{coreName(instance)}</h2>
            <p className="text-sm text-muted-foreground">{instance.adapterId.replace(/^routeweaver\//, "")} {instance.version}</p>
          </div>
          <Section
            title="1. Agent 接入与上报"
            extra={
              <ActionButton
                disabled={!!scopeIssue}
                leadingIcon={<KeyOutlined aria-hidden="true" />}
                onClick={() => {
                  onOpenEnrollment();
                }}
                variant="outline"
              >
                接入 Agent
              </ActionButton>
            }
          >
            <InstanceObservation instanceId={instance.id} />
          </Section>
          <ErrorNotice error={editError} />
          <Section
            title="2. 配置监听端点"
            variant="plain"
            extra={
              <ActionButton
                
                disabled={!!scopeIssue}
                onClick={() => onEditEndpoint(null)}
                variant={endpoints?.length ? "outline" : "default"}
              >
                添加监听端点
              </ActionButton>
            }
          >
            {(retained.length > 0 || inventoryReadState !== "ready") && (
              <Notice tone={inventoryReadState === "error" ? "warning" : "info"}>
                {inventoryReadState === "error"
                  ? retained.length ? "清单刷新失败，以下保留刚保存的监听端点。" : "清单刷新失败，以下为上次读取的监听端点。"
                  : inventoryReadState === "paused"
                    ? "等待网络连接，监听端点清单尚未刷新。"
                    : inventoryReadState === "loading"
                      ? "正在刷新监听端点清单。"
                      : "监听端点已保存，清单尚未包含这次更新。"}
                {inventoryReadState === "error" && <p>{inventoryError?.message}</p>}
                {inventoryReadState !== "loading" && (
                  <ActionButton onClick={onRefreshInventory} variant="outline" size="sm">刷新监听端点清单</ActionButton>
                )}
              </Notice>
            )}
            {endpoints?.length === 0 && inventoryReadState === "ready" && (
              <p className="text-sm text-muted-foreground">此核心尚未配置监听端点。</p>
            )}
            {endpoints?.map((endpoint) => (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4" key={endpoint.id}>
                <div className="min-w-0 space-y-1">
                  <h3 className="break-words text-sm font-semibold">{endpoint.name}</h3>
                  <p className="break-all text-sm">{endpoint.connection.host}:{endpoint.connection.port}</p>
                  <p className="text-sm text-muted-foreground">{endpoint.connection.protocol}</p>
                </div>
                <ActionButton
                  
                  disabled={!!scopeIssue}
                  aria-label={`编辑监听端点 ${endpoint.name}`}
                  onClick={() => onEditEndpoint(endpoint)}
                  variant="outline"
                >
                  编辑
                </ActionButton>
              </div>
            ))}
          </Section>
          <Section title="3. 配置转发路径" variant="plain">
            {deployments?.length ? (
              <div className="space-y-2">
                {deployments.map((deployment) => (
                  <ActionButton key={deployment.id} asChild variant="outline" className="h-auto max-w-full whitespace-normal text-left">
                    <a href={`#routes?deployment=${encodeURIComponent(deployment.id)}`}>
                      查看转发路径 {deployment.name}
                    </a>
                  </ActionButton>
                ))}
              </div>
            ) : endpoints?.length && !scopeIssue ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">选择监听入口，继续设置流量去向。</p>
                {endpoints.map((endpoint) => (
                  <ActionButton key={endpoint.id} asChild variant={endpoints.length === 1 ? "default" : "outline"} className="h-auto max-w-full whitespace-normal text-left">
                    <a href={`#routes?entryEndpoint=${encodeURIComponent(endpoint.id)}&returnHost=${encodeURIComponent(instance.hostId)}&returnInstance=${encodeURIComponent(instance.id)}`}>
                      用 {endpoint.name} 创建转发路径
                    </a>
                  </ActionButton>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{scopeIssue ? "请先重新选择核心所在服务器，再继续配置转发路径。" : "添加监听端点后，可用它配置转发路径。"}</p>
            )}
            {endpoints && endpoints.length > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">保存监听端点不会修改节点。转发路径需另行检查并确认应用。</p>
            )}
          </Section>
          <AccountingRecovery instanceId={instance.id} />
          {enrollmentOpen && (
            <Enrollment
              key={`${instance.hostId}:${instance.id}`}
              instance={instance}
              scopeIssue={scopeIssue}
              readScopeIssue={readScopeIssue}
              onClose={onCloseEnrollment}
            />
          )}
        </>
      )}
    </section>
  );
}
function Enrollment({
  instance,
  scopeIssue,
  readScopeIssue,
  onClose,
}: {
  instance: CoreInstance;
  scopeIssue: string | null;
  readScopeIssue: () => string | null;
  onClose: () => void;
}) {
  const [form] = useForm();
  const [dateOpen, setDateOpen] = useState(false);
  const [datePending, setDatePending] = useState(false);
  const [result, setResult] = useState<{
    scope: {
      nodeId: string;
      instanceId: string;
      enrollmentEpoch: string;
    };
    token: string;
  } | null>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    form.setFieldsValue({
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    return () => {
      active.current = false;
    };
  }, [form]);
  const mutation = useMutation({
    mutationFn: async (values: {
      expiresAt: string;
      nodeId: string;
      instanceId: string;
    }) => {
      if (!active.current) return;
      const issue = readScopeIssue();
      if (issue) throw new Error(issue);
      const issued = await post<NonNullable<typeof result>>(
        "/agent/enrollments",
        values,
      );
      // Token material belongs only to this mounted task, never the mutation
      // cache or a later task opened for the same instance.
      if (active.current) setResult(issued);
    },
    retry: false,
    networkMode: "always",
    gcTime: 0,
    onSettled: () => {
      if (active.current) submitting.current = false;
    },
  });
  useUnsavedChanges(
    mutation.isPending || !!result,
    mutation.isPending
      ? "接入凭据正在创建。离开不会取消操作，旧凭据可能已失效；新令牌返回后将无法在此页查看。"
      : "离开将清除此页显示的接入令牌，请先保存到对应服务器。旧凭据已失效。",
  );
  const close = () => {
    if (!active.current || submitting.current) return;
    active.current = false;
    onClose();
  };
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title="接入核心实例"
      open
      pending={mutation.isPending}
      footer={null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {scopeIssue && <Notice tone="warning" title="接入范围需要重新选择">
        <p>{scopeIssue}</p>
        {result && <p>此处保留的是原接入范围的令牌，不要将它用于新的服务器。</p>}
      </Notice>}
      {result ? (
        <>
          <Notice tone="success" title="接入凭据已创建">
            {
              "\u53EA\u5C06\u5B83\u914D\u7F6E\u5230\u6B64\u670D\u52A1\u5668\u7684\u5BF9\u5E94\u6838\u5FC3\u5B9E\u4F8B\u3002\u4E0D\u8981\u5206\u4EAB\u7ED9\u5176\u4ED6\u4EBA\u3002"
            }
          </Notice>
          <p className="text-sm text-muted-foreground">
            凭据创建不会安装或启动 Agent。请在对应服务器配置 Agent，再返回查看上报。
          </p>
          <label className="standalone-label grid gap-2 text-sm font-medium mt-5">
            接入令牌
            <Input
              value={result.token}
              readOnly
              autoComplete="off"
              type="password"
            />
          </label>
          <Accordion type="multiple" defaultValue={[]} className="w-full">
            {[
              {
                key: "scope",
                label: "Agent \u914D\u7F6E\u8303\u56F4",
                children: (
                  <CodePreview
                    content={JSON.stringify(result.scope, null, 2)}
                  />
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
          <div className="space-y-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">关闭后将清除此页显示的令牌，请先保存到对应服务器。</p>
            <ActionButton onClick={close} variant="default">关闭令牌并查看实例</ActionButton>
          </div>
        </>
      ) : (
        <AppForm<{ expiresAt: string }>
          form={form}
          disabled={mutation.isPending}
          onFinish={(v) => {
            if (
              !active.current || submitting.current || result ||
              dateOpen || datePending || readScopeIssue()
            ) return;
            submitting.current = true;
            mutation.mutate({
              expiresAt: v.expiresAt,
              nodeId: instance.hostId,
              instanceId: instance.id,
            });
          }}
        >
          <ErrorNotice error={mutation.error} />
          <p className="muted text-sm text-muted-foreground mb-5">
            创建仅能访问此核心实例的接入凭据。如果实例已接入，旧凭据会失效，需在服务器更新配置。
          </p>
          <AppField
            name="expiresAt"
            label="凭据到期时间"
            rules={[{ required: true }]}
          >
            <PolicyDateInput
              allowClear={false}
              onOpenChange={setDateOpen}
              onPendingChange={setDatePending}
            />
          </AppField>
          <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
            <ActionButton
              onClick={close}
              disabled={mutation.isPending}
              variant="outline"
            >
              取消
            </ActionButton>
            <ActionButton
              type="submit"
              disabled={dateOpen || datePending || !!scopeIssue}
              pending={mutation.isPending}
              variant="default"
            >
              创建接入凭据
            </ActionButton>
          </div>
        </AppForm>
      )}
    </TaskDialog>
  );
}





