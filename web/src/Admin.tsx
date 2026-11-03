import { SettingsGroup, SettingsRow } from "@/ui-patterns/settings-group";
import { PlatformSettingsTabList } from "@/ui-patterns/platform-settings-navigation";
import type { ReactNode } from "react";
import { WorkspaceFrame } from "@/ui-patterns/workspace-frame";
import { PageSection, SectionIndex } from "@/ui-patterns/page-layout";
import { ResourceToolbar, SearchField } from "@/ui-patterns/resource-toolbar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";
import { useConfirm } from "@/ui-patterns/confirmations";
import { NumericInput } from "@/ui-patterns/numeric-input";
import { TaskSheet, TaskDialog } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { Notice } from "@/ui-patterns/notice";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { toast } from "sonner";
import {
  Ellipsis,
  Network as ApartmentOutlined,
  ArrowDown as ArrowDownOutlined,
  ArrowUp as ArrowUpOutlined,
  Server as CloudServerOutlined,
  Trash2 as DeleteOutlined,
  Pencil as EditOutlined,
  Eye as EyeOutlined,
  Plus as PlusOutlined,
  Search as SearchOutlined,
  UserPlus as UserAddOutlined,
} from "lucide-react";
import { wrapPublicationModalTab as wrapAdminModalTab } from "./publication-modal-focus";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
import { DataTable, TableRowActions } from "./DataTable";
import { SubscriptionOriginSettings } from "./SubscriptionOriginSettings";
import { UserGroups } from "./AccessPolicy";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UserPolicyEditor } from "./UserPolicyEditor";
import { RateSettings } from "./Rates";
import { UserEntries } from "./UserEntries";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection as FlowConnection, MarkerType } from "@xyflow/react";
import { RouteGraph } from "./route-graph";
import {
  deleteRecord,
  list,
  loadState,
  post,
  request,
  saveRecord,
} from "./api";
import type {
  NodeRecord,
  RouteRecord,
  Service,
  State,
  UserRecord,
  Validation,
} from "./types";
import type { Page } from "./App";
import { bytesLabel, dateLabel, moveItem, newID, redact } from "./model";
import { connectHop } from "./route-model";
import { BackupSettings } from "./Backup";
import { SecuritySettings } from "./Security";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  KeyValue,
  PageHeader,
  QueryState,
  Section,
  Status,
} from "./components";
const pageMeta: Record<
  string,
  {
    title: string;
    description: string;
    action: string;
  }
