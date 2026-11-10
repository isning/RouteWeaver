import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { AppField, AppForm, useForm, useWatch } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { useSaveNotice } from "./useSaveNotice";
import { request, saveRecord } from "./api";
import { ErrorNotice } from "./components";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { isUnchangedEndpointDraft } from "./infrastructure-model";
import { coreName } from "./infrastructure-data";
import { useUnsavedChanges } from "./navigation";
import type { CoreInstance, HostRecord, Infrastructure, ManagedEndpoint } from "./types";

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
export type InventoryEditTask = {
  kind: "hosts" | "core-instances" | "managed-endpoints";
  value: HostRecord | CoreInstance | ManagedEndpoint | null;
  id: string;
  hostId?: string;
  instanceId?: string;
};

export type InventoryEditorProps = {
  entity: InventoryEditTask | null;
  inventory?: Infrastructure;
  onClose: () => void;
  onClosed?: () => void;
  scopeIssue?: string;
  readScopeIssue?: () => string | null;
  onHostCreated: (host: HostRecord) => void;
  onCoreCreated: (instance: CoreInstance) => void;
  onEndpointSaved: (endpoint: ManagedEndpoint) => void;
};

export function InventoryEditor({
  entity,
  inventory,
  onClose,
  onClosed,
  scopeIssue,
  readScopeIssue,
  onHostCreated,
  onCoreCreated,
  onEndpointSaved,
}: InventoryEditorProps) {
  const owner = useRef(entity);
  owner.current = entity;
  const submittedOwner = useRef<InventoryEditTask | null>(null);
  useLayoutEffect(() => {
    // rc-form reads its latest finish callback after asynchronous validation.
    // A close/reopen must not let an old submission finish in the new session.
    submittedOwner.current = null;
  }, [entity]);
  const currentScopeIssue = useRef(scopeIssue);
  currentScopeIssue.current = scopeIssue;
  const currentScopeReader = useRef(readScopeIssue);
  currentScopeReader.current = readScopeIssue;
  const scopeAtAction = () => currentScopeReader.current?.() || currentScopeIssue.current;
  const presentation = useRef(entity);
  useLayoutEffect(() => {
    if (entity) presentation.current = entity;
  }, [entity]);
  const displayEntity = entity || presentation.current;
  const [form] = useForm();
  const formId = useId();
  const client = useQueryClient();
  const saveNotice = useSaveNotice(entity);
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
      const issue = scopeAtAction();
      if (issue) throw new Error(issue);
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
      const name = entity?.kind === "core-instances"
        ? coreName(saved as CoreInstance)
        : saved.name;
      saveNotice(`${names[entity!.kind]}「${name}」已保存`);
      if (entity?.kind === "hosts" && !entity.value)
        onHostCreated(saved as HostRecord);
      if (entity?.kind === "core-instances" && !entity.value)
        onCoreCreated(saved as CoreInstance);
      if (entity?.kind === "managed-endpoints")
        onEndpointSaved(saved as ManagedEndpoint);
      onClose();
    },
  });
  const impact = useMutation({
    mutationFn: async (fields: Record<string, unknown>) => {
      const issue = scopeAtAction();
      if (issue) throw new Error(issue);
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
      if (!task || owner.current !== task || scopeAtAction()) return;
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
          if (stillCurrent() && owner.current === task && !scopeAtAction())
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
          onClosed?.();
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
            disabled={!!scopeIssue}
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
        submitErrorFocusOwner={entity}
        form={form}
        disabled={mutation.isPending || impact.isPending || confirming}
        onSubmitCapture={() => {
          submittedOwner.current = entity;
        }}
        onFinish={(v) => {
          const submitted = submittedOwner.current;
          submittedOwner.current = null;
          if (
            submitted !== entity ||
            !entity ||
            scopeAtAction() ||
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
        {scopeIssue && <Notice tone="warning" title="原配置范围已变更"><p>{scopeIssue}</p><p>填写内容仍保留。请先关闭此编辑，再从当前服务器重新打开。</p></Notice>}
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
