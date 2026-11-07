import {
  OperationalIntegerInput,
  operationalInteger,
} from "./OperationalIntegerInput";
import { Metadata } from "@/ui-patterns/metadata";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { AppField, AppForm, useForm } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown as ArrowDownOutlined,
  ArrowUp as ArrowUpOutlined,
  Trash2 as DeleteOutlined,
  Plus as PlusOutlined,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DataTable, TableRowActions } from "./DataTable";
import { loadInfrastructure } from "./infrastructure-data";
import { RouteExitEditor } from "./RouteExitEditor";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import { UserEntries } from "./UserEntries";
import { UserPolicyEditor } from "./UserPolicyEditor";
import {
  policySource,
  policyStatus,
  type EffectivePolicy,
} from "./access-policy-model";
import { APIError, list, loadState, post, request, saveRecord } from "./api";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { moveItem, newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import { invalidateOutputInputs } from "./output-comparison";
import type { Infrastructure, PlatformEntry, ServerDeployment } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";
interface RoutePathSummary {
  hops: {
    endpointId: string;
    name?: string;
    metadataState: "snapshot" | "unavailable";
  }[];
}
export interface PublishedRoute {
  revisionToken?: string;
  id: string;
  name: string;
  deploymentId: string;
  endpointIds: string[];
  publicHost: string;
  publicPort: number;
  status: string;
  diagnostics: string[];
  fingerprint?: string;
  pendingChanges?: boolean;
  savedPath?: RoutePathSummary;
  effective?: {
    publicHost: string;
    publicPort: number;
    endpointIds: string[];
    fingerprint: string;
    path?: RoutePathSummary;
  } | null;
  path?: {
    id: string;
    entry: string;
    exit: string;
    links: string[];
  };
}
function RoutePathComparison({ route }: { route: PublishedRoute }) {
  const saved = route.savedPath;
  const confirmed = route.effective?.path;
  const status = (
    <Badge className="whitespace-normal max-w-full" variant="secondary">
      {route.pendingChanges && route.status === "effective"
        ? "上次配置已确认，修改尚待应用"
        : route.status === "draft"
          ? "草稿已保存，尚未确认应用"
          : routeStatus(route.status) || "未知"}
    </Badge>
  );
  if (!saved?.hops.length) return <p>运行配置：{status}</p>;
  const name = (hop: RoutePathSummary["hops"][number]) =>
    hop.metadataState === "snapshot" ? hop.name?.trim() : undefined;
  const all = [...saved.hops, ...(confirmed?.hops || [])];
  const sequence = (path: RoutePathSummary) =>
    path.hops
      .map((hop) => {
        const label = name(hop);
        if (!label) return hop.endpointId;
        return all.some(
          (other) =>
            other.endpointId !== hop.endpointId && name(other) === label,
        )
          ? `${label}（${hop.endpointId}）`
          : label;
      })
      .join(" → ");
  const same =
    confirmed?.hops.length === saved.hops.length &&
    saved.hops.every(
      (hop, index) => hop.endpointId === confirmed.hops[index]?.endpointId,
    );
  return (
    <div>
      <dl className="grid gap-4 my-4 break-words">
        {confirmed && (
          <div aria-label="已确认路径">
            <dt className="muted text-sm text-muted-foreground mb-1">
              已确认路径
            </dt>
            <dd className="m-0">
              <strong>{sequence(confirmed)}</strong>
              {same && (
                <span className="muted text-sm text-muted-foreground">
                  （已保存路径端点相同）
                </span>
              )}
            </dd>
          </div>
        )}
        {!same && (
          <div aria-label="已保存路径">
            <dt className="muted text-sm text-muted-foreground mb-1">
              已保存路径
            </dt>
            <dd className="m-0">
              <strong>{sequence(saved)}</strong>
            </dd>
          </div>
        )}
      </dl>
      <div aria-label="运行配置">{status}</div>
    </div>
  );
}
function RoutePublicAddress({ route }: { route: PublishedRoute }) {
  const effective = route.effective;
  const same =
    effective?.publicHost === route.publicHost &&
    effective.publicPort === route.publicPort;
  return (
    <div className="my-4 break-words">
      <p>
        {same ? "对外地址" : "已保存的对外地址"}：{route.publicHost}:
        {route.publicPort}
      </p>
      {effective && !same && (
        <p>
          已确认的对外地址：{effective.publicHost}:{effective.publicPort}
        </p>
      )}
    </div>
  );
}
const routeStatus = (status: string) =>
  ({ effective: "已确认生效", queued: "等待部署确认", draft: "草稿" })[
    status
  ] || status;
// Matches the verified public-account entry adapters accepted by the API.
// Other core adapters remain available for transit and existing route editing.
const publicEntryVersions: Record<string, readonly string[]> = {
  "routeweaver/managed-xray": ["26.3.27-rw1"],
};
function supportsPublicUsers(
  route: PublishedRoute,
  deployment?: ServerDeployment,
) {
  const entry = deployment?.ir.programs.find(
    (p) => p.listener.id === route.endpointIds[0],
  );
  return (
    !!entry &&
    !!publicEntryVersions[entry.instance.adapterId]?.includes(
      entry.instance.version,
    ) &&
    entry.listener.connection.protocol === "vless"
  );
}
function EntryPrerequisite({ deployment }: { deployment?: ServerDeployment }) {
  return (
    <Notice tone="warning" title="此入口暂不能分配独立用户">
      {
        <>
          <p>请先配置受管 Xray 的 VLESS 监听端点，再将其设为转发路径入口。</p>
          <div className={"flex flex-wrap items-center gap-2"}>
            <a href="#servers">配置服务器入口</a>
            {deployment && (
              <a
                href={`#routes?deployment=${encodeURIComponent(deployment.id)}`}
              >
                查看转发路径「{deployment.name}」
              </a>
            )}
          </div>
        </>
      }
    </Notice>
  );
}
export function PublishedRoutesPage() {
  const replaceView = useWorkspaceViewEntry((hash) => {
    const target = new URLSearchParams(hash.split("?")[1] || "").get("line");
    setEditing((current) => (current?.id === target ? current : null));
  });
  const query = useQuery({
    queryKey: ["published-routes"],
    queryFn: () => list<PublishedRoute>("/published-routes"),
  });
  const infrastructure = useQuery({
    queryKey: ["infrastructure"],
    queryFn: loadInfrastructure,
  });
  const [editing, setEditing] = useState<PublishedRoute | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [principal, setPrincipal] = useState<PublishedRoute | null>(null);
  const [detail, setDetail] = useState<PublishedRoute | null>(null);
  const [contextError, setContextError] = useState<Error | null>(null);
  const [selectedUser, setSelectedUser] = useState<string>();
  const [exitTask, setExitTask] = useState<{
    route: PublishedRoute;
    deployment: ServerDeployment;
    inventory: Infrastructure;
    open: boolean;
    pending: boolean;
    removeAfterClose: boolean;
  } | null>(null);
  const [exitFocusRevision, setExitFocusRevision] = useState(0);
  const openExitTask = (
    route: PublishedRoute,
    deployment: ServerDeployment,
    inventory: Infrastructure,
  ) =>
    setExitTask((current) =>
      current
        ? { ...current, open: true }
        : {
            route,
            deployment,
            inventory,
            open: true,
            pending: false,
            removeAfterClose: false,
          },
    );
  const [requestedLine, setRequestedLine] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] || "").get("line"),
  );
  useEffect(() => {
    const changed = () => {
      const params = new URLSearchParams(location.hash.split("?")[1] || "");
      setDetail((current) =>
        current?.id === params.get("line") ? current : null,
      );
      setRequestedLine(params.get("line"));
      setSelectedUser(params.get("user") || undefined);
    };
    changed();
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!requestedLine || !query.data || editing || principal) return;
    const found = query.data.find((line) => line.id === requestedLine);
    if (found) {
      setDetail(found);
      setContextError(null);
    } else setContextError(new Error("找不到指定线路，请从列表中重新选择。"));
    setRequestedLine(null);
  }, [requestedLine, query.data, editing, principal]);
  const openDetail = (line: PublishedRoute) => {
    setContextError(null);
    setDetail(line);
    setSelectedUser(undefined);
    replaceView(`#published-routes?line=${encodeURIComponent(line.id)}`);
  };
  const create = () => {
    setIsNew(true);
    setEditing({
      id: newID("public-route"),
      name: "",
      deploymentId: "",
      endpointIds: [],
      publicHost: "",
      publicPort: 443,
      status: "draft",
      diagnostics: [],
    });
  };
  const needsTransferPath = infrastructure.data?.deployments.length === 0;
  const creationDisabled = !infrastructure.data || !!infrastructure.error;
  const creationAction = needsTransferPath ? (
    <ActionButton
      leadingIcon={<PlusOutlined aria-hidden="true" />}
      variant="default"
      asChild
    >
      <a
        href="#routes"
        aria-disabled={creationDisabled || undefined}
        tabIndex={creationDisabled ? -1 : undefined}
        onClick={(event) => {
          if (creationDisabled) event.preventDefault();
        }}
      >
        创建转发路径
      </a>
    </ActionButton>
  ) : (
    <ActionButton
      leadingIcon={<PlusOutlined aria-hidden="true" />}
      variant="default"
      disabled={creationDisabled}
      onClick={create}
    >
      配置公开线路
    </ActionButton>
  );
  return (
    <>
      <PageHeader title="线路" action={creationAction} />
      {exitTask && !exitTask.open && (
        <Notice
          tone={exitTask.pending ? "warning" : "info"}
          title={`「${exitTask.route.name}」${exitTask.pending ? "的出口变更保存结果尚未确认" : "有待继续的出口变更"}`}
          action={
            <ActionButton
              className="min-h-11"
              onClick={() =>
                setExitTask((current) => current && { ...current, open: true })
              }
              variant="outline"
            >
              继续核对
            </ActionButton>
          }
        />
      )}
      <QueryState
        loading={query.isPending || infrastructure.isPending} paused={query.isPaused || infrastructure.isPaused} loadingLayout="table"
        error={query.error || infrastructure.error}
        retry={() => {
          query.refetch();
          infrastructure.refetch();
        }}
      >
        <ErrorNotice error={contextError} />
        <Section variant="plain">
          {!query.data?.length ? (
            <EmptyState
              title="暂无线路"
              description={
                needsTransferPath ? "需先建立服务器转发路径。" : undefined
              }
            />
          ) : (
            <DataTable
              rowKey="id"
              rows={query.data}
              minWidth={720}
              columns={[
                {
                  title: "线路",
                  render: (_, r) => (
                    <button
                      className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openDetail(r)}
                    >
                      {r.name}
                    </button>
                  ),
                },
                {
                  title: "对外地址",
                  render: (_, r) =>
                    `${r.effective?.publicHost || r.publicHost}:${r.effective?.publicPort || r.publicPort}`,
                },
                {
                  title: "转发路径",
                  render: (_, r) =>
                    infrastructure.data?.deployments.find(
                      (d) => d.id === r.deploymentId,
                    )?.name || r.deploymentId,
                },
                {
                  title: "状态",
                  render: (_, r) => (
                    <div className={"flex flex-wrap items-center gap-2"}>
                      <Badge variant="secondary">
                        {r.pendingChanges && r.status === "effective"
                          ? "上次发布仍生效"
                          : routeStatus(r.status)}
                      </Badge>
                      {r.pendingChanges && (
                        <Badge variant="secondary">草稿待应用</Badge>
                      )}
                    </div>
                  ),
                },
                {
                  title: "操作",
                  align: "right",
                  render: (_, r) => (
                    <TableRowActions name={r.name}>
                      <ActionButton
                        onClick={() => setPrincipal(r)}
                        variant="outline"
                      >
                        配置用户入口
                      </ActionButton>
                      <ActionButton
                        onClick={() => {
                          setIsNew(false);
                          setEditing(r);
                        }}
                        variant="ghost"
                      >
                        编辑
                      </ActionButton>
                    </TableRowActions>
                  ),
                },
              ]}
            />
          )}
        </Section>
      </QueryState>
      {editing && infrastructure.data && (
        <PublicRouteEditor
          initial={editing}
          isNew={isNew}
          inventory={infrastructure.data}
          onClose={() => setEditing(null)}
          onSaved={(value) =>
            replaceView(
              `#published-routes?line=${encodeURIComponent(value.id)}${selectedUser ? `&user=${encodeURIComponent(selectedUser)}` : ""}`,
              () => {
                setEditing(null);
                setDetail(value);
              },
            )
          }
        />
      )}
      {principal && (
        <PrincipalEditor
          key={principal.id}
          route={principal}
          deployment={infrastructure.data?.deployments.find(
            (d) => d.id === principal.deploymentId,
          )}
          onClose={(userId) => {
            setPrincipal(null);
            setDetail(principal);
            setSelectedUser(userId);
            replaceView(
              `#published-routes?line=${encodeURIComponent(principal.id)}${userId ? `&user=${encodeURIComponent(userId)}` : ""}`,
            );
          }}
        />
      )}
      {detail && !editing && (
        <PublicRouteDetail
          key={`detail:${detail.id}`}
          route={detail}
          sharedLines={(query.data || [])
            .filter(
              (line) =>
                line.id !== detail.id &&
                line.deploymentId === detail.deploymentId,
            )
            .map((line) => line.name)}
          inventory={infrastructure.data}
          initialUserId={selectedUser}
          exitChangeOpen={!!exitTask?.open}
          exitFocusRevision={exitFocusRevision}
          pendingExitRouteName={exitTask?.route.name}
          onRetarget={openExitTask}
          onUserSelected={setSelectedUser}
          onEdit={(line) => {
            setIsNew(false);
            setEditing(line);
          }}
          onClose={() => {
            setDetail(null);
            replaceView("#published-routes");
          }}
        />
      )}
      {exitTask && (
        <RouteExitEditor
          key={`exit:${exitTask.route.id}`}
          route={exitTask.route}
          deployment={exitTask.deployment}
          inventory={exitTask.inventory}
          open={exitTask.open}
          onPendingChange={(pending) =>
            setExitTask((current) => current && { ...current, pending })
          }
          onClose={(pending) => {
            setExitTask(
              (current) =>
                current && {
                  ...current,
                  open: false,
                  pending: !!pending,
                  removeAfterClose: !pending,
                },
            );
            query.refetch();
            infrastructure.refetch();
          }}
          onAfterClose={() => {
            setExitFocusRevision((value) => value + 1);
            setExitTask((current) =>
              current?.removeAfterClose ? null : current,
            );
          }}
          onSaved={() => {
            setExitTask((current) =>
              current?.open
                ? {
                    ...current,
                    open: false,
                    pending: false,
                    removeAfterClose: true,
                  }
                : null,
            );
            query.refetch();
            infrastructure.refetch();
          }}
        />
      )}
    </>
  );
}
function PublicRouteEditor({
  initial,
  isNew,
  inventory,
  onClose,
  onSaved,
}: {
  initial: PublishedRoute;
  isNew: boolean;
  inventory: Infrastructure;
  onClose: () => void;
  onSaved: (route: PublishedRoute) => boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [publicPort, setPublicPort] = useState<number | string>(initial.publicPort);
  const portDirty = String(publicPort) !== String(initial.publicPort);
  const { confirm: confirmDiscard, confirming: discardConfirming } =
    useDiscardConfirmation(initial.id);
  const [discardClosing, setDiscardClosing] = useState(false);
  const [pendingEndpoints, setPendingEndpoints] = useState<
    Record<string, boolean>
  >({});
  const markPending = (key: string, pending: boolean) =>
    setPendingEndpoints((previous) =>
      previous[key] === pending ? previous : { ...previous, [key]: pending },
    );
  const addKey = `add-${draft.deploymentId}-${draft.endpointIds.join("/")}`;
  const selectionPending =
    draft.endpointIds.some((id) => pendingEndpoints[id]) ||
    pendingEndpoints[addKey];
  useUnsavedChanges(
    JSON.stringify(draft) !== JSON.stringify(initial) || portDirty || selectionPending,
  );
  const [preview, setPreview] = useState<PublishedRoute | null>(null);
  const [checkedBefore, setCheckedBefore] = useState(false);
  const version = useRef(0);
  const client = useQueryClient();
  const message = toast;
  const deployment = inventory.deployments.find(
    (d) => d.id === draft.deploymentId,
  );
  const pathInventory = {
    ...inventory,
    endpoints: (deployment?.ir.programs || []).map((p) => p.listener),
    instances: (deployment?.ir.programs || []).map((p) => p.instance),
  };
  const payload = () => {
    const port = operationalInteger(publicPort, 1, 65535);
    if (port === undefined) throw new Error("对外端口须为 1–65535 的整数，且不能留空。");
    return {
      id: draft.id,
      name: draft.name,
      deploymentId: draft.deploymentId,
      endpointIds: draft.endpointIds,
      publicHost: draft.publicHost,
      publicPort: port,
    };
  };
  const update = (patch: Partial<PublishedRoute>) => {
    if (patch.publicPort !== undefined) setPublicPort(patch.publicPort);
    version.current++;
    setDraft({ ...draft, ...patch });
    setPreview(null);
  };
  const inspect = useMutation({
    mutationFn: async () => {
      const revision = version.current;
      return {
        value: await post<PublishedRoute>(
          "/published-routes/preview",
          payload(),
        ),
        revision,
      };
    },
    onSuccess: ({ value, revision }) => {
      if (version.current === revision) {
        setPreview(value);
        setCheckedBefore(true);
      }
    },
  });
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    // Carry the originating view completion through the request; options may rerender.
    mutationFn: (_complete: typeof onSaved) =>
      saveRecord<PublishedRoute>(
        "published-routes",
        { ...payload(), revisionToken: initial.revisionToken },
        isNew,
      ),
    onSuccess: (value, complete) => {
      // The save is a committed account fact even if its originating view has left.
      client.invalidateQueries({ queryKey: ["published-routes"] });
      client.invalidateQueries({
        queryKey: ["published-route-resolve", draft.id],
      });
      if (complete(value)) message.success("线路已保存");
    },
  });
  const chooseDeployment = (id: string) => {
    const d = inventory.deployments.find((d) => d.id === id);
    const first = d?.ir.programs[0];
    const host = inventory.hosts.find((h) => h.id === first?.instance.hostId);
    update({
      deploymentId: id,
      endpointIds: d?.ir.programs.map((p) => p.listener.id) || [],
      publicHost: host?.address || "",
      publicPort: first?.listener.connection.port || 443,
    });
  };
  const close = () => {
    if (save.isPending) return;
    if (!selectionPending && !portDirty && JSON.stringify(draft) === JSON.stringify(initial))
      return onClose();
    confirmDiscard(
      {
        title: "放弃未保存的公开线路修改？",
        description: "当前公开线路输入尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => setDiscardClosing(true),
    );
  };
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title={isNew ? "配置公开线路" : `编辑 ${initial.name}`}
      open={!discardClosing}
      onOpenChange={(next) => {
        if (!next) close();
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
      size="lg"
      pending={save.isPending}
    >
      <ErrorNotice error={inspect.error || save.error} />
      {save.error instanceof APIError && save.error.status === 409 && (
        <Notice
          tone="warning"
          title="线路已被其他修改更新。当前输入保留，但不能覆盖新版本。"
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
                      queryKey: ["published-routes"],
                    });
                    await client.invalidateQueries({
                      queryKey: ["published-route-resolve", draft.id],
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
      <Notice
        tone="info"
        title={
          preview
            ? "核对检查结果后保存"
            : checkedBefore
              ? "内容已变更，请重新检查线路。"
              : "先检查线路，再核对结果并保存；用户授权与服务器配置应用需分别确认。"
        }
      />
      <div inert={save.isPending} className="space-y-5">
        <label className="standalone-label grid gap-2 text-sm font-medium">
          线路名称
          <Input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label className="standalone-label grid gap-2 text-sm font-medium">
          服务器转发路径
          <ChoiceSelect
            value={draft.deploymentId || undefined}
            options={inventory.deployments.map((d) => ({
              value: d.id,
              label: d.name,
            }))}
            onValueChange={(value) => {
              if (value !== undefined) chooseDeployment(value);
            }}
          />
        </label>
        {draft.endpointIds.length > 0 &&
          !supportsPublicUsers(draft, deployment) && (
            <EntryPrerequisite deployment={deployment} />
          )}
        <Section
          title="转发路径"
          description="沿用所选转发路径的入口、顺序与出口。"
        >
          <div className="path-summary space-y-3" aria-label="公开线路转发路径">
            {draft.endpointIds.map((id, index) => (
              <span key={id}>
                {index > 0 && <i> → </i>}
                {pathInventory.endpoints.find((endpoint) => endpoint.id === id)
                  ?.name || id}
              </span>
            ))}
            {!draft.endpointIds.length && (
              <span className="muted text-sm text-muted-foreground">
                先选择上方的服务器转发路径
              </span>
            )}
          </div>
          <Accordion type="multiple" defaultValue={[]} className="w-full">
            {[
              {
                key: "path",
                label:
                  "\u8C03\u6574\u516C\u5F00\u8303\u56F4\uFF08\u4EC5\u5F53\u9700\u8981\u4F7F\u7528\u8DEF\u5F84\u7684\u4E00\u90E8\u5206\uFF09",
                children: (
                  <>
                    <p className="muted text-sm text-muted-foreground">
                      只能使用所选转发路径中的入口。顺序必须符合实际转发配置，保存前仍需检查。
                    </p>
                    <ActionButton
                      disabled={!deployment}
                      onClick={() =>
                        update({
                          endpointIds:
                            deployment?.ir.programs.map((p) => p.listener.id) ||
                            [],
                        })
                      }
                      variant="outline"
                    >
                      恢复完整路径
                    </ActionButton>
                    {draft.endpointIds.map((id, index) => (
                      <div
                        className="ordered-hop flex flex-wrap items-center gap-2 rounded-lg border p-3 [&_.server-endpoint-select]:basis-full [&_.server-endpoint-select]:grow sm:[&_.server-endpoint-select]:basis-1/2"
                        key={id}
                      >
                        <span className="step-index flex size-6 items-center justify-center rounded-full bg-muted text-xs">
                          {index + 1}
                        </span>
                        <ServerEndpointSelect
                          inventory={pathInventory}
                          value={id}
                          label={`公开路径第 ${index + 1} 跳`}
                          allowedIds={pathInventory.endpoints
                            .filter(
                              (e) =>
                                e.id === id ||
                                !draft.endpointIds.includes(e.id),
                            )
                            .map((e) => e.id)}
                          onPendingChange={(pending) =>
                            markPending(id, pending)
                          }
                          onChange={(next) =>
                            update({
                              endpointIds: draft.endpointIds.map((value, i) =>
                                i === index ? next : value,
                              ),
                            })
                          }
                        />
                        <ActionButton
                          aria-label={`上移公开路径第 ${index + 1} 跳`}
                          disabled={index === 0}
                          leadingIcon={<ArrowUpOutlined aria-hidden="true" />}
                          onClick={() =>
                            update({
                              endpointIds: moveItem(
                                draft.endpointIds,
                                index,
                                index - 1,
                              ),
                            })
                          }
                          variant="outline"
                        />
                        <ActionButton
                          aria-label={`下移公开路径第 ${index + 1} 跳`}
                          disabled={index === draft.endpointIds.length - 1}
                          leadingIcon={<ArrowDownOutlined aria-hidden="true" />}
                          onClick={() =>
                            update({
                              endpointIds: moveItem(
                                draft.endpointIds,
                                index,
                                index + 1,
                              ),
                            })
                          }
                          variant="outline"
                        />
                        <ActionButton
                          aria-label={`移除公开路径第 ${index + 1} 跳`}
                          leadingIcon={<DeleteOutlined aria-hidden="true" />}
                          onClick={() =>
                            update({
                              endpointIds: draft.endpointIds.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                          variant="outline"
                        />
                      </div>
                    ))}
                    <ServerEndpointSelect
                      key={addKey}
                      inventory={pathInventory}
                      label="添加公开路径"
                      allowedIds={pathInventory.endpoints
                        .filter((e) => !draft.endpointIds.includes(e.id))
                        .map((e) => e.id)}
                      onPendingChange={(pending) =>
                        markPending(addKey, pending)
                      }
                      onChange={(id) =>
                        update({ endpointIds: [...draft.endpointIds, id] })
                      }
                    />
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
        </Section>
        <div className="form-grid grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            对外域名或 IP
            <Input
              value={draft.publicHost}
              onChange={(e) => update({ publicHost: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            对外端口
            <OperationalIntegerInput
              key={draft.deploymentId}
              min={1}
              max={65535}
              value={publicPort}
              onInputText={(raw) => {
                setPublicPort(raw);
                update({});
              }}
            />
          </label>
        </div>
        {preview && (
          <Notice
            className="mt-4"
            tone={preview.diagnostics?.length ? "warning" : "info"}
            title={
              preview.diagnostics?.length ? "需要调整公开线路" : "路径检查完成"
            }
          >
            {preview.diagnostics?.join(" ") ||
              "可以保存线路身份；分配用户和节点应用仍是后续独立步骤。"}
          </Notice>
        )}
      </div>
      <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
        <ActionButton
          disabled={save.isPending}
          onClick={close}
          variant="outline"
        >
          取消
        </ActionButton>
        <ActionButton
          pending={inspect.isPending}
          disabled={
            save.isPending ||
            !draft.name.trim() ||
            !deployment ||
            !draft.publicHost ||
            !draft.endpointIds.length ||
            selectionPending
          }
          onClick={() => inspect.mutate()}
          variant={preview ? "outline" : "default"}
        >
          检查公开线路
        </ActionButton>
        {preview && (
          <ActionButton
            aria-label="保存公开线路"
            disabled={
              !preview ||
              !!preview.diagnostics?.length ||
              selectionPending ||
              (save.error instanceof APIError && save.error.status === 409)
            }
            pending={save.isPending}
            onClick={() => save.mutate(onSaved)}
            variant="default"
          >
            保存公开线路
          </ActionButton>
        )}
      </div>
    </TaskSheet>
  );
}
function PrincipalEditor({
  route,
  deployment,
  onClose,
  initialUserId,
  pathHref,
}: {
  route: PublishedRoute;
  deployment?: ServerDeployment;
  onClose: (userId?: string) => void;
  initialUserId?: string;
  pathHref?: string;
}) {
  const [form] = useForm();
  const [accountId, setAccountId] = useState(initialUserId);
  const [editingPolicy, setEditingPolicy] = useState(false);
  const close = () => onClose(accountId);
  const [credentialVersion] = useState(() => newID("credential"));
  const users = useQuery({
    queryKey: ["principal-users"],
    queryFn: loadState,
    enabled: !!route,
    staleTime: 0,
  });
  const client = useQueryClient();
  const [result, setResult] = useState<{
    entryId: string;
    status: string;
  } | null>(null);
  const mutation = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    mutationFn: (v: {
      accountId: string;
      credentialVersion: string;
      uuid?: string;
      flow?: string;
    }) =>
      post<{
        entryId: string;
        status: string;
      }>(`/published-routes/${route.id}/principals`, {
        accountId: v.accountId,
        credentialVersion:
          v.credentialVersion || form.getFieldValue("credentialVersion"),
        ...(v.uuid ? { credential: { uuid: v.uuid, flow: v.flow } } : {}),
      }),
    onSuccess: (value) => {
      setResult(value);
      form.resetFields();
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      client.invalidateQueries({ queryKey: ["published-routes"] });
      client.invalidateQueries({ queryKey: ["user-entries"] });
    },
  });
  const failedUser = users.data?.users.find(
    (u) => u.id === mutation.variables?.accountId,
  );
  const authorizationError =
    mutation.error instanceof APIError && mutation.error.status === 403
      ? mutation.error.message ===
        "published route is not assigned to this account"
        ? `${failedUser?.name || "所选用户"} 尚未获准使用「${route.name}」`
        : mutation.error.message === "account service is not active"
          ? `${failedUser?.name || "所选用户"} 的服务当前不可用`
          : null
      : null;
  const selectedUser = users.data?.users.find((user) => user.id === accountId);
  return (
    <>
      <TaskDialog
        bodyProps={{ className: "space-y-5" }}
        title={`配置「${route.name}」的用户入口`}
        open={!!route}
        footer={null}
        onOpenChange={(next) => {
          if (!next)
            (() => {
              if (!mutation.isPending && !editingPolicy) close();
            })();
        }}
        pending={!(!mutation.isPending && !editingPolicy)}
      >
        {result ? (
          <>
            <Notice
              tone="info"
              title="用户入口已准备"
            >{`尚未提交部署。请检查并应用转发路径「${deployment?.name || route?.deploymentId}」。只有匹配的配置被实际确认后，入口才可供订阅交付。`}</Notice>
            <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
              <ActionButton onClick={close} variant="outline">
                {initialUserId ? "返回线路进度" : "稍后处理"}
              </ActionButton>
              <ActionButton variant="default" asChild>
                <a
                  href={
                    pathHref ||
                    `#routes?deployment=${encodeURIComponent(route.deploymentId)}&line=${encodeURIComponent(route.id)}${accountId ? `&user=${encodeURIComponent(accountId)}` : ""}`
                  }
                  aria-disabled={undefined}
                  onClick={(event) => {
                    close?.();
                  }}
                >
                  检查并应用「{deployment?.name || route?.deploymentId}」
                </a>
              </ActionButton>
            </div>
          </>
        ) : (
          <AppForm
            form={form}
            initialValues={{ credentialVersion, accountId: initialUserId }}
            disabled={mutation.isPending}
            onFinish={(values) => mutation.mutate(values)}
            onValuesChange={(values) => {
              if (values.accountId) setAccountId(values.accountId);
            }}
          >
            <ErrorNotice
              error={
                (authorizationError ? null : mutation.error) ||
                (users.data ? users.error : null)
              }
            />
            {authorizationError && (
              <Notice
                tone="warning"
                title={authorizationError}
              >{`请在用户授权中检查服务状态、有效期与额度，并确认「${route.name}」的使用权限，再返回创建入口。`}</Notice>
            )}
            {!users.isPending &&
              !users.error &&
              users.data?.users.length === 0 && (
                <Notice tone="info" title="先创建用户">
                  {<a href="#users">前往用户管理</a>}
                </Notice>
              )}
            {route && !supportsPublicUsers(route, deployment) && (
              <EntryPrerequisite deployment={deployment} />
            )}
            <QueryState loading={!!route && users.isPending} paused={users.isPaused} loadingLayout="field" error={users.data ? null : users.error} retry={() => users.refetch()}>
            <AppField
              name="accountId"
              label="用户"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                disabled={!!initialUserId}
                options={(users.data?.users || []).map((u) => ({
                  value: u.id,
                  label: u.name,
                }))}
              />
            </AppField>
            </QueryState>
            <p className="muted text-sm text-muted-foreground">
              先为用户授权这条线路，再创建独立入口。
            </p>
            {!mutation.isPending && (
              <div className={"flex flex-wrap items-center gap-2"}>
                <ActionButton
                  disabled={!selectedUser}
                  onClick={() => setEditingPolicy(true)}
                  variant="outline"
                >
                  检查此用户授权
                </ActionButton>
              </div>
            )}
            <Accordion type="multiple" defaultValue={[]} className="w-full">
              {[
                {
                  key: "credential",
                  label: "\u51ED\u636E\u4E0E\u7248\u672C\u8BBE\u7F6E",
                  children: (
                    <>
                      <AppField
                        name="credentialVersion"
                        label="凭据版本"
                        rules={[{ required: true }]}
                      >
                        <Input />
                      </AppField>
                      <AppField name="uuid" label="已有 VLESS UUID（可选）">
                        <Input
                          placeholder="留空，由服务器生成"
                          autoComplete="off"
                          type="password"
                        />
                      </AppField>
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
            <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
              <ActionButton
                disabled={mutation.isPending}
                onClick={close}
                variant="outline"
              >
                取消
              </ActionButton>
              <ActionButton
                type="submit"
                disabled={
                  !route ||
                  !supportsPublicUsers(route, deployment) ||
                  users.isPending ||
                  !users.data?.users.length ||
                  !!users.error
                }
                pending={mutation.isPending}
                variant="default"
              >
                创建用户入口
              </ActionButton>
            </div>
          </AppForm>
        )}
      </TaskDialog>
      {editingPolicy && selectedUser && (
        <UserPolicyEditor
          user={selectedUser}
          services={users.data?.services || []}
          routes={[
            ...(users.data?.routes || []),
            ...(users.data?.publishedRoutes || []),
          ]}
          onClose={() => {
            setEditingPolicy(false);
            mutation.reset();
          }}
        />
      )}
    </>
  );
}
interface LineEntry extends PlatformEntry {
  publishedRouteId?: string;
  revoked?: boolean;
}
function PublicRouteDetail({
  route,
  sharedLines,
  inventory,
  initialUserId,
  exitChangeOpen,
  exitFocusRevision,
  pendingExitRouteName,
  onRetarget,
  onUserSelected,
  onEdit,
  onClose,
}: {
  route: PublishedRoute;
  sharedLines: string[];
  inventory?: Infrastructure;
  initialUserId?: string;
  exitChangeOpen: boolean;
  exitFocusRevision: number;
  pendingExitRouteName?: string;
  onRetarget: (
    route: PublishedRoute,
    deployment: ServerDeployment,
    inventory: Infrastructure,
  ) => void;
  onUserSelected: (id: string | undefined) => void;
  onEdit: (route: PublishedRoute) => void;
  onClose: () => void;
}) {
  const replaceView = useWorkspaceViewEntry();
  const [userId, setUserId] = useState(initialUserId);
  useEffect(() => {
    setUserId(initialUserId);
  }, [initialUserId]);
  const [action, setAction] = useState<
    "policy" | "principal" | "entries" | null
  >(null);
  const detail = useQuery({
    queryKey: ["published-route-resolve", route.id],
    queryFn: () =>
      request<PublishedRoute>(`/published-routes/${route.id}/resolve`),
    staleTime: 0,
  });
  const state = useQuery({
    queryKey: ["principal-users"],
    queryFn: loadState,
    staleTime: 0,
  });
  const policy = useQuery({
    queryKey: ["effective-policy", userId],
    queryFn: () =>
      request<EffectivePolicy>(`/users/${userId}/effective-policy`),
    enabled: !!userId,
    staleTime: 0,
  });
  const entries = useQuery({
    queryKey: ["user-entries", userId],
    queryFn: () => list<LineEntry>(`/users/${userId}/entries`),
    enabled: !!userId,
    staleTime: 0,
  });
  const retargetTrigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (exitFocusRevision)
      retargetTrigger.current?.focus({ preventScroll: true });
  }, [exitFocusRevision]);
  const current = detail.data || route;
  const deployment = inventory?.deployments.find(
    (item) => item.id === current.deploymentId,
  );
  const user = state.data?.users.find((item) => item.id === userId);
  const services = state.data?.services || [];
  const routes = [
    ...(state.data?.routes || []),
    ...(state.data?.publishedRoutes || []),
  ];
  const grants = entries.data?.filter(
    (entry) => entry.publishedRouteId === route.id,
  );
  const hasActiveEntry = grants?.some((entry) => !entry.revoked);
  const authorized =
    !policy.error &&
    policy.data?.status === "active" &&
    policy.data.routeIds.includes(route.id);
  const pathHref = `#routes?deployment=${encodeURIComponent(current.deploymentId)}&line=${encodeURIComponent(route.id)}${userId ? `&user=${encodeURIComponent(userId)}` : ""}`;
  const refresh = () => {
    detail.refetch();
    if (userId) {
      policy.refetch();
      entries.refetch();
    }
  };
  const returnToLine = () => {
    setAction(null);
    refresh();
  };
  const chooseUser = (id: string) => {
    setUserId(id);
    onUserSelected(id);
    replaceView(
      `#published-routes?line=${encodeURIComponent(route.id)}&user=${encodeURIComponent(id)}`,
    );
  };
  return (
    <>
      <TaskSheet
        bodyProps={{ className: "space-y-5" }}
        title={current.name}
        open
        onOpenChange={(next) => {
          if (!next)
            (() => {
              if (!action && !exitChangeOpen) onClose();
            })();
        }}
        size="lg"
        pending={!(!action && !exitChangeOpen)}
        footer={
          <ActionButton
            disabled={!!action || exitChangeOpen}
            onClick={() => onEdit(current)}
            variant="outline"
          >
            编辑线路
          </ActionButton>
        }
      >
        <Section title="线路开通进度">
          <p className="muted text-sm text-muted-foreground">
            {deployment?.name || current.deploymentId}
          </p>
          {sharedLines.length > 0 && (
            <p className="muted text-sm text-muted-foreground">
              共用此路径的其他线路：{sharedLines.join("、")}
              。应用前请核对路径检查中的影响范围。
            </p>
          )}
          {!detail.data && (
            <RoutePublicAddress route={{ ...current, effective: undefined }} />
          )}
          <QueryState
            loading={detail.isPending} paused={detail.isPaused} loadingLayout="summary"
            error={detail.error}
            retry={() => detail.refetch()}
          >
            {detail.data && (
              <>
                <RoutePathComparison route={detail.data} />
                <RoutePublicAddress route={detail.data} />
                {detail.data.diagnostics?.map((diagnostic, index) => (
                  <Notice key={index} tone="warning" title={diagnostic} />
                ))}
              </>
            )}
          </QueryState>
          {detail.error && <p>运行配置：未知，无法取得最新确认结果。</p>}
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              className="min-h-11"
              variant={
                detail.data?.pendingChanges &&
                !detail.isFetching &&
                !detail.error &&
                deployment &&
                !action &&
                !exitChangeOpen
                  ? "default"
                  : "outline"
              }
              asChild
            >
              <a href={pathHref}>检查并应用转发路径</a>
            </ActionButton>
            <ActionButton
              ref={retargetTrigger}
              className="min-h-11"
              disabled={!inventory || !deployment || !!action || exitChangeOpen}
              onClick={() => {
                if (inventory && deployment)
                  onRetarget(current, deployment, inventory);
              }}
              variant="outline"
            >
              {pendingExitRouteName
                ? `继续「${pendingExitRouteName}」出口变更`
                : "更换出口"}
            </ActionButton>
            <ActionButton
              className="min-h-11"
              pending={
                detail.isFetching ||
                (!!userId && (policy.isFetching || entries.isFetching))
              }
              onClick={refresh}
              variant="ghost"
            >
              重新核对进度
            </ActionButton>
          </div>
        </Section>
        <Section title="为用户继续开通">
          <QueryState
            loading={state.isPending} paused={state.isPaused} loadingLayout="form"
            error={state.error}
            retry={() => state.refetch()}
          >
            <label className="standalone-label grid gap-2 text-sm font-medium">
              选择用户
              <ChoiceSelect
                aria-label="线路使用用户"
                value={userId}
                onValueChange={(value) => {
                  if (value !== undefined) chooseUser(value);
                }}
                options={(state.data?.users || []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </label>
            {!state.isLoading && !state.error && !state.data?.users.length && (
              <a href="#users">先创建用户</a>
            )}
          </QueryState>
          {!userId && (
            <p className="muted text-sm text-muted-foreground">
              选择用户后查看这条线路的授权与独立入口；授权和凭据分配需单独操作。
            </p>
          )}
          {userId && (
            <>
              <Section title="用户授权">
                <QueryState
                  loading={!!userId && policy.isPending} paused={policy.isPaused} loadingLayout="summary"
                  error={policy.error}
                  retry={() => policy.refetch()}
                >
                  {policy.data && !policy.error && (
                    <>
                      <Metadata>
                        <span>{policy.data.routeIds.includes(route.id)
                          ? "已获准使用此线路"
                          : "尚未获准使用此线路"}</span>
                        <Badge variant="secondary">{policyStatus[policy.data.status] || policy.data.status}</Badge>
                      </Metadata>
                      <p className="muted text-sm text-muted-foreground">
                        授权来源：
                        {policySource(policy.data.provenance.routes, services)}
                      </p>
                    </>
                  )}
                </QueryState>
                {policy.error && <p>用户授权：未知，请重新核对。</p>}
                <ActionButton
                  disabled={!user || !!state.error}
                  onClick={() => setAction("policy")}
                  variant={authorized ? "outline" : "default"}
                >
                  检查或调整用户授权
                </ActionButton>
              </Section>
              <Section title="独立入口与运行确认">
                <QueryState
                  loading={!!userId && entries.isPending} paused={entries.isPaused} loadingLayout="table"
                  error={entries.error}
                  retry={() => entries.refetch()}
                >
                  {entries.data &&
                    !entries.error &&
                    (grants?.length ? (
                      grants.map((entry) => (
                        <p key={entry.id}>
                          {entry.name}：
                          <Badge variant="secondary">
                            {entry.revoked
                              ? "已停止交付"
                              : entry.status === "effective"
                                ? "入口凭据已确认生效"
                                : entry.status === "pending-deployment"
                                  ? "入口已准备，尚未确认应用"
                                  : "入口状态未知"}
                          </Badge>
                        </p>
                      ))
                    ) : (
                      <p>尚未准备此用户的独立入口</p>
                    ))}
                </QueryState>
                {entries.error && <p>独立入口：未知，请重新核对。</p>}
                <div className={"flex flex-wrap items-center gap-2"}>
                  {grants?.length ? (
                    <ActionButton
                      disabled={!user || !!state.error}
                      onClick={() => setAction("entries")}
                      variant="outline"
                    >
                      管理此用户入口
                    </ActionButton>
                  ) : (
                    <ActionButton
                      disabled={
                        !authorized ||
                        !user ||
                        !entries.data ||
                        !!entries.error ||
                        !!state.error
                      }
                      onClick={() => setAction("principal")}
                      variant={authorized ? "default" : "outline"}
                    >
                      准备独立入口
                    </ActionButton>
                  )}
                  {hasActiveEntry && (
                    <ActionButton
                      variant={
                        authorized &&
                        !grants?.some((entry) => entry.status === "effective")
                          ? "default"
                          : "outline"
                      }
                      asChild
                    >
                      <a href={pathHref}>继续检查并应用路径</a>
                    </ActionButton>
                  )}
                </div>
                {user && !supportsPublicUsers(current, deployment) && (
                  <EntryPrerequisite deployment={deployment} />
                )}
              </Section>
              <p className="muted text-sm text-muted-foreground">
                获取订阅时，会按当时的授权、额度与入口状态重新检查是否可交付。
              </p>
            </>
          )}
        </Section>
      </TaskSheet>
      {action === "policy" && user && (
        <UserPolicyEditor
          user={user}
          services={services}
          routes={routes}
          onClose={returnToLine}
        />
      )}
      {action === "principal" && user && (
        <PrincipalEditor
          route={current}
          deployment={deployment}
          initialUserId={user.id}
          pathHref={pathHref}
          onClose={returnToLine}
        />
      )}
      <UserEntries
        user={action === "entries" ? user || null : null}
        services={services}
        routes={state.data?.routes || []}
        publishedRoutes={state.data?.publishedRoutes || []}
        allocationHref={`#published-routes?line=${encodeURIComponent(route.id)}${user ? `&user=${encodeURIComponent(user.id)}` : ""}`}
        onClose={returnToLine}
      />
    </>
  );
}