> = {
  routes: {
    title: "链路配置",
    description: "",
    action: "新建链路配置",
  },
  nodes: {
    title: "连接端点",
    description: "管理可复用的连接参数，供链路配置引用。",
    action: "添加端点",
  },
  users: {
    title: "用户",
    description: "管理账号访问、额度与服务授权。",
    action: "添加用户",
  },
  services: {
    title: "服务方案",
    description: "集中配置线路、额度与重置规则，再分配给用户或用户组。",
    action: "新建方案",
  },
  activity: {
    title: "变更记录",
    description: "",
    action: "",
  },
  settings: {
    title: "平台设置",
    description: "",
    action: "",
  },
};
export function AdminPage({ page: selectedPage }: { page: Page }) {
  const confirmRemoval = useConfirm();
  const page = selectedPage === "legacy-routes" ? "routes" : selectedPage;
  const query = useQuery({
    queryKey: ["admin-state"],
    queryFn: async () => {
      const [state, services, settings, publishedRoutes] = await Promise.all([
        loadState(),
        list<Service>("/services"),
        request<Record<string, unknown>>("/settings"),
        list<{
          id: string;
          name: string;
          status: string;
        }>("/published-routes"),
      ]);
      return { ...state, services, settings, publishedRoutes };
    },
  });
  const client = useQueryClient();
  const message = toast;
  const [search, setSearch] = useState("");
  const [route, setRoute] = useState<RouteRecord | null>(null);
  const [routeNew, setRouteNew] = useState(false);
  const [entity, setEntity] = useState<{
    kind: "nodes" | "users";
    value: NodeRecord | UserRecord | null;
  } | null>(null);
  const [serviceEditor, setServiceEditor] = useState<{
    value: Service | null;
  } | null>(null);
  const [invite, setInvite] = useState({ key: 0, open: false });
  const [entryUser, setEntryUser] = useState<UserRecord | null>(null);
  const [entitlementUser, setEntitlementUser] = useState<UserRecord | null>(
    null,
  );
  const [error, setError] = useState<Error | null>(null);
  const [validation, setValidation] = useState<(Validation & { historical?: boolean }) | null>(null);
  const [validationName, setValidationName] = useState("");
  const validationPresentation = useRef<(Validation & { historical?: boolean }) | null>(null);
  useLayoutEffect(() => {
    if (validation) validationPresentation.current = validation;
  }, [validation]);
  const displayedValidation = validation || validationPresentation.current;
  const meta = pageMeta[page];
  const remove = useMutation({
    mutationFn: ({ kind, id }: { kind: string; id: string }) =>
      deleteRecord(kind, id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["admin-state"] });
      message.success("已删除");
    },
    onError: setError,
  });
  const validate = useMutation({
    mutationFn: (r: RouteRecord) =>
      post<Validation>(`/routes/${r.id}/validate`),
    onSuccess: (result, r) => {
      client.invalidateQueries({ queryKey: ["admin-state"] });
      setValidation(result);
      setValidationName(r.name);
    },
    onError: setError,
  });
  const editRoute = (r?: RouteRecord) => {
    setRoute(
      r
        ? structuredClone(r)
        : {
            id: newID("route"),
            name: "",
            hops: [],
            engine: query.data?.capabilities?.[0]?.id || "sing-box",
            userIds: [],
          },
    );
    setRouteNew(!r);
  };
  const add = () =>
    page === "routes"
      ? editRoute()
      : page === "services"
        ? setServiceEditor({ value: null })
        : setEntity({
            kind: page as "nodes" | "users",
            value: null,
          });
  const searchEmpty = search ? (
    <EmptyState title={`没有匹配的${meta.title}`} action={
      <ActionButton onClick={() => setSearch("")} variant="outline">清除搜索</ActionButton>
    } />
  ) : undefined;
  const data = query.data;
  const nodes = data?.nodes || [];
  const users = data?.users || [];
  const routes = data?.routes || [];
  const match = (name: string) =>
    name.toLowerCase().includes(search.toLowerCase());
  if (page === "settings") {
    const readNotice =
      query.error && data ? (
        <Notice
          tone="error"
          title="暂时无法刷新设置"
          action={
            <ActionButton
              variant="outline"
              pending={query.isFetching}
              onClick={() => query.refetch()}
            >
              重新读取设置
            </ActionButton>
          }
        >
          {query.error.message}
        </Notice>
      ) : null;
    return data ? (
      <PlatformSettingsTabs
        initial={data.settings || {}}
        readNotice={readNotice}
      />
    ) : (
      <WorkspaceFrame
        contentKind="settings"
        contextKind="navigation"
        header={<PageHeader title={meta.title} />}
        localNavigation={<Tabs defaultValue="basic"><PlatformSettingsTabList disabled /></Tabs>}
        context={
          <span className="text-sm text-muted-foreground">本页设置</span>
        }
      >
        <QueryState
          loading={query.isPending}
          paused={query.isPaused}
          loadingLayout="settings"
          error={query.error}
          retry={() => query.refetch()}
        >
          {null}
        </QueryState>
      </WorkspaceFrame>
    );
  }
  return (
    <>
      <PageHeader
        title={meta.title}
        description={meta.description}
        action={
          meta.action && (
            <div className={"flex flex-wrap items-center gap-2"}>
              {page === "users" && (
                <ActionButton
                  leadingIcon={<UserAddOutlined aria-hidden="true" />}
                  onClick={() => setInvite((task) => ({ key: task.key + 1, open: true }))}
                  variant="outline"
                >
                  邀请用户
                </ActionButton>
              )}
              <ActionButton
                leadingIcon={<PlusOutlined aria-hidden="true" />}
                onClick={add}
                variant="default"
              >
                {meta.action}
              </ActionButton>
            </div>
          )
        }
      />
      <ErrorNotice error={error} />
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        {data && (
          <>
            {["routes", "nodes", "users", "services"].includes(page) && (
              <Section variant="plain">
                <ResourceToolbar label={`查找${meta.title}`} search={
                  <SearchField placeholder={`搜索${meta.title}`} value={search}
                    onValueChange={setSearch} aria-label={`搜索${meta.title}`} />
                } />
                {page === "routes" &&
                  (routes.length ? (
                    <DataTable<RouteRecord>
                      rowKey="id"
                      rows={routes.filter((r) => match(r.name))}
                      columns={[
                        {
                          title: "链路配置",
                          render: (_, r) => (
                            <button
                              className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => editRoute(r)}
                            >
                              <span className="table-icon size-4 shrink-0 text-muted-foreground [&_svg]:size-4">
                                <ApartmentOutlined aria-hidden="true" />
                              </span>
                              <span>
                                {r.name}{" "}
                                <small className="block text-xs font-normal text-muted-foreground">
                                  {r.hops.length === 1
                                    ? "单端点链路"
                                    : `${r.hops.length} 跳中转`}
                                </small>
                              </span>
                            </button>
                          ),
                        },
                        {
                          title: "路径",
                          render: (_, r) => (
                            <div className="path-summary flex flex-wrap items-center gap-2 text-sm">
                              {r.hops.map((id, i) => (
                                <span key={id}>
                                  {i > 0 && <i>→</i>}
                                  {nodes.find((n) => n.id === id)?.name ||
                                    "端点已移除"}
                                </span>
                              ))}
                            </div>
                          ),
                        },
                        {
                          title: "访问用户",
                          render: (_, r) =>
                            r.userIds.length
                              ? `${r.userIds.length} 位用户`
                              : "未分配",
                        },
                        {
                          title: "配置状态",
                          render: (_, r) => (
                            <Badge variant="secondary">
                              {data.revisions.some((v) => v.routeId === r.id)
                                ? "已生成配置"
                                : "草稿"}
                            </Badge>
                          ),
                        },
                        {
                          title: "",
                          width: 200,
                          render: (_, r) => (
                            <TableRowActions name={r.name}>
                              <ActionButton
                                onClick={() => editRoute(r)}
                                variant="ghost"
                              >
                                编辑
                              </ActionButton>
                              <ActionButton
                                leadingIcon={<EyeOutlined aria-hidden="true" />}
                                aria-label={`校验 ${r.name}`}
                                pending={
                                  validate.isPending &&
                                  validate.variables?.id === r.id
                                }
                                onClick={() => validate.mutate(r)}
                                variant="ghost"
                              />
                              <ActionButton
                                onClick={() =>
                                  confirmRemoval({
                                    title: `删除链路配置「${r.name}」？`,
                                    description:
                                      "已分配用户将不能从此链路配置获取新配置。",
                                    confirmLabel: "删除",
                                    cancelLabel: "保留",
                                    destructive: true,
                                    onConfirm: () =>
                                      remove.mutateAsync({
                                        kind: "routes",
                                        id: r.id,
                                      }),
                                  })
                                }
                                aria-label={`删除 ${r.name}`}
                                leadingIcon={
                                  <DeleteOutlined aria-hidden="true" />
                                }
                                variant="destructive"
                              />
                            </TableRowActions>
                          ),
                        },
                      ]}
                      minWidth={760}
                      empty={searchEmpty}
                    />
                  ) : (
                    <EmptyState
                      title="暂无链路配置"
                      description="选择一个端点直连，或按顺序连接多个端点。"
                      action={
                        <ActionButton
                          onClick={() => editRoute()}
                          variant="default"
                        >
                          新建链路配置
                        </ActionButton>
                      }
                    />
                  ))}
                {page === "nodes" &&
                  (nodes.length ? (
                    <DataTable<NodeRecord>
                      rowKey="id"
                      rows={nodes.filter((n) => match(n.name))}
                      columns={[
                        {
                          title: "端点",
                          render: (_, n) => (
                            <button
                              className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() =>
                                setEntity({ kind: "nodes", value: n })
                              }
                            >
                              <span className="table-icon size-4 shrink-0 text-muted-foreground [&_svg]:size-4">
                                <CloudServerOutlined
                                  className="size-4 shrink-0"
                                  aria-hidden="true"
                                />
                              </span>
                              <span>
                                {n.name}{" "}
                                <small className="block text-xs font-normal text-muted-foreground">
                                  {n.region || "未设置地区"}
                                </small>
                              </span>
                            </button>
                          ),
                        },
                        {
                          title: "地址",
                          render: (_, n) => `${n.host}:${n.port}`,
                        },
                        { title: "协议", accessor: "protocol" },
                        {
                          title: "被链路配置引用",
                          render: (_, n) =>
                            `${routes.filter((r) => r.hops.includes(n.id)).length} 条`,
                        },
                        {
                          title: "状态",
                          render: (_, n) => (
                            <Status value={n.status || "unregistered"} />
                          ),
                        },
                        {
                          title: "",
                          render: (_, n) => (
                            <TableRowActions name={n.name}>
                              <ActionButton
                                onClick={() =>
                                  setEntity({ kind: "nodes", value: n })
                                }
                                variant="ghost"
                              >
                                编辑
                              </ActionButton>
                              <AdminRowMenu
                                actions={[
                                  {
                                    label: "删除端点",
                                    accessibleLabel: `删除 ${n.name}`,
                                    destructive: true,
                                    run: () =>
                                      confirmRemoval({
                                        title: `删除端点「${n.name}」？`,
                                        description:
                                          "仍被链路配置引用的端点不能删除。请先从相关链路配置中移除引用。",
                                        confirmLabel: "删除",
                                        cancelLabel: "保留",
                                        destructive: true,
                                        onConfirm: () =>
                                          remove.mutateAsync({
                                            kind: "nodes",
                                            id: n.id,
                                          }),
                                      }),
                                  },
                                ]}
                                name={n.name}
                              />
                            </TableRowActions>
                          ),
                        },
                      ]}
                      minWidth={750}
                      empty={searchEmpty}
                    />
                  ) : (
                    <EmptyState
                      title="暂无连接端点"
                      description="维护连接端点，供链路配置引用。"
                      action={
                        <ActionButton onClick={add} variant="default">
                          添加端点
                        </ActionButton>
                      }
                    />
                  ))}
                {page === "users" &&
                  (users.length ? (
                    <DataTable<UserRecord>
                      rowKey="id"
                      rows={users.filter((u) => match(u.name))}
                      columns={[
                        {
                          title: "用户",
                          accessor: "name",
                          render: (name, u) => (
                            <button
                              className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() =>
                                setEntity({ kind: "users", value: u })
                              }
                            >
                              {name}
                            </button>
                          ),
                        },
                        {
                          title: "状态",
                          render: (_, u) => (
                            <Status
                              value={u.enabled ? "enabled" : "disabled"}
                            />
                          ),
                        },
                        {
                          title: "账户基础额度",
                          render: (_, u) =>
                            u.quotaBytes ? bytesLabel(u.quotaBytes) : "不限额",
                        },
                        {
                          title: "",
                          render: (_, u) => (
                            <TableRowActions name={u.name}>
                              <ActionButton
                                onClick={() => setEntryUser(u)}
                                variant="ghost"
                              >
                                平台入口
                              </ActionButton>
                              <AdminRowMenu
                                name={u.name}
                                actions={[
                                  {
                                    label: "授权与续期",
                                    run: () => setEntitlementUser(u),
                                  },
                                  {
                                    label: "编辑用户",
                                    run: () =>
                                      setEntity({ kind: "users", value: u }),
                                  },
                                ]}
                              />
                            </TableRowActions>
                          ),
                        },
                      ]}
                      minWidth={700}
                      empty={
                        search ? (
                          <EmptyState
                            title="没有匹配的用户"
                            action={
                              <ActionButton
                                onClick={() => setSearch("")}
                                variant="outline"
                              >
                                清除搜索
                              </ActionButton>
                            }
                          />
                        ) : undefined
                      }
                    />
                  ) : (
                    <EmptyState
                      title="暂无用户"
                      description="邀请用户注册，或直接添加账号。"
                      action={
                        <ActionButton
                          onClick={() => setInvite((task) => ({ key: task.key + 1, open: true }))}
                          variant="default"
                        >
                          邀请用户
                        </ActionButton>
                      }
                    />
                  ))}
                {page === "services" &&
                  ((data.services || []).length ? (
                    <DataTable<Service>
                      rowKey="id"
                      rows={(data.services || []).filter((s) => match(s.name))}
                      columns={[
                        { title: "服务方案", accessor: "name" },
                        {
                          title: "额度",
                          render: (_, s) =>
                            s.quotaBytes ? bytesLabel(s.quotaBytes) : "不限额",
                        },
                        {
                          title: "授权线路",
                          render: (_, s) => s.routeIds?.length || 0,
                        },
                        {
                          title: "接入限制",
                          render: (_, s) => (
                            <>
                              <span>
                                {s.onlineIpLimit
                                  ? `${s.onlineIpLimit} 个在线 IP`
                                  : "IP 不限"}{" "}
                                ·{" "}
                                {s.connectionLimit
                                  ? `${s.connectionLimit} 条并发流`
                                  : "并发不限"}
                              </span>
                              {!!s.entryRateBps && (
                                <small className="muted block text-sm text-muted-foreground">
                                  每入口 {bytesLabel(s.entryRateBps)}/s
                                </small>
                              )}
                            </>
                          ),
                        },
                        {
                          title: "重置规则",
                          render: (_, s) =>
                            ({
                              monthly: "每月固定日",
                              anniversary: "按周期起点日每月重置",
                              "fixed-days": "固定天数",
                              none: "不自动重置",
                            })[s.cycle?.mode || "none"],
                        },
                        {
                          title: "",
                          render: (_, s) => (
                            <TableRowActions name={s.name}>
                              <ActionButton
                                onClick={() => setServiceEditor({ value: s })}
                                variant="ghost"
                              >
                                编辑
                              </ActionButton>
                            </TableRowActions>
                          ),
                        },
                      ]}
                      minWidth={850}
                      empty={searchEmpty}
                    />
                  ) : (
                    <EmptyState
                      title="暂无服务方案"
                      description="新建方案后，可分配给用户或用户组。"
                      action={
                        <ActionButton onClick={add} variant="default">
                          新建方案
                        </ActionButton>
                      }
                    />
                  ))}
              </Section>
            )}
            {page === "activity" && (
              <>
                <AuditLog />
                <Section title="链路配置生成记录" variant="plain">
                  {data.revisions.length ? (
                    <DataTable
                      rowKey="id"
                      rows={[...data.revisions].reverse()}
                      columns={[
                        {
                          title: "链路配置",
                          render: (_, v) =>
                            routes.find((r) => r.id === v.routeId)?.name ||
                            "已删除链路配置",
                        },
                        { title: "核心", accessor: "engine" },
                        {
                          title: "阶段",
                          render: (_, v) => <Status value={v.status} />,
                        },
                        {
                          title: "时间",
                          render: (_, v) => dateLabel(v.createdAt),
                        },
                        {
                          title: "",
                          render: (_, v) => (
                            <ActionButton
                              onClick={() => {
                                setValidation({
                                  valid: v.status === "rendered",
                                  historical: true,
                                  diagnostics: [],
                                  artifacts: v.artifacts,
                                  revision: v,
                                  nativeChecked: v.nativeChecked,
                                });
                                setValidationName(
                                  routes.find((r) => r.id === v.routeId)
                                    ?.name || "配置记录",
                                );
                              }}
                              variant="outline"
                            >
                              查看
                            </ActionButton>
                          ),
                        },
                      ]}
                    />
                  ) : (
                    <EmptyState
                      title="还没有配置记录"
                      description="在链路配置中执行校验后，会在这里保留生成记录。"
                    />
                  )}
                </Section>
              </>
            )}
          </>
        )}
      </QueryState>
      {page === "users" && data && (
        <UserGroups
          users={users}
          services={data.services || []}
          routes={data.publishedRoutes || []}
        />
      )}
      {page === "services" && data && (
        <RateSettings
          routes={(data.publishedRoutes || []).map((r) => ({
            ...r,
            engine: "managed",
            hops: [],
            userIds: [],
          }))}
        />
      )}
      {route && data && (
        <RouteEditor
          initial={route}
          isNew={routeNew}
          state={data}
          onClose={() => setRoute(null)}
        />
      )}
      <EntityEditor
        entity={entity}
        state={data}
        onClose={() => setEntity(null)}
      />
      <UserEntries
        user={entryUser}
        routes={routes}
        publishedRoutes={data?.publishedRoutes || []}
        services={data?.services || []}
        onClose={() => setEntryUser(null)}
      />
      {serviceEditor && data && (
        <ServicePolicyEditor
          initial={serviceEditor.value}
          users={users}
          services={data.services || []}
          routes={data.publishedRoutes || []}
          onClose={() => setServiceEditor(null)}
        />
      )}
      {entitlementUser && (
        <UserPolicyEditor
          key={entitlementUser.id}
          user={entitlementUser}
          services={data?.services || []}
          routes={data?.publishedRoutes || []}
          onClose={() => setEntitlementUser(null)}
        />
      )}

      <InviteUser key={invite.key} open={invite.open} onClose={() => setInvite((task) => ({ ...task, open: false }))} />
      <TaskSheet
        title={`${validationName} · ${displayedValidation?.historical ? "生成记录" : "配置检查"}`}
        open={!!validation}
        contentProps={{ inert: !validation }}
        bodyProps={{ className: "space-y-5" }}
        onClosed={() => { if (!validation) validationPresentation.current = null; }}
        onOpenChange={(open) => {
          if (!open) (() => setValidation(null))();
        }}
        size="lg"
      >
        {displayedValidation && (
          <>
            <Notice
              tone={displayedValidation.historical ? "info" : displayedValidation.valid ? "success" : "error"}
              title={displayedValidation.historical ? "历史配置记录" : displayedValidation.valid ? "配置结构校验完成" : "配置需要调整"}
            >
              {displayedValidation.historical
                ? "这是当时保存的配置，不是本次校验；不代表服务器已经应用。"
                : displayedValidation.valid
                ? "此结果是配置生成与结构检查，不代表服务器已经应用。"
                : displayedValidation.diagnostics.join(" ")}
            </Notice>
            {displayedValidation.historical && displayedValidation.revision && (
              <div className="grid gap-3 sm:grid-cols-2">
                <KeyValue label="记录状态"><Status value={displayedValidation.revision.status} /></KeyValue>
                <KeyValue label="生成时间">{dateLabel(displayedValidation.revision.createdAt)}</KeyValue>
              </div>
            )}
            <Accordion type="multiple">
              {[
                {
                  key: "technical",
                  label:
                    "\u6280\u672F\u8BE6\u60C5\u4E0E\u751F\u6210\u6587\u4EF6",
                  children: (
                    <>
                      {displayedValidation.diagnostics.map((d, i) => (
                        <p
                          key={i}
                          className="muted text-sm text-muted-foreground"
                        >
                          {d}
                        </p>
                      ))}
                      {displayedValidation.artifacts.map((a) => (
                        <div key={a.path} className="space-y-2">
                          <h3 className="font-mono text-xs [overflow-wrap:anywhere]">{a.path}</h3>
                          <CodePreview content={redact(a.content)} />
                        </div>
                      ))}
                    </>
                  ),
                },
              ].map((section) => (
                <AccordionItem key={section.key} value={String(section.key)}>
                  <AccordionTrigger>{section.label}</AccordionTrigger>
                  <AccordionContent
                    forceMount
                    className="space-y-4 data-[state=closed]:hidden"
                  >
                    {section.children}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </>
        )}
      </TaskSheet>
    </>
  );
}
function RouteEditor({
  initial,
  isNew,
  state,
  onClose,
}: {
  initial: RouteRecord;
  isNew: boolean;
  state: State;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation(initial.id);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const [view, setView] = useState("ordered");
  const [positions, setPositions] = useState<
    Record<
      string,
      {
        x: number;
        y: number;
      }
    >
  >({});
  const [error, setError] = useState<Error | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const client = useQueryClient();
  const message = toast;
  const capability = state.capabilities.find((c) => c.id === draft.engine);
  const maxHops = capability?.maxHops || 2;
  const save = useMutation({
    mutationFn: (value: RouteRecord) => saveRecord("routes", value, isNew),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["admin-state"] });
      if (!active.current) return;
      message.success("链路配置草稿已保存");
      onClose();
    },
    onError: (failure) => {
      if (active.current) setError(failure);
    },
  });
  useUnsavedChanges(changed || save.isPending);
  const close = () => {
    if (save.isPending || confirming) return;
    if (!changed) return onClose();
    confirm(
      {
        title: "放弃未保存的链路配置修改？",
        description: "当前链路配置草稿尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  const updateHops = (hops: string[]) => {
    if (new Set(hops).size !== hops.length) {
      setError(new Error("链路配置不能重复使用同一端点。"));
      return;
    }
    setError(null);
    setDraft({ ...draft, hops });
    setAnnouncement(
      `路径已更新：${hops.map((id) => state.nodes.find((n) => n.id === id)?.name).join("，然后到")}`,
    );
  };
  const connect = (connection: FlowConnection) => {
    try {
      updateHops(
        connectHop(draft.hops, connection.source!, connection.target!, maxHops),
      );
    } catch (e) {
      setError(e as Error);
    }
  };
  const graphNodes = state.nodes.map((n, i) => ({
    id: n.id,
    position: positions[n.id] || {
      x: 80 + (i % 3) * 230,
      y: 60 + Math.floor(i / 3) * 160,
    },
    data: {
      label: (
        <div>
          <strong>{n.name}</strong>
          <small>{n.region || n.protocol}</small>
          {draft.hops.includes(n.id) && (
            <Badge variant="secondary">
              {draft.hops.indexOf(n.id) === 0
                ? "入口"
                : draft.hops.indexOf(n.id) === draft.hops.length - 1
                  ? "出口"
                  : "中转"}
            </Badge>
          )}
        </div>
      ),
    },
    style: {
      border: draft.hops.includes(n.id)
        ? "2px solid #167565"
        : "1px solid #dce4df",
      borderRadius: 12,
      width: 160,
      padding: 12,
    },
    sourcePosition: "right" as never,
    targetPosition: "left" as never,
  }));
  const edges = draft.hops.slice(1).map((id, i) => ({
    id: `${draft.hops[i]}-${id}`,
    source: draft.hops[i],
    target: id,
    markerEnd: { type: "arrowclosed" as MarkerType, color: "#167565" },
    style: { stroke: "#167565", strokeWidth: 2.5 },
  }));
  return (
    <TaskSheet
      title={isNew ? "新建链路配置" : `编辑链路配置 ${initial.name}`}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      pending={save.isPending}
      size="xl"
      footer={
        <ActionButton
          disabled={!draft.name.trim() || !draft.hops.length || confirming}
          pending={save.isPending}
          onClick={() => save.mutate(structuredClone(draft))}
          variant="default"
        >
          保存草稿
        </ActionButton>
      }
    >
      <ErrorNotice error={error} />
      <div inert={save.isPending || confirming} className="space-y-6">
        <div className="form-grid grid gap-5 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            链路配置名称
            <Input
              aria-label="链路配置名称"
              value={draft.name}
              placeholder="例如：欧洲 → 英国"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            配置目标
            <ChoiceSelect
              value={draft.engine}
              options={state.capabilities.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
              onValueChange={(engine) => {
                if (engine) setDraft({ ...draft, engine });
              }}
            />
          </label>
        </div>
        <div className="section-heading flex flex-wrap items-start justify-between gap-4 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:text-sm [&_p]:text-muted-foreground">
          <div>
            <h2>连接路径</h2>
            <p>入口 → 中转 → 出口。单个端点即为直连。</p>
          </div>
          <Tabs value={view} onValueChange={setView}>
            {
              <>
                <TabsList className="flex h-auto max-w-full flex-wrap">
                  {[
                    { key: "ordered", label: "\u987A\u5E8F\u7F16\u8F91" },
                    { key: "graph", label: "\u56FE\u5F62\u7F16\u8F91" },
                  ].map((tab) => (
                    <TabsTrigger key={tab.key} value={String(tab.key)}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </>
            }
          </Tabs>
        </div>
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
        {view === "graph" && (
          <>
            <div className="graph-canvas h-96 overflow-hidden rounded-lg border">
              <RouteGraph
                ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "放大", "controls.zoomOut.ariaLabel": "缩小", "controls.fitView.ariaLabel": "适应画布" }}
                nodes={graphNodes}
                edges={edges}
                onNodesChange={(changes) =>
                  setPositions((previous) => {
                    const next = { ...previous };
                    for (const change of changes)
                      if (change.type === "position" && change.position)
                        next[change.id] = change.position;
                    return next;
                  })
                }
                onConnect={connect}
                onNodeClick={(_, node) => {
                  if (!draft.hops.length) updateHops([node.id]);
                }}
                fitView
                minZoom={0.3}
                maxZoom={1.5}
                deleteKeyCode={null}
                aria-label="链路拓扑编辑"
              >
              </RouteGraph>
            </div>
            <p className="muted text-sm text-muted-foreground">
              点击端点选择入口，从当前末端连向下一跳。拖动仅调整视图位置。也可以切换到顺序编辑。
            </p>
          </>
        )}
        {view === "ordered" && (
          <div className="ordered-path space-y-3">
            {draft.hops.map((id, index) => (
              <div
                className="hop-row flex flex-wrap items-center gap-2 rounded-lg border p-3 [&>[role=combobox]]:min-w-48 [&>[role=combobox]]:flex-1"
                key={`${index}-${id}`}
              >
                <span className="hop-position min-w-12 text-sm font-medium text-muted-foreground">
                  {index === 0
                    ? "入口"
                    : index === draft.hops.length - 1
                      ? "出口"
                      : `中转 ${index}`}
                </span>
                <ChoiceSelect
                  aria-label={`第 ${index + 1} 跳端点`}
                  value={id}
                  options={state.nodes.map((n) => ({
                    value: n.id,
                    label: `${n.name}${n.region ? ` · ${n.region}` : ""}`,
                    disabled: draft.hops.includes(n.id) && n.id !== id,
                  }))}
                  onValueChange={(next) => {
                    if (next)
                      updateHops(
                        draft.hops.map((h, i) => (i === index ? next : h)),
                      );
                  }}
                />
                <ActionButton
                  aria-label={`上移第 ${index + 1} 跳`}
                  leadingIcon={<ArrowUpOutlined aria-hidden="true" />}
                  disabled={index === 0}
                  onClick={() =>
                    updateHops(moveItem(draft.hops, index, index - 1))
                  }
                  variant="ghost"
                />
                <ActionButton
                  aria-label={`下移第 ${index + 1} 跳`}
                  leadingIcon={<ArrowDownOutlined aria-hidden="true" />}
                  disabled={index === draft.hops.length - 1}
                  onClick={() =>
                    updateHops(moveItem(draft.hops, index, index + 1))
                  }
                  variant="ghost"
                />
                <ActionButton
                  aria-label={`移除第 ${index + 1} 跳`}
                  leadingIcon={<DeleteOutlined aria-hidden="true" />}
                  onClick={() =>
                    updateHops(draft.hops.filter((_, i) => i !== index))
                  }
                  variant="ghost"
                />
              </div>
            ))}
            <ChoiceSelect
              className="add-hop w-full"
              value={undefined}
              disabled={draft.hops.length >= maxHops}
              aria-label="添加下一跳"
              placeholder={draft.hops.length ? "＋ 添加下一跳" : "选择入口端点"}
              options={state.nodes
                .filter((n) => !draft.hops.includes(n.id))
                .map((n) => ({
                  value: n.id,
                  label: `${n.name}${n.region ? ` · ${n.region}` : ""}`,
                }))}
              onValueChange={(id) => {
                if (id) updateHops([...draft.hops, id]);
              }}
            />
            {draft.hops.length >= maxHops && (
              <p className="muted text-sm text-muted-foreground">
                当前核心的已验证路径长度为 {maxHops} 跳。
              </p>
            )}
          </div>
        )}
        <div className="settings-section space-y-4 border-t pt-6 [&>h2]:font-semibold">
          <h2>访问授权</h2>
          <label className="standalone-label grid gap-2 text-sm font-medium">
            可使用此链路配置的用户
            <MultiChoice
              value={draft.userIds}
              options={state.users.map((u) => ({ value: u.id, label: u.name }))}
              onValueChange={(userIds) => setDraft({ ...draft, userIds })}
            />
          </label>
        </div>
        <Accordion type="multiple">
          {[
            {
              key: "advanced",
              label: "\u9AD8\u7EA7\uFF1A\u8F93\u51FA\u547D\u540D",
              children: (
                <label className="standalone-label grid gap-2 text-sm font-medium">
                  订阅显示名称模板
                  <Input
                    value={draft.nameTemplate}
                    placeholder="{route} · {region}"
                    onChange={(e) =>
                      setDraft({ ...draft, nameTemplate: e.target.value })
                    }
                  />
                  <small>
                    可用 {"{route}"}、{"{region}"}、{"{engine}"}、{"{id}"}
                    。名称修改不会改变授权引用。
                  </small>
                </label>
              ),
            },
          ].map((section) => (
            <AccordionItem key={section.key} value={String(section.key)}>
              <AccordionTrigger>{section.label}</AccordionTrigger>
              <AccordionContent
                forceMount
                className="space-y-4 data-[state=closed]:hidden"
              >
                {section.children}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </TaskSheet>
  );
}
function EntityEditor({
  entity,
  state: _state,
  onClose,
}: {
  entity: {
    kind: "nodes" | "users";
    value: NodeRecord | UserRecord | null;
  } | null;
  state?: State;
  onClose: () => void;
}) {
  // Task ownership closes immediately; only the last committed presentation
  // remains while Radix finishes the exit animation.
  const presentation = useRef(entity);
  useLayoutEffect(() => {
    if (entity) presentation.current = entity;
  }, [entity]);
  const displayEntity = entity || presentation.current;
  const formId = useId();
  const [form] = useForm(),
    client = useQueryClient(),
    message = toast;
  const values = useWatch([], { form, preserve: true });
  const [baseline, setBaseline] = useState("");
  const changed =
    !!entity && baseline !== "" && JSON.stringify(values || {}) !== baseline;
  const submitButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef<typeof entity>(null);
  const owner = useRef(entity);
  owner.current = entity;
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation(
    entity ? `${entity.kind}:${entity.value?.id || "new"}` : "closed",
  );
  const mutation = useMutation({
    mutationFn: ({
      values,
      task,
    }: {
      values: Record<string, unknown>;
      task: NonNullable<typeof entity>;
    }) => {
      const value = {
        ...task.value,
        ...values,
        id: task.value?.id || newID(task.kind.slice(0, -1)),
      } as Record<string, any>;
      if ("quotaGiB" in value) {
        value.quotaBytes = Math.round(Number(value.quotaGiB) * 1024 ** 3);
        delete value.quotaGiB;
      }
      return saveRecord(
        task.kind,
        task.kind === "users"
          ? {
              id: value.id,
              name: value.name,
              enabled: value.enabled,
              quotaBytes: value.quotaBytes,
              usedBytes: value.usedBytes || 0,
            }
          : normalizeConnection(value as NodeRecord),
        !task.value,
      );
    },
    onSuccess: (_saved, { task }) => {
      client.invalidateQueries({ queryKey: ["admin-state"] });
      client.invalidateQueries({ queryKey: ["effective-policy"] });
      if (!active.current || owner.current !== task) return;
      message.success("已保存");
      onClose();
    },
    onSettled: (_saved, _error, { task }) => {
      if (submitting.current === task) submitting.current = null;
    },
  });
  const pending =
    !!entity && mutation.isPending && mutation.variables?.task === entity;
  useUnsavedChanges(changed || pending);
  useLayoutEffect(() => {
    if (!entity) {
      setBaseline("");
      return;
    }
    mutation.reset();
    form.resetFields();
    const value = entity.value;
    form.setFieldsValue(
      value
        ? {
            ...value,
            ...("quotaBytes" in value
              ? { quotaGiB: value.quotaBytes / 1024 ** 3 }
              : {}),
          }
        : { enabled: true, port: 1080, protocol: "socks", quotaGiB: 100 },
    );
    setBaseline(JSON.stringify(form.getFieldsValue(true)));
  }, [entity, form]);
  const close = () => {
    if (pending || (!!entity && submitting.current === entity) || confirming)
      return;
    if (!changed) return onClose();
    confirm(
      {
        title: "放弃未保存的修改？",
        description: entity?.kind === "nodes" ? "当前端点修改尚未保存。" : "当前用户修改尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  const title = displayEntity?.kind === "nodes" ? "端点" : "用户";
  return (
    <TaskDialog
      title={`${displayEntity?.value ? "编辑" : "添加"}${title}`}
      open={!!entity}
      onClosed={() => {
        if (!owner.current && presentation.current === displayEntity)
          presentation.current = null;
      }}
      footer={
        <div className="form-footer flex w-full flex-wrap items-center justify-end gap-2">
          <ActionButton
            disabled={pending || confirming}
            onClick={close}
            variant="outline"
          >
            取消
          </ActionButton>
          <ActionButton
            ref={submitButton}
            form={formId}
            type="submit"
            keepFocusableWhilePending
            pending={pending}
            disabled={confirming}
            aria-label="保存"
            aria-busy={pending}
            variant="default"
          >
            保存
          </ActionButton>
        </div>
      }
      onOpenChange={(open) => {
        if (!open) close();
      }}
      pending={pending}
      size={displayEntity?.kind === "nodes" ? "lg" : "md"}
      contentProps={{
        onFocusCapture: revealFocusedModalAction,
        inert: !entity,
      }}
    >
      <AppForm
        id={formId}
        form={form}
        disabled={pending || confirming}
        onFinish={(v) => {
          if (
            !entity ||
            !active.current ||
            owner.current !== entity ||
            confirming ||
            pending ||
            submitting.current === entity
          )
            return;
          const values = structuredClone(v);
          submitting.current = entity;
          const submit = submitButton.current;
          if (submit?.form?.contains(document.activeElement)) submit.focus();
          mutation.mutate({ values, task: entity });
        }}
      >
        <ErrorNotice error={mutation.error} />
        <div
          className={
            displayEntity?.kind === "nodes"
              ? "grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]"
              : undefined
          }
        >
          <AppField
            name="name"
            label={`${title}名称`}
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input />
          </AppField>
          {displayEntity?.kind === "nodes" && (
            <AppField name="region" label="地区">
              <Input placeholder="例如：UK" />
            </AppField>
          )}
        </div>
        {displayEntity?.kind === "nodes" ? (
          <>
            <ConnectionFields prefix={[]} />
            <Accordion type="multiple">
              <AccordionItem value="metadata">
                <AccordionTrigger>核心与标签</AccordionTrigger>
                <AccordionContent
                  forceMount
                  className="space-y-4 data-[state=closed]:hidden"
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    <AppField name="coreId" label="核心实例 ID">
                      <Input />
                    </AppField>
                    <AppField name="coreVersion" label="核心版本">
                      <Input />
                    </AppField>
                  </div>
                  <AppField name="tags" label="标签" trigger="onValueChange">
                    <MultiChoice creatable options={[]} />
                  </AppField>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        ) : (
          <>
            <AppField
              name="quotaGiB"
              label="账号基础额度（GiB，0 为不限额）"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <NumericInput
                min={0}
                disabled={!!displayEntity?.value || pending || confirming}
              />
            </AppField>
            {displayEntity?.value && (
              <p className="muted text-sm text-muted-foreground">
                额度与个人限制请在“授权与续期”中预览后调整。
              </p>
            )}
            <AppField
              name="enabled"
              label="启用账号"
              trigger="onCheckedChange"
              valuePropName="checked"
            >
              <Switch />
            </AppField>
            <p className="muted text-sm text-muted-foreground">
              停用账号会阻止平台服务及个人转换订阅访问。如只需暂停平台线路，请使用“暂停平台服务”。
            </p>
          </>
        )}
      </AppForm>
    </TaskDialog>
  );
}
const inviteDefaults = { name: "", role: "user", expiresInHours: 72 };

function InviteUser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = useForm();
  const [dirty, setDirty] = useState(false);
  const active = useRef(open);
  const submitting = useRef(false);
  useLayoutEffect(() => {
    active.current = open;
    return () => {
      active.current = false;
    };
  }, [open]);
  const { confirm, confirming } = useDiscardConfirmation("invite");
  const [result, setResult] = useState<{
    token?: string;
    url?: string;
    expiresAt?: string;
    name: string;
    role: string;
  } | null>(null);
  const mutation = useMutation({
    mutationFn: (values: {
      name: string;
      role: string;
      expiresInHours: number;
    }) =>
      post<{ token?: string; url?: string; expiresAt?: string }>(
        "/invites",
        values,
      ),
    onSettled: () => {
      submitting.current = false;
    },
    onSuccess: (value, submitted) => {
      if (!active.current) return;
      setDirty(false);
      setResult({ ...value, name: submitted.name, role: submitted.role });
    },
  });
  useUnsavedChanges(open && ((!result && dirty) || mutation.isPending));
  const close = () => {
    if (submitting.current || mutation.isPending || confirming) return;
    const finish = () => {
      if (active.current) onClose();
    };
    if (!dirty || result) return finish();
    confirm(
      {
        title: "放弃未生成的邀请？",
        description: "当前受邀人、角色与有效时长尚未提交。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedModalAction },
      },
      finish,
    );
  };
  return (
    <TaskDialog
      title="邀请用户"
      bodyProps={{ className: "space-y-5" }}
      open={open}
      footer={null}
      pending={mutation.isPending}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      contentProps={{ onFocusCapture: revealFocusedModalAction }}
    >
      {result ? (
        <>
          <Notice tone="success" title="邀请已创建">
            {result.name} · {result.role === "admin" ? "管理员" : "普通用户"}
          </Notice>
          <label className="standalone-label grid gap-2 text-sm font-medium">
            邀请链接
            <Input
              readOnly
              value={
                result.url ||
                `${location.origin}/?invite=${encodeURIComponent(result.token || "")}`
              }
              onFocus={(e) => e.target.select()}
            />
          </label>
          <p className="muted text-sm text-muted-foreground">
            有效期至 {dateLabel(result.expiresAt)}，请通过安全方式交给受邀人。
          </p>
        </>
      ) : (
        <AppForm
          form={form}
          initialValues={inviteDefaults}
          disabled={mutation.isPending}
          onValuesChange={(_changed, values) =>
            setDirty(
              Object.entries(inviteDefaults).some(
                ([field, initial]) => values[field] !== initial,
              ),
            )
          }
          onFinish={(values) => {
            if (
              !active.current ||
              submitting.current ||
              mutation.isPending ||
              confirming
            )
              return;
            submitting.current = true;
            mutation.mutate(structuredClone(values));
          }}
        >
          <ErrorNotice error={mutation.error} />
          <AppField name="name" label="受邀人名称" rules={[{ required: true }]}>
            <Input />
          </AppField>
          <AppField
            name="role"
            label="角色"
            description="管理员可管理平台、用户与服务器资源，请仅邀请可信任的人。"
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={[
                { value: "user", label: "普通用户" },
                { value: "admin", label: "管理员" },
              ]}
            />
          </AppField>
          <AppField
            name="expiresInHours"
            label="有效时长（小时）"
            rules={[
              {
                type: "integer",
                min: 1,
                max: 168,
                message: "有效时长为 1–168 小时",
              },
            ]}
            trigger="onValueChange"
          >
            <NumericInput min={1} max={168} />
          </AppField>
          <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <ActionButton
              disabled={mutation.isPending}
              onClick={close}
              variant="outline"
            >
              取消
            </ActionButton>
            <ActionButton
              type="submit"
              pending={mutation.isPending}
              variant="default"
            >
              生成邀请
            </ActionButton>
          </div>
        </AppForm>
      )}
    </TaskDialog>
  );
}
function PlatformSettingsTabs({
  initial,
  readNotice,
}: {
  initial: Record<string, unknown>;
  readNotice?: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState("basic");
  const sectionID = useId();
  const tabs = [
    {
      key: "basic",
      label: "基本设置",
      children: <Settings initial={initial} sectionID={sectionID} />,
    },
    { key: "security", label: "账号安全", children: <SecuritySettings /> },
    { key: "backup", label: "备份与恢复", children: <BackupSettings /> },
  ];
  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <WorkspaceFrame
        contentKind="settings"
        contextKind="navigation"
        contained={activeTab !== "basic"}
        header={<PageHeader title="平台设置" />}
        localNavigation={<PlatformSettingsTabList />}
        context={
          activeTab === "basic" ? (
            <SectionIndex
              presentation="workspace"
              label="本页设置"
              sections={[
                { id: `${sectionID}-platform-information`, label: "平台信息" },
                { id: `${sectionID}-subscription-domain`, label: "订阅域名" },
              ]}
            />
          ) : undefined
        }
      >
        {readNotice}
        {tabs.map((tab) => (
          <TabsContent
            key={tab.key}
            value={tab.key}
            forceMount={tab.key === "basic" ? true : undefined}
            hidden={activeTab !== tab.key}
            className={tab.key === "basic" ? "space-y-10" : "space-y-6"}
          >
            {tab.children}
          </TabsContent>
        ))}
      </WorkspaceFrame>
    </Tabs>
  );
}

function Settings({
  initial,
  sectionID,
}: {
  initial: Record<string, unknown>;
  sectionID: string;
}) {
  const [form] = useForm();
  const message = toast;
  const client = useQueryClient();
  const [baseline, setBaseline] = useState(initial);
  const [editingName, setEditingName] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameEditor = useRef<HTMLDivElement>(null);
  const editName = useRef<HTMLButtonElement>(null);
  const restoreNameFocus = useRef(false);
  useLayoutEffect(() => {
    if (editingName) nameInput.current?.focus();
    else if (restoreNameFocus.current) {
      restoreNameFocus.current = false;
      if (!editName.current?.closest("[hidden], [inert]"))
        editName.current?.focus();
    }
  }, [editingName]);
  const finishNameEdit = () => {
    restoreNameFocus.current = !!nameEditor.current?.contains(
      document.activeElement,
    );
    setEditingName(false);
  };
  const values = useWatch([], { form, preserve: true });
  const currentSettings = values || initial;
  const sameSettings = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) =>
    ["name", "registration", "timezone"].every(
      (key) => left[key] === right[key],
    );
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      request<Record<string, unknown>>("/settings", {
        method: "PUT",
        body: JSON.stringify(values),
      }),
    onSuccess: async (saved, submitted) => {
      // A pre-save background read must not replace the accepted settings.
      // Cancel only this composite read; later refreshes remain available.
      await client.cancelQueries({ queryKey: ["admin-state"], exact: true });
      client.setQueryData(
        ["admin-state"],
        (cached: Record<string, unknown> | undefined) =>
          cached ? { ...cached, settings: saved } : cached,
      );
      if (!active.current) return;
      setBaseline(saved);
      const currentMatchesSubmission = sameSettings(
        form.getFieldsValue(true),
        submitted,
      );
      if (currentMatchesSubmission) {
        form.setFieldsValue(saved);
        finishNameEdit();
      }
      message.success(
        currentMatchesSubmission
          ? "平台设置已保存"
          : "提交的设置已保存，当前修改尚未保存",
      );
    },
  });
  useUnsavedChanges(
    !sameSettings(values || initial, baseline) || save.isPending,
  );
  return (
    <>
      <PageSection id={`${sectionID}-platform-information`} label="平台信息">
        <SettingsGroup title="平台信息">
          <AppForm
            aria-label="平台基本设置"
            form={form}
            initialValues={initial}
            onFinish={(v) => {
              if (!save.isPending) save.mutate(structuredClone(v));
            }}
            className="settings-form"
          >
            <dl hidden={editingName} className="border-b">
              <SettingsRow
                label="平台名称"
                action={
                  <ActionButton
                    ref={editName}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      save.reset();
                      setEditingName(true);
                    }}
                  >
                    编辑平台名称
                  </ActionButton>
                }
              >
                {String(baseline.name || "未设置")}
              </SettingsRow>
            </dl>
            <div
              ref={nameEditor}
              hidden={!editingName}
              className="space-y-4 border-b px-4 py-5 sm:px-5"
            >
              <ErrorNotice error={save.error} />
              <AppField name="name" label="平台名称" className="max-w-xl">
                <Input ref={nameInput} />
              </AppField>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  type="submit"
                  pending={save.isPending}
                  keepFocusableWhilePending
                  variant="default"
                >
                  保存设置
                </ActionButton>
                <ActionButton
                  type="button"
                  disabled={save.isPending}
                  variant="outline"
                  onClick={() => {
                    form.setFieldValue("name", baseline.name);
                    save.reset();
                    finishNameEdit();
                  }}
                >
                  取消名称修改
                </ActionButton>
              </div>
            </div>
            {/* Keep fixed policies registered in the complete settings payload. */}
            <AppField name="registration" hidden>
              <input type="hidden" />
            </AppField>
            <AppField name="timezone" hidden>
              <input type="hidden" />
            </AppField>
            <dl className="divide-y">
              <SettingsRow
                label="账号注册"
                description="新账号须由管理员生成邀请后创建。"
              >
                {currentSettings.registration === "invite"
                  ? "仅受邀用户"
                  : String(currentSettings.registration || "未设置")}
              </SettingsRow>
              <SettingsRow
                label="默认时区"
                description="流量周期按 UTC+8 计算；具体重置方式在服务方案或用户授权中设置。"
              >
                {String(currentSettings.timezone || "未设置")}
              </SettingsRow>
            </dl>
          </AppForm>
        </SettingsGroup>
      </PageSection>
      <PageSection id={`${sectionID}-subscription-domain`} label="订阅域名设置">
        <SubscriptionOriginSettings />
      </PageSection>
    </>
  );
}
function AuditLog() {
  const query = useQuery({
    queryKey: ["audit"],
    queryFn: () =>
      list<{
        id: string;
        actorId: string;
        action: string;
        targetId: string;
        at: string;
      }>("/audit"),
  });
  const labels: Record<string, string> = {
    "invite.created": "创建邀请",
    "service.saved": "保存服务方案",
    "entitlement.saved": "修改服务授权",
    "usage.reset": "手动重置额度",
    "mfa.enabled": "启用二次验证",
    "inventory.saved": "修改服务器资源",
    "deployment.queued": "提交线路更新",
    "entry.granted": "分配用户入口",
  };
  return (
    <Section title="操作审计" variant="plain">
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <DataTable
          rowKey="id"
          rows={[...(query.data || [])].sort((a, b) =>
            b.at.localeCompare(a.at),
          )}
          columns={[
            { title: "操作", render: (_, v) => labels[v.action] || v.action },
            { title: "对象", accessor: "targetId" },
            { title: "时间", render: (_, v) => dateLabel(v.at) },
          ]}
          expandedRow={(value) => (
            <p className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              操作者账号：{value.actorId} · 审计标识：{value.id}
            </p>
          )}
          pageSize={10}
          empty="暂无管理操作记录"
          compact
        />
      </QueryState>
    </Section>
  );
}

/** Close the menu before transferring focus into the selected task. */
function AdminRowMenu({
  name,
  actions,
}: {
  name: string;
  actions: {
    label: string;
    accessibleLabel?: string;
    destructive?: boolean;
    run: () => void;
  }[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const requestedAction = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={`更多操作 ${name}`}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = requestedAction.current;
          if (!action) return;
          event.preventDefault();
          requestedAction.current = null;
          // Navigation may have removed the row while its menu was closing.
          if (!trigger.current?.isConnected) return;
          trigger.current.focus();
          action();
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            variant={action.destructive ? "destructive" : "default"}
            aria-label={action.accessibleLabel}
            onSelect={() => {
              requestedAction.current = action.run;
              setOpen(false);
            }}
          >
            {action.destructive && <DeleteOutlined aria-hidden="true" />}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
