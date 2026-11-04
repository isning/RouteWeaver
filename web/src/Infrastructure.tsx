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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { AppField, AppForm, useForm, useWatch } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Server as CloudServerOutlined,
  Pencil as EditOutlined,
  KeyRound as KeyOutlined,
  Plus as PlusOutlined,
  RotateCw as ReloadOutlined,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PolicyDateInput } from "./PolicyDateInput";
import { AccountingRecovery } from "./AccountingRecovery";
import { list, post, request, saveRecord } from "./api";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";
import { DataTable, TableRowActions } from "./DataTable";
import { DiagnosticsPanel } from "./Diagnostics";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { phaseLabel, isUnchangedEndpointDraft } from "./infrastructure-model";
import { dateLabel, newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import { NodeObservation } from "./NodeObservation";
import type {
  AgentState,
  CoreInstance,
  HostRecord,
  Infrastructure,
  ManagedEndpoint,
  ManagedLink,
  ServerDeployment,
} from "./types";
// New instance defaults only; editing preserves the saved version. Client render
// targets and the managed embedded core have independent version contracts.
const coreVersions: Record<string, string> = {
  "routeweaver/sing-box": "1.14.4",
  "routeweaver/xray": "26.10.31",
  "routeweaver/managed-xray": "26.3.27-rw1",
};
// Creation recipe for the verified platform-entry target, not a registry of all
// server capabilities. Unknown adapters/versions retain the generic editor.
const usesManagedEntryPreset = (instance?: CoreInstance) =>
  instance?.adapterId === "routeweaver/managed-xray" &&
  instance.version === coreVersions["routeweaver/managed-xray"];
export function ServersPage() {
  const query = useQuery({
    queryKey: ["infrastructure"],
    queryFn: loadInfrastructure,
  });
  const [tab, setTab] = useState("hosts");
  const [entity, setEntity] = useState<{
    kind: string;
    value: HostRecord | CoreInstance | ManagedEndpoint | null;
    id: string;
    hostId?: string;
    instanceId?: string;
  } | null>(null);
  const [host, setHost] = useState<HostRecord | null>(null);
  const hostPageOpener = useRef<HTMLElement | null>(null);
  const pageCreateAction = useRef<HTMLButtonElement>(null);
  const hostResumeAction = useRef<string | null>(null);
  const hostActions = useRef(new Map<string, HTMLButtonElement>());
  const openHost = (value: HostRecord) => {
    hostPageOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    hostResumeAction.current = null;
    setHost(value);
  };

  const [instance, setInstance] = useState<CoreInstance | null>(null);
  const data = query.data;
  const label =
    tab === "hosts"
      ? "服务器"
      : tab === "core-instances"
        ? "核心实例"
        : "监听端点";
  const [editError, setEditError] = useState<Error | null>(null);
  const editSequence = useRef(0);
  const edit = async (
    value: HostRecord | CoreInstance | ManagedEndpoint | null,
    kind = tab,
    hostId?: string,
    instanceId?: string,
  ) => {
    const sequence = ++editSequence.current;
    setEditError(null);
    try {
      const full =
        kind === "managed-endpoints" && value
          ? await request<ManagedEndpoint>(
              `/managed-endpoints/${value.id}/reveal`,
            )
          : value;
      if (sequence !== editSequence.current) return;
      setEntity({
        kind,
        value: full,
        hostId,
        instanceId,
        id:
          value?.id ||
          newID(
            kind === "hosts"
              ? "host"
              : kind === "core-instances"
                ? "core"
                : "endpoint",
          ),
      });
    } catch (error) {
      if (sequence === editSequence.current) setEditError(error as Error);
    }
  };
  return (
    <>
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
      <ErrorNotice error={editError} />
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        loadingLayout="cards"
        error={query.error}
        retry={() => query.refetch()}
      >
        {data && (
          <Section variant="plain">
            <Tabs
              value={tab}
              onValueChange={setTab}
              defaultValue={"hosts"}
              className="w-full space-y-4"
            >
              <TabsList className="h-auto max-w-full flex-wrap">
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
              </TabsList>
              <TabsContent key={"hosts"} value={"hosts"}>
                {data.hosts.length ? (
                  <div className="server-grid grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {data.hosts.map((value) => (
                      <Card className="server-card min-w-0" key={value.id}>
                        <CardHeader>
                          <CardTitle>
                            <button
                              className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                        <CardContent className="text-xs text-muted-foreground">
                          {
                            data.instances.filter((i) => i.hostId === value.id)
                              .length
                          }{" "}
                          个核心实例
                        </CardContent>
                      </Card>
                    ))}
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
                            onClick={() => setInstance(i)}
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
                              onClick={() => setInstance(i)}
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
      <InventoryEditor
        entity={entity}
        inventory={data}
        onClose={() => setEntity(null)}
        onHostCreated={(created) => {
          hostPageOpener.current = pageCreateAction.current;
          hostResumeAction.current = "add-core";
          setHost(created);
        }}
      />
      <TaskSheet
        bodyProps={{ className: "space-y-5" }}
        title={host?.name}
        open={!!host && !entity}
        initialFocus={() =>
          hostResumeAction.current
            ? (hostActions.current.get(hostResumeAction.current) ?? null)
            : null
        }
        onReady={() => {
          hostResumeAction.current = null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (host || entity) return;
          const target = hostPageOpener.current;
          queueMicrotask(() => {
            const focused = document.activeElement;
            if (
              focused instanceof HTMLElement &&
              focused.closest('[data-task-overlay][data-state="open"]')
            )
              return;
            if (
              target?.isConnected &&
              !target.closest('[hidden],[inert],[aria-hidden="true"]') &&
              !target.matches(":disabled")
            )
              target.focus({ preventScroll: true });
          });
        }}
        onOpenChange={(next) => {
          if (!next) (() => setHost(null))();
        }}
        size="lg"
      >
        {host && data && (
          <>
            <div className="host-summary flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 p-4 text-sm [&_svg]:size-5 [&_svg]:shrink-0 [&_p]:break-all [&_p]:text-muted-foreground">
              <CloudServerOutlined aria-hidden="true" />
              <div>
                <h2 className="text-base font-semibold tracking-tight">
                  {host.name}
                </h2>
                <p>{host.address}</p>
              </div>
            </div>
            <Section
              title="核心实例"
              variant="plain"
              description={
                data.instances.some((i) => i.hostId === host.id)
                  ? "为核心配置监听端点，或查看接入与运行状态。"
                  : "先添加核心，再配置监听端点"
              }
              extra={
                <ActionButton
                  ref={(node) => {
                    if (node) hostActions.current.set("add-core", node);
                    else hostActions.current.delete("add-core");
                  }}
                  onClick={() => {
                    hostResumeAction.current = "add-core";
                    edit(null, "core-instances", host.id);
                  }}
                  variant="default"
                >
                  添加核心
                </ActionButton>
              }
            >
              {data.instances
                .filter((i) => i.hostId === host.id)
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
                    <div className={"flex flex-wrap items-center gap-2"}>
                      <ActionButton
                        aria-label={`为 ${coreName(i)} 添加监听端点`}
                        ref={(node) => {
                          if (node) hostActions.current.set(i.id, node);
                          else hostActions.current.delete(i.id);
                        }}
                        onClick={() => {
                          hostResumeAction.current = i.id;
                          edit(null, "managed-endpoints", host.id, i.id);
                        }}
                        variant="outline"
                      >
                        添加监听端点
                      </ActionButton>
                      <ActionButton
                        onClick={() => setInstance(i)}
                        variant="outline"
                      >
                        查看
                      </ActionButton>
                    </div>
                  </div>
                ))}
            </Section>
            <Accordion type="multiple" defaultValue={[]} className="w-full">
              {[
                {
                  key: "operations",
                  label:
                    "\u8D44\u6E90\u3001\u989D\u5EA6\u4E0E\u8FDE\u63A5\u8BCA\u65AD",
                  children: (
                    <Tabs
                      defaultValue={"resources"}
                      className="w-full space-y-4"
                    >
                      <TabsList className="h-auto max-w-full flex-wrap">
                        <TabsTrigger key={"resources"} value={"resources"}>
                          {"\u8D44\u6E90\u4E0E\u989D\u5EA6"}
                        </TabsTrigger>
                        <TabsTrigger key={"diagnostics"} value={"diagnostics"}>
                          {"\u8FDE\u63A5\u8BCA\u65AD"}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent key={"resources"} value={"resources"}>
                        {
                          <NodeObservation
                            host={host}
                            instances={data.instances}
                          />
                        }
                      </TabsContent>
                      <TabsContent key={"diagnostics"} value={"diagnostics"}>
                        {
                          <DiagnosticsPanel
                            host={host}
                            instances={data.instances}
                          />
                        }
                      </TabsContent>
                    </Tabs>
                  ),
                },
                {
                  key: "ids",
                  label: "\u6280\u672F\u6807\u8BC6",
                  children: (
                    <p className="muted text-sm text-muted-foreground">
                      服务器 ID：{host.id}
                    </p>
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
      </TaskSheet>
      <InstanceDetail
        instance={instance}
        inventory={data}
        onClose={() => setInstance(null)}
      />
    </>
  );
}
function InventoryEditor({
  entity,
  inventory,
  onClose,
  onHostCreated,
}: {
  entity: {
    kind: string;
    value: HostRecord | CoreInstance | ManagedEndpoint | null;
    id: string;
    hostId?: string;
    instanceId?: string;
  } | null;
  inventory?: Infrastructure;
  onClose: () => void;
  onHostCreated: (host: HostRecord) => void;
}) {
  const owner = useRef(entity);
  owner.current = entity;
  const presentation = useRef(entity);
  useLayoutEffect(() => {
    if (entity) presentation.current = entity;
  }, [entity]);
  const displayEntity = entity || presentation.current;
  const [form] = useForm();
  const formId = useId();
  const client = useQueryClient();
  const message = toast;
  const { confirm, confirming } = useDiscardConfirmation(
    entity?.id || "inventory-closed",
  );
  const [baseline, setBaseline] = useState("");
  const values = useWatch([], { form, preserve: true });
  const changed =
    !!entity && baseline !== "" && JSON.stringify(values || {}) !== baseline;
  useUnsavedChanges(changed);
  const adapter = useWatch("adapterId", form);
  const endpointHostId = useWatch("endpointHostId", form);
  const endpointInstanceId = useWatch("instanceId", form);
  const authentication = useWatch("authentication", form);
  const endpointProtocol = useWatch(["connection", "protocol"], form);
  const selectedEndpointInstance = inventory?.instances.find(
    (i) => i.id === endpointInstanceId,
  );
  const managedEntrySelected = usesManagedEntryPreset(selectedEndpointInstance);
  const endpointInstances = (inventory?.instances || []).filter(
    (i) => i.hostId === endpointHostId,
  );
  const currentEndpoint =
    displayEntity?.kind === "managed-endpoints"
      ? (displayEntity.value as ManagedEndpoint | null)
      : null;
  const existingEndpointSnapshot = useRef<{
    endpoint: ManagedEndpoint;
    instance?: CoreInstance;
  } | null>(null);
  const currentEndpointInstance = inventory?.instances.find(
    (i) => i.id === currentEndpoint?.instanceId,
  );
  const allowUnchangedUnsupportedProtocol =
    !!currentEndpoint &&
    !!existingEndpointSnapshot.current &&
    isUnchangedEndpointDraft(
      existingEndpointSnapshot.current,
      {
        ...currentEndpoint,
        ...values,
        connection: normalizeConnection({
          ...currentEndpoint.connection,
          ...values?.connection,
        }),
      },
      selectedEndpointInstance,
    );
  const endpointValue = (values: Record<string, unknown>) => {
    const { endpointHostId: _endpointHostId, ...fields } = values;
    const value = { ...entity!.value, ...fields, id: entity!.id };
    if (entity!.kind === "managed-endpoints")
      Object.assign(value, {
        connection: normalizeConnection({
          ...currentEndpoint?.connection,
          ...(value as unknown as ManagedEndpoint).connection,
        }),
      });
    return value;
  };
  const mutation = useMutation({
    mutationFn: ({
      fields,
      impact,
    }: {
      fields: Record<string, unknown>;
      impact?: string;
    }) => {
      const value = endpointValue(fields);
      if (entity!.kind === "managed-endpoints" && entity!.value) {
        const { revisionToken, ...draft } = value as ManagedEndpoint;
        return request<ManagedEndpoint>(
          `/managed-endpoints/${encodeURIComponent(draft.id)}`,
          {
            method: "PUT",
            headers: {
              "If-Match": revisionToken || "",
              "X-Endpoint-Impact": impact || "",
            },
            body: JSON.stringify(draft),
          },
        );
      }
      return saveRecord<HostRecord | CoreInstance | ManagedEndpoint>(
        entity!.kind,
        value,
        !entity!.value,
      );
    },
    onSuccess: (saved) => {
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      message.success("配置已保存");
      if (entity?.kind === "hosts" && !entity.value)
        onHostCreated(saved as HostRecord);
      onClose();
    },
  });
  const impact = useMutation({
    mutationFn: async (fields: Record<string, unknown>) => {
      const task = entity;
      const { revisionToken, ...draft } = endpointValue(
        fields,
      ) as ManagedEndpoint;
      const review = await request<{
        endpoint: { id: string; name: string };
        proposed: {
          name: string;
          instanceId: string;
          instanceName: string;
          host: string;
          port: number;
          protocol: string;
        };
        changedFields: string[];
        deployments: { id: string; name: string }[];
        routes: { id: string; name: string }[];
        links: { id: string; name: string }[];
        reviewToken: string;
      }>(`/managed-endpoints/${encodeURIComponent(draft.id)}/impact`, {
        method: "POST",
        headers: { "If-Match": revisionToken || "" },
        body: JSON.stringify(draft),
      });
      return { task, fields, review };
    },
    onSuccess: ({ task, fields, review }) => {
      if (!task || owner.current !== task) return;
      confirm(
        {
          title: `保存端点「${review.endpoint.name}」的修改？`,
          confirmLabel: "确认保存端点",
          cancelLabel: "返回编辑",
          description: (
            <div className="space-y-3">
              <p>修改项目：{review.changedFields.join("、") || "无变化"}。</p>
              <p>
                <span className="block font-medium">
                  保存为：{review.proposed.name}
                </span>
                <span className="block">
                  核心：
                  {review.proposed.instanceName || review.proposed.instanceId}
                </span>
                <span className="block">
                  {review.proposed.protocol} {review.proposed.host}:
                  {review.proposed.port}
                </span>
              </p>
              {(
                [
                  ["转发配置", review.deployments],
                  ["发布线路", review.routes],
                  ["连接关系", review.links],
                ] as const
              ).map(([label, items]) => (
                <div key={label}>
                  <p>
                    {label}：
                    {items.length ? `${items.length} 项需要重新核对` : "无引用"}
                  </p>
                  {items.length > 0 && (
                    <ul>
                      {items.map((item) => (
                        <li key={item.id}>
                          {item.name || item.id}{" "}
                          <span className="text-sm text-muted-foreground">
                            （{item.id}）
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              <p>
                本次仅更新端点清单，保留已保存的转发配置、当前出口与节点配置。引用此端点的配置需另行更新、校验并确认发布。
              </p>
            </div>
          ),
        },
        (stillCurrent) => {
          if (stillCurrent() && owner.current === task)
            mutation.mutate({ fields, impact: review.reviewToken });
        },
      );
    },
  });
  const names: Record<string, string> = {
    hosts: "服务器",
    "core-instances": "核心实例",
    "managed-endpoints": "监听端点",
  };
  useEffect(() => {
    if (!entity) {
      setBaseline("");
      return;
    }
    form.resetFields();
    mutation.reset();
    impact.reset();
    existingEndpointSnapshot.current =
      entity.kind === "managed-endpoints" && entity.value
        ? structuredClone({
            endpoint: entity.value as ManagedEndpoint,
            instance: inventory?.instances.find(
              (i) => i.id === (entity.value as ManagedEndpoint).instanceId,
            ),
          })
        : null;
    const managedEntryPreset = usesManagedEntryPreset(
      inventory?.instances.find((i) => i.id === entity.instanceId),
    );
    form.setFieldsValue(
      entity.value
        ? {
            ...entity.value,
            ...(entity.kind === "managed-endpoints"
              ? {
                  endpointHostId: inventory?.instances.find(
                    (i) =>
                      i.id === (entity.value as ManagedEndpoint).instanceId,
                  )?.hostId,
                }
              : {}),
          }
        : entity.kind === "core-instances"
          ? {
              adapterId: "routeweaver/sing-box",
              version: coreVersions["routeweaver/sing-box"],
              hostId: entity.hostId || inventory?.hosts[0]?.id,
            }
          : entity.kind === "managed-endpoints"
            ? {
                endpointHostId: entity.hostId,
                instanceId: entity.instanceId,
                authentication: managedEntryPreset ? "principals" : undefined,
                connection: managedEntryPreset
                  ? { host: "0.0.0.0", protocol: "vless" }
                  : { host: "0.0.0.0", port: 1080, protocol: "socks" },
              }
            : {},
    );
    setBaseline(JSON.stringify(form.getFieldsValue(true)));
  }, [entity, form]);
  const close = () => {
    if (mutation.isPending || impact.isPending || confirming) return;
    if (!changed) return onClose();
    confirm(
      {
        title: "放弃尚未保存的配置修改？",
        description: "当前填写的服务器、核心或监听端点配置尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title={`${displayEntity?.value ? "编辑" : "添加"}${names[displayEntity?.kind || "hosts"]}`}
      open={!!entity}
      onClosed={() => {
        if (!owner.current && presentation.current === displayEntity) {
          presentation.current = null;
          existingEndpointSnapshot.current = null;
          form.resetFields();
        }
      }}
      pending={mutation.isPending || impact.isPending}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <ActionButton
            disabled={mutation.isPending || impact.isPending || confirming}
            onClick={close}
            variant="outline"
          >
            取消
          </ActionButton>
          <ActionButton
            type="submit"
            form={formId}
            pending={mutation.isPending || impact.isPending}
            keepFocusableWhilePending={impact.isPending}
            variant="default"
          >
            保存
          </ActionButton>
        </div>
      }
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size={displayEntity?.kind === "managed-endpoints" ? "lg" : "md"}
      contentProps={{
        onFocusCapture: revealFocusedPolicyModalControl,
        inert: !entity,
      }}
    >
      <AppForm
        id={formId}
        form={form}
        disabled={mutation.isPending || impact.isPending || confirming}
        onFinish={(v) => {
          if (
            !entity ||
            owner.current !== entity ||
            mutation.isPending ||
            impact.isPending ||
            confirming
          )
            return;
          if (entity.kind === "managed-endpoints" && entity.value)
            impact.mutate(v);
          else mutation.mutate({ fields: v });
        }}
      >
        <ErrorNotice error={mutation.error || impact.error} />
        {displayEntity?.kind === "hosts" ? (
          <>
            <AppField
              name="name"
              label="服务器名称"
              rules={[{ required: true }]}
            >
              <Input placeholder="例如：FRA 01" />
            </AppField>
            <AppField
              name="address"
              label="服务器连接地址"
              rules={[{ required: true, message: "请输入服务器的 IP 或域名" }]}
            >
              <Input placeholder="fra.example.com" />
            </AppField>
            <p className="muted text-sm text-muted-foreground">
              这是其他服务器连接该主机时使用的地址，与监听 IP 分开。
            </p>
            <div className="form-grid grid gap-4 sm:grid-cols-2">
              <AppField name="group" label="服务器分组">
                <Input placeholder="例如：生产入口" maxLength={64} />
              </AppField>
              <AppField
                name="tags"
                label="标签"
                trigger="onValueChange"
                rules={[
                  { type: "array", max: 32, message: "最多添加 32 个标签" },
                ]}
              >
                <MultiChoice
                  options={[]}
                  placeholder="用于筛选批量变更范围"
                  creatable
                />
              </AppField>
            </div>
          </>
        ) : displayEntity?.kind === "core-instances" ? (
          <>
            <AppField name="name" label="实例名称">
              <Input placeholder="例如：FRA 公共入口核心" />
            </AppField>
            <AppField
              name="hostId"
              label="所属服务器"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={(inventory?.hosts || []).map((h) => ({
                  value: h.id,
                  label: h.name,
                }))}
              />
            </AppField>
            <AppField
              name="adapterId"
              label="核心家族"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={[
                  { value: "routeweaver/sing-box", label: "sing-box" },
                  { value: "routeweaver/xray", label: "Xray" },
                  {
                    value: "routeweaver/managed-xray",
                    label: "受管 Xray",
                    description: "平台服务入口",
                  },
                ]}
                onValueChange={(v) => {
                  if (v !== adapter) {
                    form.setFieldValue(
                      "version",
                      coreVersions[v ?? "routeweaver/sing-box"],
                    );
                  }
                }}
              />
            </AppField>
            <AppField
              name="version"
              label="核心版本"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={[
                  {
                    value: coreVersions[adapter],
                    label: coreVersions[adapter],
                  },
                ]}
              />
            </AppField>
          </>
        ) : (
          <>
            <AppField name="name" label="端点名称" rules={[{ required: true }]}>
              <Input placeholder="例如：FRA 公共入口" />
            </AppField>
            <AppField
              name="endpointHostId"
              label="所属服务器"
              rules={[{ required: true, message: "请先选择服务器" }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                placeholder="选择服务器"
                options={[
                  ...(inventory?.hosts || []).map((h) => ({
                    value: h.id,
                    label: h.name,
                  })),
                  ...(currentEndpointInstance &&
                  !inventory?.hosts.some(
                    (h) => h.id === currentEndpointInstance.hostId,
                  )
                    ? [
                        {
                          value: currentEndpointInstance.hostId,
                          label: `服务器已移除（${currentEndpointInstance.hostId}）`,
                          disabled: true,
                        },
                      ]
                    : []),
                ]}
                onValueChange={() =>
                  form.setFieldValue("instanceId", undefined)
                }
              />
            </AppField>
            <AppField
              name="instanceId"
              label="所属核心"
              rules={[{ required: true, message: "请选择这台服务器上的核心" }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                disabled={!endpointHostId || !endpointInstances.length}
                placeholder={endpointHostId ? "选择核心" : "请先选择服务器"}
                options={[
                  ...endpointInstances.map((i) => ({
                    value: i.id,
                    label:
                      endpointInstances.filter(
                        (other) => coreName(other) === coreName(i),
                      ).length > 1
                        ? `${coreName(i)}（${i.id}）`
                        : coreName(i),
                  })),
                  ...(currentEndpoint &&
                  !currentEndpointInstance &&
                  endpointInstanceId === currentEndpoint.instanceId
                    ? [
                        {
                          value: currentEndpoint.instanceId,
                          label: `核心已移除（${currentEndpoint.instanceId}）`,
                          disabled: true,
                        },
                      ]
                    : []),
                ]}
              />
            </AppField>
            {currentEndpoint && !currentEndpointInstance && (
              <Notice
                tone="warning"
                title="原核心已移除，请重新选择服务器和核心。"
              />
            )}
            {endpointHostId && !endpointInstances.length && (
              <p className="muted text-sm text-muted-foreground">
                这台服务器还没有核心，请先在服务器详情中添加核心。
              </p>
            )}
            <AppField name="authentication" hidden>
              <Input />
            </AppField>
            {managedEntrySelected &&
              (endpointProtocol !== "vless" ||
                authentication !== "principals") && (
                <Notice tone="warning" title="此核心需要 VLESS 用户凭据">
                  {
                    "\u8BF7\u8C03\u6574\u534F\u8BAE\u6216\u8BA4\u8BC1\u65B9\u5F0F\u3002"
                  }
                </Notice>
              )}
            {managedEntrySelected &&
              !currentEndpoint &&
              authentication !== "principals" && (
                <ActionButton
                  onClick={() => {
                    form.setFieldValue("authentication", "principals");
                    form.setFieldsValue({
                      connection: {
                        protocol: "vless",
                        uuid: undefined,
                        flow: undefined,
                        username: undefined,
                        password: undefined,
                        method: undefined,
                      },
                    });
                  }}
                  variant="outline"
                >
                  改用 VLESS 用户凭据模式（替换当前认证）
                </ActionButton>
              )}
            <ConnectionFields
              server
              authentication={authentication}
              managedEntryTarget={managedEntrySelected}
              allowUnchangedUnsupportedProtocol={
                allowUnchangedUnsupportedProtocol
              }
              targetCore={selectedEndpointInstance?.adapterId.replace(
                /^routeweaver\//,
                "",
              )}
            />
          </>
        )}
        {displayEntity?.kind === "hosts" && !displayEntity.value && (
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            将服务器信息登记到控制平面；服务器连接与配置需另行操作。
          </p>
        )}
      </AppForm>
    </TaskDialog>
  );
}
export function InstanceObservation({ instanceId }: { instanceId: string }) {
  const query = useQuery({
    queryKey: ["instance-state", instanceId],
    queryFn: () => request<AgentState>(`/agent/instances/${instanceId}/state`),
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
        : false,
  });
  const data = query.data;
  return (
    <QueryState
      loading={query.isPending}
      paused={query.isPaused}
      loadingLayout="summary"
      error={query.error}
      retry={() => query.refetch()}
    >
      {data && (
        <>
          <div className="instance-phase flex flex-wrap items-center justify-between gap-3">
            <Badge variant="secondary">{phaseLabel(data.phase)}</Badge>
            <ActionButton
              leadingIcon={<ReloadOutlined aria-hidden="true" />}
              aria-label="刷新实例状态"
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
                授权状态表示持续运行权限；核心运行结果以上方节点确认状态为准。
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">未设置持续服务授权</p>
          )}
          {data.state?.observed && (
            <p className="muted text-sm text-muted-foreground">
              最近确认 {dateLabel(data.state.observed.observedAt)}
            </p>
          )}
          {data.state?.code && (
            <Notice tone="warning" title="实例需要处理">
              {data.state.code}
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
  instance,
  inventory,
  onClose,
}: {
  instance: CoreInstance | null;
  inventory?: Infrastructure;
  onClose: () => void;
}) {
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  return (
    <TaskSheet
      bodyProps={{ className: "space-y-5" }}
      title={
        instance
          ? `${inventory?.hosts.find((h) => h.id === instance.hostId)?.name || ""}的${coreName(instance)}`
          : ""
      }
      open={!!instance}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
    >
      {instance && (
        <>
          <div className="section-heading flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                {coreName(instance)}
              </h2>
              <p>版本 {instance.version}</p>
            </div>
            <ActionButton
              leadingIcon={<KeyOutlined aria-hidden="true" />}
              onClick={() => setEnrollmentOpen(true)}
              variant="outline"
            >
              接入 Agent
            </ActionButton>
          </div>
          <Section title="运行状态">
            <InstanceObservation instanceId={instance.id} />
          </Section>
          <AccountingRecovery instanceId={instance.id} />
          <Section title="监听端点" variant="plain">
            {inventory &&
              !inventory.endpoints.some(
                (e) => e.instanceId === instance.id,
              ) && (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  此核心尚未配置监听端点。
                </p>
              )}
            {inventory?.endpoints
              .filter((e) => e.instanceId === instance.id)
              .map((e) => (
                <div
                  className="subscription-row flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                  key={e.id}
                >
                  <div className="subscription-info min-w-0 space-y-1">
                    <h3 className="text-sm font-semibold">{e.name}</h3>
                    <p>
                      <span className="block">
                        {e.connection.host}:{e.connection.port}
                      </span>
                      <span className="block text-muted-foreground">
                        {e.connection.protocol}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
          </Section>
          <Enrollment
            instance={instance}
            open={enrollmentOpen}
            onClose={() => setEnrollmentOpen(false)}
          />
        </>
      )}
    </TaskSheet>
  );
}
function Enrollment({
  instance,
  open,
  onClose,
}: {
  instance: CoreInstance;
  open: boolean;
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
  const mutation = useMutation({
    mutationFn: (values: { expiresAt: string }) =>
      post<{
        scope: {
          nodeId: string;
          instanceId: string;
          enrollmentEpoch: string;
        };
        token: string;
      }>("/agent/enrollments", {
        ...values,
        nodeId: instance.hostId,
        instanceId: instance.id,
      }),
    onSuccess: setResult,
  });
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title="接入核心实例"
      open={open}
      pending={mutation.isPending}
      footer={null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onReady={() =>
        ((show) => {
          if (show) {
            setResult(null);
            setDateOpen(false);
            setDatePending(false);
            mutation.reset();
            form.setFieldsValue({
              expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            });
          }
        })(true)
      }
      onClosed={() => {
        ((show) => {
          if (show) {
            setResult(null);
            setDateOpen(false);
            setDatePending(false);
            mutation.reset();
            form.setFieldsValue({
              expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            });
          }
        })(false);
      }}
    >
      {result ? (
        <>
          <Notice tone="success" title="接入凭据已创建">
            {
              "\u53EA\u5C06\u5B83\u914D\u7F6E\u5230\u6B64\u670D\u52A1\u5668\u7684\u5BF9\u5E94\u6838\u5FC3\u5B9E\u4F8B\u3002\u4E0D\u8981\u5206\u4EAB\u7ED9\u5176\u4ED6\u4EBA\u3002"
            }
          </Notice>
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
        </>
      ) : (
        <AppForm
          form={form}
          disabled={mutation.isPending}
          onFinish={(v) => {
            if (!dateOpen && !datePending && !mutation.isPending)
              mutation.mutate(v);
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
            <ActionButton onClick={onClose} variant="outline">
              取消
            </ActionButton>
            <ActionButton
              type="submit"
              disabled={dateOpen || datePending}
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
