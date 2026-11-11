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
import { useEffect, useRef, useState } from "react";
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
class UnverifiedRateReceipt extends Error {}
// Keep decimal intent until it is proven to be an integer number of micros.
// The existing API contract is 0–1000×, with 1,000,000 micros per unit.
function rateMicros(raw: string): number {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new Error("请输入有效倍率");
  const fraction = match[3] ?? match[4] ?? "";
  const digits = ((match[2] ?? "") + fraction).replace(/^0+/, "");
  if (!digits) return 0;
  if (match[1] === "-") throw new Error("倍率范围为 0–1000");
  const significant = digits.replace(/0+$/, "");
  const shift = Number(match[5] ?? 0) - fraction.length + 6 + digits.length - significant.length;
  if (shift < 0) {
    throw new Error("倍率须为 0.000001 的整数倍，请调整后保存");
  }
  // Bound expansion before constructing or converting the integer. Huge
  // exponents cannot allocate huge strings or silently underflow to zero.
  if (!Number.isSafeInteger(shift) || significant.length + shift > 10) {
    throw new Error("倍率范围为 0–1000");
  }
  const micros = Number(significant + "0".repeat(shift));
  if (micros > 1_000_000_000) throw new Error("倍率范围为 0–1000");
  return micros;
}

export function RateSettings({ routes }: { routes: RouteRecord[] }) {
  const [savedRates, setSavedRates] = useState<Rate[]>([]);
  const query = useQuery({
    queryKey: ["rates"],
    queryFn: () => list<Rate>("/rates"),
  });
  // Versions are immutable. An independent list read cannot undo a matching
  // committed receipt, even when that read fails or omits the new version.
  const rates = [...(query.data || [])];
  for (const saved of savedRates) {
    if (!rates.some((rate) => rate.id === saved.id)) rates.push(saved);
  }
  const [boundaryRevision, setBoundaryRevision] = useState(0);
  const renderedAt = Date.now();
  const nextBoundary = rates.reduce((nearest, rate) => {
    const at = Date.parse(rate.effectiveAt);
    return Number.isFinite(at) && at > renderedAt ? Math.min(nearest, at) : nearest;
  }, Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextBoundary)) return;
    // Select from the same clock snapshot as the labels. If a boundary passes
    // before this effect, queue an immediate refresh rather than dropping it.
    // This only refreshes local labels, without observing backend enforcement.
    const timer = setTimeout(() => setBoundaryRevision((value) => value + 1),
      Math.min(Math.max(0, nextBoundary - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [nextBoundary, boundaryRevision]);
  const [open, setOpen] = useState(false);
  const [form] = useForm();
  const client = useQueryClient();
  const message = toast;
  const factorText = useRef("1");
  const [factor, setFactor] = useState("1");
  let exampleFactor: number | null = null;
  try {
    exampleFactor = rateMicros(factor) / 1_000_000;
  } catch {
    // Invalid drafts have no billable example; field validation gives the reason.
  }
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
    (factor !== String(baseline.factor) ||
      ["routeId", "factor", "effectiveAt"].some(
        (key) => draft[key] !== baseline[key],
      ));
  const mutation = useMutation({
    mutationFn: async (values: {
      routeId: string;
      factor: string;
      effectiveAt: string;
    }) => {
      const submitted: Rate = {
        id: newID("rate"),
        routeId: values.routeId,
        micros: rateMicros(values.factor),
        effectiveAt: new Date(values.effectiveAt).toISOString(),
      };
      const saved = await post<Rate>("/rates", submitted);
      if (!saved || saved.id !== submitted.id || saved.routeId !== submitted.routeId ||
        saved.micros !== submitted.micros ||
        Date.parse(saved.effectiveAt) !== Date.parse(submitted.effectiveAt)) {
        throw new UnverifiedRateReceipt("保存结果无法核对，请检查倍率记录，避免重复保存。");
      }
      return saved;
    },
    onSuccess: (saved) => {
      setSavedRates((current) => [...current.filter((rate) => rate.id !== saved.id), saved]);
      client.invalidateQueries({ queryKey: ["rates"] });
      client.invalidateQueries({ queryKey: ["overview"] });
      setOpen(false);
      setBaseline(null);
      message.success("线路倍率版本已保存");
    },
  });
  const needsReceiptCheck = mutation.error instanceof UnverifiedRateReceipt;
  useUnsavedChanges(
    open && (changed || mutation.isPending || needsReceiptCheck),
    needsReceiptCheck
      ? "倍率保存结果尚未核对。离开不会撤销已提交的保存，请返回倍率记录核对，避免重复保存。"
      : undefined,
  );
  const close = () => {
    if (mutation.isPending || confirming) return;
    const discard = () => {
      setOpen(false);
      setBaseline(null);
    };
    if (needsReceiptCheck) {
      void query.refetch();
      return discard();
    }
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
      description="整条线路统一计算一次倍率。历史账期沿用当时的倍率。"
      extra={
        <ActionButton
          onClick={() => {
            if (mutation.isPending || confirming) return;
            setEditorKey((key) => key + 1);
            form.resetFields();
            factorText.current = "1";
            setFactor("1");
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
      {query.error && rates.length > 0 && (
        <QueryState error={query.error} retry={() => query.refetch()}>{null}</QueryState>
      )}
      <QueryState
        loading={query.isPending && rates.length === 0} paused={query.isPaused} loadingLayout="table"
        error={rates.length === 0 ? query.error : null}
        retry={() => query.refetch()}
      >
        <DataTable
          rowKey="id"
          rows={[...rates].sort(
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
              title: "状态",
              render: (_, r) =>
                Date.parse(r.effectiveAt) > renderedAt ? (
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
            if (!mutation.isPending && !confirming && !needsReceiptCheck) {
              mutation.mutate({ ...values, factor: factorText.current });
            }
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
                validator: async () => {
                  if (factorText.current) rateMicros(factorText.current);
                },
              },
            ]}
            trigger="onValueChange"
            validateTrigger="onInputText"
          >
            <NumericInput
              min={0}
              max={1000}
              onInputText={(raw) => {
                factorText.current = raw;
                setFactor(raw);
              }}
            />
          </AppField>
          <p className="rounded-lg border bg-muted/50 p-3 text-sm">
            {exampleFactor === null
              ? "请填写有效倍率后查看扣量示例。"
              : `使用 1 GB 实际流量，扣除 ${exampleFactor} GB 额度。`}
          </p>
          <AppField
            name="effectiveAt"
            label="开始时间（本机时区）"
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </AppField>
          <p className="muted text-sm text-muted-foreground">
            每次保存创建独立倍率版本，保存后锁定；历史记录沿用原版本。
          </p>
          <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <ActionButton
              disabled={mutation.isPending}
              onClick={close}
              variant="outline"
            >
              {needsReceiptCheck ? "关闭并检查记录" : "取消"}
            </ActionButton>
            <ActionButton
              type="submit"
              disabled={needsReceiptCheck}
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
