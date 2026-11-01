import { NumericInput } from "@/ui-patterns/numeric-input";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { DataTable } from "./DataTable";
import { Input } from "@/components/ui/input";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { toast } from "sonner";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { list, post } from "./api";
import { ErrorNotice, QueryState, Section } from "./components";
import { dateLabel, newID } from "./model";
import type { RouteRecord } from "./types";
interface Rate {
  id: string;
  routeId: string;
  micros: number;
  effectiveAt: string;
}
export function RateSettings({ routes }: { routes: RouteRecord[] }) {
  const query = useQuery({
    queryKey: ["rates"],
    queryFn: () => list<Rate>("/rates"),
  });
  const [open, setOpen] = useState(false);
  const [form] = useForm();
  const client = useQueryClient();
  const message = toast;
  const factor = useWatch("factor", form);
  const values = useWatch([], { form, preserve: true });
  const [baseline, setBaseline] = useState<Record<string, unknown> | null>(
    null,
  );
  const [editorKey, setEditorKey] = useState(0);
  const { confirm, confirming } = useDiscardConfirmation(`rate-${editorKey}`);
  const draft = values ?? form.getFieldsValue(true);
  const changed =
    open &&
    baseline !== null &&
    ["routeId", "factor", "effectiveAt"].some(
      (key) => draft[key] !== baseline[key],
    );
  const mutation = useMutation({
    mutationFn: (values: {
      routeId: string;
      factor: number;
      effectiveAt: string;
    }) =>
      post("/rates", {
        id: newID("rate"),
        routeId: values.routeId,
        micros: Math.round(values.factor * 1000000),
        effectiveAt: new Date(values.effectiveAt).toISOString(),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["rates"] });
      client.invalidateQueries({ queryKey: ["overview"] });
      setOpen(false);
      setBaseline(null);
      message.success("线路倍率版本已保存");
    },
  });
  useUnsavedChanges(open && (changed || mutation.isPending));
  const close = () => {
    if (mutation.isPending || confirming) return;
    const discard = () => {
      setOpen(false);
      setBaseline(null);
    };
    if (!changed) return discard();
    confirm(
      {
        title: "放弃未保存的倍率调整？",
        description: "当前线路、倍率与开始时间尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedPolicyModalControl },
      },
      discard,
    );
  };
  return (
    <Section
      title="线路扣量倍率"
      description="整条线路计算一次，不按中转跳数叠加。历史账期保留当时的倍率。"
      extra={
        <ActionButton
          onClick={() => {
            if (mutation.isPending || confirming) return;
            setEditorKey((key) => key + 1);
            form.resetFields();
            form.setFieldsValue({
              factor: 1,
              effectiveAt: new Date(
                Date.now() - new Date().getTimezoneOffset() * 60000,
              )
                .toISOString()
                .slice(0, 16),
            });
            setBaseline(form.getFieldsValue(true));
            mutation.reset();
            setOpen(true);
          }}
          variant="outline"
        >
          调整倍率
        </ActionButton>
      }
    >
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => query.refetch()}
      >
        <DataTable
          rowKey="id"
          rows={[...(query.data || [])].sort(
            (a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt),
          )}
          columns={[
            {
              title: "线路",
              render: (_, r) =>
                routes.find((route) => route.id === r.routeId)?.name ||
                r.routeId,
            },
            { title: "倍率", render: (_, r) => `${r.micros / 1000000}×` },
            {
              title: "生效时间（UTC+8）",
              render: (_, r) => dateLabel(r.effectiveAt, "UTC+8"),
            },
            {
              title: "",
              render: (_, r) =>
                Date.parse(r.effectiveAt) > Date.now() ? (
                  <Badge variant="secondary">待生效</Badge>
                ) : null,
            },
          ]}
          pageSize={6}
          empty={
            <span className="muted text-sm text-muted-foreground">
              未设置倍率版本的线路按 1× 扣量
            </span>
          }
        />
      </QueryState>
      <TaskDialog
        title="调整线路扣量倍率"
        pending={mutation.isPending}
        open={open}
        footer={null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        contentProps={{ onFocusCapture: revealFocusedPolicyModalControl }}
      >
        <AppForm
          form={form}
          disabled={mutation.isPending}
          onFinish={(values) => {
            if (!mutation.isPending && !confirming) mutation.mutate(values);
          }}
        >
          <ErrorNotice error={mutation.error} />
          <AppField
            name="routeId"
            label="线路"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={routes.map((r) => ({ value: r.id, label: r.name }))}
            />
          </AppField>
          <AppField
            name="factor"
            label="整条线路倍率（×）"
            rules={[
              { required: true },
              {
                type: "number",
                min: 0,
                max: 1000,
                message: "倍率范围为 0–1000",
              },
            ]}
            trigger="onValueChange"
          >
            <NumericInput min={0} max={1000} />
          </AppField>
          <p className="rounded-lg border bg-muted/50 p-3 text-sm">
            使用 1 GB 实际流量，扣除 {factor ?? 1} GB 额度。
          </p>
          <AppField
            name="effectiveAt"
            label="开始时间（本机时区）"
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </AppField>
          <p className="muted text-sm text-muted-foreground">
            保存后新增倍率版本，不可修改；已经归属的历史记录保持不变。
          </p>
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
              保存倍率版本
            </ActionButton>
          </div>
        </AppForm>
      </TaskDialog>
    </Section>
  );
}
