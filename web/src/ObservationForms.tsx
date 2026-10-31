import { FieldSet, FieldLegend } from "@/components/ui/field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { AppField, AppForm, useForm, useWatch } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { post, request } from "./api";
import { ErrorNotice } from "./components";
import { dateLabel, newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import {
  byteUnits,
  localDateInput,
  measuredBytes,
  observationPath,
  providerTimestamp,
  type NodeObservationView,
  type ObservationConfig,
} from "./observability-model";
import type { CoreInstance } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
const units = Object.keys(byteUnits).map((value) => ({ value, label: value }));
export function ObservationConfigForm({
  initial,
  instances,
  onClose,
}: {
  initial: NodeObservationView;
  instances: CoreInstance[];
  onClose: () => void;
}) {
  const [form] = useForm();
  const formId = useId();
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const providerEnabled =
    useWatch("providerEnabled", form) ?? !!initial.config.provider;
  const mode =
    useWatch(["provider", "mode"], form) ??
    initial.config.provider?.mode ??
    "limited";
  const explicitCycle =
    useWatch("providerCycleEnabled", form) ??
    !!initial.config.provider?.cycleId;
  const cycleEnabled = mode !== "unlimited" || explicitCycle;
  const client = useQueryClient(),
    message = toast;
  const { confirm: confirmDiscard } = useDiscardConfirmation(
    "ObservationForms-editor",
  );
  const close = () => {
    if (save.isPending) return;
    if (!dirty) return onClose();
    confirmDiscard(
      {
        title: "放弃未保存的采集与额度设置？",
        description: "当前输入尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  const save = useMutation({
    mutationFn: async () => {
      const values = form.getFieldsValue(true);
      const p = values.provider;
      if (values.providerEnabled && p.mode === "limited") {
        if (!Number.isSafeInteger(p.allowance) || p.allowance < 1)
          throw new Error("供应商额度请输入正整数，2.5 TB 可写为 2500 GB。");
        measuredBytes(String(p.allowance), p.unit);
      }
      const config: ObservationConfig = {
        revision: initial.config.revision,
        observerInstanceId: values.observerInstanceId || "",
        billedInterfaces: values.billedInterfaces || [],
        provider: values.providerEnabled
          ? {
              name: p.name,
              mode: p.mode,
              allowance: p.mode === "limited" ? p.allowance : 0,
              unit: p.unit,
              ...(p.mode !== "unlimited" || values.providerCycleEnabled
                ? {
                    cycleId: p.cycleId,
                    cycleStart: providerTimestamp(
                      p.cycleStart,
                      initial.config.provider?.cycleStart,
                    ),
                    cycleEnd: providerTimestamp(
                      p.cycleEnd,
                      initial.config.provider?.cycleEnd,
                    ),
                  }
                : {}),
              expiresAt: providerTimestamp(
                p.expiresAt,
                initial.config.provider?.expiresAt,
              ),
              notificationSource:
                p.mode === "unlimited" ? "none" : p.notificationSource,
              exhaustionAction: "advisory",
            }
          : null,
      };
      return request<NodeObservationView>(
        `${observationPath(initial.nodeId)}/config`,
        { method: "PUT", body: JSON.stringify(config) },
      );
    },
    onSuccess: (value) => {
      client.setQueryData(["node-observation", initial.nodeId], value);
      message.success("采集与额度设置已保存");
      setDirty(false);
      onClose();
    },
  });
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title="采集与供应商额度"
      open
      pending={save.isPending}
      footer={
        <div className="w-full space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            更换采集实例、计费网卡或周期会重建估算基线；更换周期会清除原周期的账单引用，不修改用户流量账单。
            {providerEnabled && "供应商用量单独记录，额度耗尽仅提醒，不自动更换线路。"}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton
              onClick={close}
              disabled={save.isPending}
              variant="outline"
            >
              取消
            </ActionButton>
            <ActionButton
              type="submit"
              form={formId}
              pending={save.isPending}
              variant="default"
            >
              保存采集与额度设置
            </ActionButton>
          </div>
        </div>
      }
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="lg"
    >
      <AppForm
        id={formId}
        form={form}
        disabled={save.isPending}
        onValuesChange={() => setDirty(true)}
        onFinish={() => {
          if (!save.isPending) save.mutate();
        }}
        initialValues={{
          ...initial.config,
          observerInstanceId: initial.config.observerInstanceId || undefined,
          providerEnabled: !!initial.config.provider,
          providerCycleEnabled: !!initial.config.provider?.cycleId,
          provider: {
            name: "",
            mode: "limited",
            unit: "GB",
            notificationSource: "none",
            ...initial.config.provider,
            cycleId:
              initial.config.provider?.cycleId || newID("provider-cycle"),
            cycleStart: localDateInput(initial.config.provider?.cycleStart),
            cycleEnd: localDateInput(initial.config.provider?.cycleEnd),
            expiresAt: localDateInput(initial.config.provider?.expiresAt),
          },
        }}
      >
        <ErrorNotice error={save.error} />
        <FieldSet className="min-w-0">
          <FieldLegend variant="label">主机采集</FieldLegend>
          <AppField
            name="observerInstanceId"
            label="主机采集实例"
            description="一台服务器只选一个采集实例。节点 Agent 需显式启用主机采集；保存选择不会自动执行远程命令。"
            trigger="onValueChange"
          >
            <ChoiceSelect
              clearable
              placeholder="选择这台服务器上的一个实例"
              options={instances.map((i) => ({
                value: i.id,
                label: i.name || `${i.adapterId} · ${i.id}`,
              }))}
            />
          </AppField>
          <AppField
            name="billedInterfaces"
            label="供应商计费网卡"
            description="只选择供应商统计的物理或公网网卡，不选择回环、容器或重复转发接口。"
            trigger="onValueChange"
          >
            <MultiChoice
              placeholder="选择或输入实际网卡名称"
              options={(initial.latest?.metrics.interfaces || []).map((i) => ({
                value: i.name,
                label: i.name,
              }))}
              creatable
            />
          </AppField>
        </FieldSet>
        <FieldSet className="min-w-0 border-t pt-4">
          <FieldLegend variant="label">供应商额度</FieldLegend>
          <AppField
            name="providerEnabled"
            label="记录供应商额度"
            trigger="onCheckedChange"
            valuePropName="checked"
          >
            <Switch />
          </AppField>
          {providerEnabled && (
            <>
              <AppField
                name={["provider", "name"]}
                label="供应商或服务名称"
                rules={[{ required: true }]}
              >
                <Input placeholder="例如：FRA VPS 月度流量" maxLength={160} />
              </AppField>
              <AppField
                name={["provider", "mode"]}
                label="额度类型"
                trigger="onValueChange"
              >
                <ChoiceSelect
                  options={[
                    { value: "limited", label: "有额度限制" },
                    { value: "unlimited", label: "不限量" },
                  ]}
                />
              </AppField>
              {mode !== "unlimited" && (
                <div className="form-grid grid gap-4 sm:grid-cols-2">
                  <AppField
                    name={["provider", "allowance"]}
                    label="周期额度"
                    rules={[{ required: true }]}
                    getValueFromEvent={(
                      event: React.ChangeEvent<HTMLInputElement>,
                    ) =>
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value)
                    }
                  >
                    <Input
                      min={1}
                      max={Number.MAX_SAFE_INTEGER}
                      type="number"
                    />
                  </AppField>
                  <AppField
                    name={["provider", "unit"]}
                    label="额度单位"
                    rules={[{ required: true }]}
                    trigger="onValueChange"
                  >
                    <ChoiceSelect options={units} />
                  </AppField>
                </div>
              )}
              {mode === "unlimited" && (
                <AppField
                  name="providerCycleEnabled"
                  trigger="onCheckedChange"
                  valuePropName="checked"
                  label={<>仍按明确周期记录用量（可选）</>}
                >
                  <Checkbox />
                </AppField>
              )}
              <div className="form-grid grid gap-4 sm:grid-cols-2">
                {cycleEnabled && (
                  <>
                    <AppField
                      name={["provider", "cycleStart"]}
                      label="周期开始（浏览器当地时间）"
                      rules={[{ required: true }]}
                    >
                      <Input type="datetime-local" />
                    </AppField>
                    <AppField
                      name={["provider", "cycleEnd"]}
                      label="周期结束（浏览器当地时间）"
                      dependencies={[["provider", "cycleStart"]]}
                      rules={[
                        { required: true },
                        ({ getFieldValue }) => ({
                          validator: (_, value) =>
                            !value ||
                            Date.parse(value) >
                              Date.parse(
                                getFieldValue(["provider", "cycleStart"]),
                              )
                              ? Promise.resolve()
                              : Promise.reject(
                                  new Error("结束时间必须晚于开始时间"),
                                ),
                        }),
                      ]}
                    >
                      <Input type="datetime-local" />
                    </AppField>
                  </>
                )}
                <AppField
                  name={["provider", "expiresAt"]}
                  label="服务到期时间（可选）"
                >
                  <Input type="datetime-local" />
                </AppField>
                {mode !== "unlimited" && (
                  <AppField
                    name={["provider", "notificationSource"]}
                    label="供应商额度提醒依据"
                    trigger="onValueChange"
                  >
                    <ChoiceSelect
                      options={[
                        { value: "none", label: "不提醒" },
                        {
                          value: "provider_statement",
                          label: "供应商账单用量",
                        },
                        {
                          value: "nic_estimate",
                          label: "核对后的网卡 IN + OUT 估算",
                        },
                      ]}
                    />
                  </AppField>
                )}
              </div>
              <Accordion type="multiple" defaultValue={[]} className="w-full">
                {[
                  {
                    key: "cycle",
                    label:
                      "\u5468\u671F\u6807\u8BC6\u4E0E\u8BA1\u91CF\u8BF4\u660E",
                    children: (
                      <>
                        {cycleEnabled && (
                          <AppField
                            name={["provider", "cycleId"]}
                            label="周期标识"
                            rules={[{ required: true }]}
                          >
                            <Input />
                          </AppField>
                        )}
                        <p className="muted text-sm text-muted-foreground">
                          GB / TB 使用十进制，GiB / TiB 使用二进制。
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
            </>
          )}
        </FieldSet>
      </AppForm>
    </TaskDialog>
  );
}
export function ProviderMeasurementForm({
  initial,
  kind,
  onClose,
}: {
  initial: NodeObservationView;
  kind: "statement" | "baseline";
  onClose: () => void;
}) {
  const [form] = useForm();
  const [snapshot, setSnapshot] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const client = useQueryClient(),
    message = toast;
  const baseline = kind === "baseline";
  const { confirm: confirmDiscard } = useDiscardConfirmation(
    "ObservationForms-editor",
  );
  const close = () => {
    if (save.isPending) return;
    if (!dirty) return onClose();
    confirmDiscard(
      {
        title: "放弃未保存的用量输入？",
        description: "当前输入尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => onClose(),
    );
  };
  const refresh = useMutation({
    mutationFn: () =>
      request<NodeObservationView>(observationPath(initial.nodeId)),
    onSuccess: (value) => {
      if (value.config.provider?.cycleId !== initial.config.provider?.cycleId) {
        message.error("供应商周期已变更，请重新检查周期后核对。");
        return;
      }
      setSnapshot(value);
      setConfirmed(false);
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      const values = form.getFieldsValue(true);
      const usedBytes = measuredBytes(values.amount || "", values.unit);
      const cycleId = initial.config.provider!.cycleId;
      if (baseline && !confirmed)
        throw new Error("请确认用量已与当前采样时点核对。");
      const body = baseline
        ? {
            cycleId,
            usedBytes,
            reportDigest: snapshot.latest?.digest,
            reason: values.reason,
          }
        : {
            cycleId,
            usedBytes,
            observedAt: new Date(values.observedAt).toISOString(),
            reference: values.reference,
          };
      return post<NodeObservationView>(
        `${observationPath(initial.nodeId)}/${baseline ? "baseline" : "provider-statement"}`,
        body,
      );
    },
    onSuccess: (value) => {
      client.setQueryData(["node-observation", initial.nodeId], value);
      message.success(
        baseline ? "本周期网卡估算基线已核对" : "供应商用量记录已保存",
      );
      setDirty(false);
      onClose();
    },
  });
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      title={baseline ? "核对网卡估算基线" : "录入供应商用量"}
      open
      pending={save.isPending}
      footer={null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="lg"
    >
      <p>
        {initial.config.provider!.name} ·{" "}
        {dateLabel(initial.config.provider!.cycleStart)} 至{" "}
        {dateLabel(initial.config.provider!.cycleEnd)}
      </p>
      <AppForm
        form={form}
        disabled={save.isPending}
        onValuesChange={() => {
          setDirty(true);
          setConfirmed(false);
        }}
        onFinish={() => save.mutate()}
        initialValues={{ unit: "GB" }}
      >
        <ErrorNotice error={save.error || refresh.error} />
        {baseline && (
          <Notice tone="info" title="以实际已知用量建立估算起点">
            {
              <>
                <p>
                  将输入的本周期已用与 {dateLabel(snapshot.latest?.observedAt)}{" "}
                  的网卡计数对齐。之后只累加连续采样，不推测接入前或缺失期间的流量。
                </p>
                <ActionButton
                  pending={refresh.isPending}
                  onClick={() => refresh.mutate()}
                  variant="outline"
                >
                  读取最新采样用于核对
                </ActionButton>
              </>
            }
          </Notice>
        )}
        <div className="form-grid grid gap-4 sm:grid-cols-2">
          <AppField
            name="amount"
            label="本周期实际已用"
            rules={[{ required: true, message: "请输入已核对的实际用量" }]}
          >
            <Input inputMode="decimal" placeholder="不自动填入网卡增量或额度" />
          </AppField>
          <AppField
            name="unit"
            label="用量单位"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect options={units} />
          </AppField>
        </div>
        {baseline ? (
          <AppField
            name="reason"
            label="核对依据与说明"
            rules={[{ required: true }]}
          >
            <Textarea
              rows={3}
              placeholder="说明用量来源及如何与本次采样时点对齐"
              maxLength={1000}
            />
          </AppField>
        ) : (
          <>
            <AppField
              name="observedAt"
              label="供应商用量的统计时间（浏览器当地时间）"
              rules={[{ required: true }]}
            >
              <Input type="datetime-local" />
            </AppField>
            <AppField
              name="reference"
              label="账单或控制台记录引用"
              rules={[{ required: true }]}
            >
              <Input
                placeholder="例如：供应商控制台本周期流量记录"
                maxLength={500}
              />
            </AppField>
          </>
        )}
        {baseline && (
          <label className="flex items-start gap-2 text-sm leading-relaxed">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) =>
                ((e) => setConfirmed(e.target.checked))({
                  target: { checked: checked === true },
                })
              }
            />
            已将输入用量与显示的采样时点核对，了解此结果仍是网卡估算。
          </label>
        )}
        <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4 mt-6">
          <ActionButton onClick={close} variant="outline">
            取消
          </ActionButton>
          <ActionButton
            type="submit"
            pending={save.isPending}
            disabled={
              baseline && (!confirmed || refresh.isPending || !snapshot.latest)
            }
            variant="default"
          >
            保存核对结果
          </ActionButton>
        </div>
      </AppForm>
    </TaskDialog>
  );
}
