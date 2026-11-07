import { useConfirm } from "@/ui-patterns/confirmations";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { toast } from "sonner";
import { Plus, Search } from "lucide-react";
import { invalidateOutputInputs } from "./output-comparison";
import { DataTable, TableRowActions } from "./DataTable";
import { ruleResourceReference } from "./rule-file-model";
import { RuleFileImport } from "./RuleFileImport";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
import { useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, list, post, request, saveRecord } from "./api";
import type { RuleResource } from "./types";
import { bytesLabel, newID } from "./model";
import {
  EmptyState,
  ErrorNotice,
  type ErrorNoticeFocusHandle,
  PageHeader,
  QueryState,
  Section,
} from "./components";
interface Inspection {
  digest: string;
  format: "mihomo-yaml" | "sing-box-source";
  formatVersion: number;
  bytes: number;
  entries: number;
  inspection: string;
  nativeChecked: false;
}
function validInspection(value: unknown, format: unknown): value is Inspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<Inspection>;
  // Match the inspect endpoint's source format and bounded envelope contract
  // before either rendering its summary or replacing the user's trusted input.
  return (
    (format === "mihomo-yaml" || format === "sing-box-source") &&
    result.format === format &&
    typeof result.digest === "string" &&
    [64, 71].includes(result.digest.length) &&
    /^(sha256:)?[a-fA-F0-9]{64}$/.test(result.digest) &&
    typeof result.formatVersion === "number" &&
    Number.isSafeInteger(result.formatVersion) &&
    (format === "sing-box-source"
      ? result.formatVersion >= 1 && result.formatVersion <= 5
      : result.formatVersion === 0) &&
    typeof result.bytes === "number" &&
    Number.isSafeInteger(result.bytes) &&
    result.bytes > 0 && result.bytes <= 8 * 1024 * 1024 &&
    typeof result.entries === "number" &&
    Number.isSafeInteger(result.entries) &&
    result.entries >= 0 && result.entries <= 100000 &&
    typeof result.inspection === "string" && result.inspection.trim() !== "" &&
    result.nativeChecked === false
  );
}
type ResourceDraft = Omit<RuleResource, "intervalSeconds" | "formatVersion"> & {
  intervalSeconds?: number | string;
  formatVersion?: number | string;
};
// Check decimal text before Number conversion: a fractional tail must not round
// into an integer. Bounds are the existing resource editor bounds.
function resourceInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
  if (typeof value !== "string" || value.length > 1024) return undefined;
  const match = /^[+-]?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || match[0] !== value || value.startsWith("-")) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  let digits = ((match[1] ?? "") + fraction).replace(/^0+/, "");
  if (!digits) return undefined;
  const exponentText = (match[4] ?? "0").replace(/^[+-]?0*/, "");
  if (exponentText.length > 4) return undefined;
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 1024) return undefined;
  const shift = exponent - fraction.length;
  if (!Number.isSafeInteger(shift)) return undefined;
  if (shift < 0) {
    const cut = digits.length + shift;
    if (cut <= 0 || /[^0]/.test(digits.slice(cut))) return undefined;
    digits = digits.slice(0, cut);
  } else {
    if (digits.length + shift > String(max).length) return undefined;
    digits += "0".repeat(shift);
  }
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}
function ResourceIntegerInput({ value, onValueChange, min, max, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "min" | "max"> & {
  value?: number | string;
  onValueChange?: (raw: string) => void;
  min: number;
  max: number;
}) {
  // Arrow keys are an explicit normalization action, unlike submission. Keep
  // NumericInput's finite numeric stepping even for fractional/out-of-range
  // edits, and start incomplete text at zero before clamping to the bounds.
  const text = String(value ?? "");
  const numeric = text.length <= 1024 && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
    ? Number(text)
    : undefined;
  const stepValue = Number.isFinite(numeric) ? numeric : undefined;
  return (
    <Input
      {...props}
      type="text"
      role="spinbutton"
      inputMode="numeric"
      value={value ?? ""}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={stepValue}
      onChange={(event) => onValueChange?.(event.target.value)}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented || props.disabled || props.readOnly || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        onValueChange?.(String(Math.max(min, Math.min(max, (stepValue ?? 0) + (event.key === "ArrowUp" ? 1 : -1)))));
      }}
    />
  );
}
const integerRule = (min: number, max: number) => ({
  validator: (_rule: unknown, value: unknown) =>
    resourceInteger(value, min, max) === undefined
      ? Promise.reject(new Error(`请输入 ${min} 到 ${max} 之间的整数`))
      : Promise.resolve(),
});
// Empty optional controls and absent initial values paint the same draft.
const draftSnapshot = (values: object) =>
  JSON.stringify(
    Object.entries(values)
      .filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
export function ResourcesPage() {
  const formId = useId();
  const refreshFailureId = (resource: RuleResource) =>
    resource.acceptedVersion && resource.refreshStatus === "failed"
      ? `${formId}-refresh-${encodeURIComponent(resource.id)}`
      : undefined;
  const confirmRefresh = useConfirm();
  const [refreshDecisionOpen, setRefreshDecisionOpen] = useState(false);
  const client = useQueryClient();
  const message = toast;
  const query = useQuery({
    queryKey: ["resources"],
    queryFn: () => list<RuleResource>("/me/resources"),
  });
  const [current, setCurrent] = useState<RuleResource | null>(null);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState<{
    identity: string;
    initial?: RuleResource;
  } | null>(null);
  const startImport = (initial?: RuleResource) =>
    setImporting({ identity: newID("resource-task"), initial });
  const refresh = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    mutationFn: (id: string) => post(`/me/resources/${id}/refresh`),
    onSettled: () => {
      invalidateOutputInputs(client);
      client.invalidateQueries({ queryKey: ["resources"] });
    },
    onSuccess: () => message.success("已重新读取并接纳规则文件"),
  });
  const [form] = useForm<ResourceDraft>();
  const values = useWatch([], { form, preserve: true });
  const [baseline, setBaseline] = useState("");
  const [editorIdentity, setEditorIdentity] = useState("closed");
  const editorTask = useRef<object | null>(null);
  const submitting = useRef<object | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDivElement>(null);
  const errorFocus = useRef<ErrorNoticeFocusHandle>(null);
  const failureFocus = useRef<{ error: Error; task: object; focusOwner: Element | null } | null>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      editorTask.current = null;
      inspectionRequest.current?.abort();
      inspectionRequest.current = null;
    };
  }, []);
  const changed =
    open && baseline !== "" && draftSnapshot(values || {}) !== baseline;
  const { confirm, confirming } = useDiscardConfirmation(editorIdentity);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const inspectionRequest = useRef<AbortController | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState<Error | null>(null);
  const cancelInspection = () => {
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
    setInspecting(false);
    setInspectionError(null);
  };
  const location = useWatch("location", form);
  const format = useWatch("format", form);
  const mutation = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: (_saved, _error, { task }) => {
      if (submitting.current === task) submitting.current = null;
      invalidateOutputInputs(client);
    },
    mutationFn: ({
      value,
      isNew,
    }: {
      value: RuleResource;
      isNew: boolean;
      task: object;
    }) => saveRecord("me/resources", value, isNew),
    onError: (error, { task }) => {
      if (active.current && editorTask.current === task)
        failureFocus.current = { error, task, focusOwner: submitButton.current };
    },
    onSuccess: (_saved, { task }) => {
      client.invalidateQueries({ queryKey: ["resources"] });
      if (!active.current || editorTask.current !== task) return;
      editorTask.current = null;
      setOpen(false);
      setBaseline("");
      setEditorIdentity("closed");
      message.success("规则资源已保存");
    },
  });
  useLayoutEffect(() => {
    const failure = failureFocus.current;
    if (!failure || mutation.isPending || inspecting) return;
    failureFocus.current = null;
    if (!active.current || !open || editorTask.current !== failure.task ||
        failure.error !== (mutation.error || inspectionError) ||
        (failure.error instanceof APIError && [401, 403].includes(failure.error.status))) return;
    const dialog = submitButton.current?.closest('[role="dialog"]');
    if (!document.hasFocus() || document.visibilityState !== "visible" ||
        document.activeElement !== failure.focusOwner ||
        !dialog || document.activeElement?.closest('[role="dialog"],[role="alertdialog"]') !== dialog) return;
    errorFocus.current?.focus();
  }, [mutation.error, mutation.isPending, inspectionError, inspecting, open]);
  useUnsavedChanges(changed || (open && mutation.isPending));
  const inspect = async () => {
    const task = editorTask.current;
    if (!active.current || !task || inspectionRequest.current || submitting.current) return;
    const controller = new AbortController();
    const focusOwner = document.activeElement;
    inspectionRequest.current = controller;
    setInspecting(true);
    setInspectionError(null);
    setInspection(null);
    const source = { url: form.getFieldValue("url"), format: form.getFieldValue("format") };
    const ownsRequest = () => active.current && editorTask.current === task && inspectionRequest.current === controller;
    try {
      await form.validateFields(["url", "format"]);
      if (!ownsRequest()) return;
      const value = await request<unknown>("/me/resources/inspect", {
        method: "POST",
        body: JSON.stringify(source),
        signal: controller.signal,
      });
      if (!ownsRequest()) return;
      if (!validInspection(value, source.format))
        throw new Error("无法确认规则文件检查结果。原有输入已保留，请重新读取文件。");
      setInspection(value);
      form.setFieldsValue({ digest: value.digest, formatVersion: value.formatVersion });
    } catch (error) {
      // Form validation already reports field errors. Only the current request
      // may report a transport failure, even if a transport ignores abort.
      if (ownsRequest() && error instanceof Error) {
        failureFocus.current = { error, task, focusOwner };
        setInspectionError(error);
      }
    } finally {
      if (ownsRequest()) {
        inspectionRequest.current = null;
        setInspecting(false);
      }
    }
  };
  const edit = (resource?: RuleResource) => {
    if (resource?.acceptedVersion || resource?.location === "local") {
      startImport(resource);
      return;
    }
    editorTask.current = {};
    setEditorIdentity(newID("resource-task"));
    cancelInspection();
    setCurrent(resource || null);
    form.resetFields();
    form.setFieldsValue(
      resource || {
        id: newID("resource"),
        format: "mihomo-yaml",
        behavior: "domain",
        location: "remote",
        visibility: "public",
        updatePolicy: "follow",
        revision: "1",
        intervalSeconds: 86400,
      },
    );
    setBaseline(draftSnapshot(form.getFieldsValue(true)));
    setInspection(null);
    mutation.reset();
    setOpen(true);
  };
  const close = () => {
    if (submitting.current || mutation.isPending || confirming) return;
    const task = editorTask.current;
    const finish = () => {
      if (!active.current || !task || editorTask.current !== task) return;
      cancelInspection();
      editorTask.current = null;
      setOpen(false);
      setBaseline("");
      setEditorIdentity("closed");
    };
    if (!changed) return finish();
    confirm(
      {
        title: "放弃未保存的规则资源修改？",
        description: "当前填写的公开引用尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedModalAction },
      },
      finish,
    );
  };
  return (
    <>
      <PageHeader
        title="规则资源"
        action={
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton onClick={() => edit()} variant="outline">
              添加公开引用
            </ActionButton>
            <ActionButton
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => startImport()}
              variant="default"
            >
              导入规则文件
            </ActionButton>
          </div>
        }
      />
      <ErrorNotice error={refreshDecisionOpen ? null : refresh.error} />
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section variant="plain">
          {!query.data?.length ? (
            <EmptyState title="暂无规则资源" />
          ) : (
            <DataTable
              rowKey="id"
              rows={query.data}
              className="[&_tbody_td]:align-top"
              columns={[
                {
                  title: "资源",
                  render: (_, r) => (
                    <button
                      className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => edit(r)}
                    >
                      {r.name || r.id}
                    </button>
                  ),
                },
                { title: "格式", accessor: "format" },
                {
                  title: "更新",
                  render: (_, r) =>
                    r.updatePolicy === "pinned" ? "固定版本" : "跟随更新",
                },
                {
                  title: "文件交付",
                  className: "min-w-56",
                  render: (_, r) =>
                    r.acceptedVersion ? (
                      <div className="max-w-80 whitespace-normal wrap-anywhere">
                        <Badge variant="secondary">随配置打包</Badge>
                        <small className="ml-2 text-xs text-muted-foreground">
                          {bytesLabel(r.sizeBytes)}
                        </small>
                        {r.refreshStatus === "failed" && (
                          <p
                            id={refreshFailureId(r)}
                            className="mt-1.5 text-destructive"
                          >
                            <span className="font-medium">刷新失败</span>
                            ，保留已接纳文件。新发布前请重试或替换。
                          </p>
                        )}
                      </div>
                    ) : (
                      <Badge variant="secondary">公开远程引用</Badge>
                    ),
                },
                {
                  title: "可见性",
                  render: (_, r) => (
                    <Badge variant="secondary">
                      {r.visibility === "public" ? "公开文件" : "私有"}
                    </Badge>
                  ),
                },
                {
                  title: "操作",
                  align: "right",
                  render: (_, r) => (
                    <TableRowActions name={r.name || r.id}>
                      {refreshFailureId(r) && (
                        <span
                          aria-hidden="true"
                          className="hidden basis-full text-right text-xs font-medium text-destructive group-data-[overflow=true]/table:block"
                        >
                          刷新失败
                        </span>
                      )}
                      <ActionButton
                        onClick={() => edit(r)}
                        variant="outline"
                        aria-describedby={refreshFailureId(r)}
                      >
                        {r.acceptedVersion ? "替换文件" : "编辑"}
                      </ActionButton>
                      {r.canRefresh && (
                        <ActionButton
                          aria-describedby={refreshFailureId(r)}
                          variant="outline"
                          pending={
                            !!(refresh.isPending && refresh.variables === r.id)
                          }
                          onClick={() => {
                            setRefreshDecisionOpen(true);
                            confirmRefresh({
                              title: `重新读取并接纳「${r.name || r.id}」的远程规则文件？`,
                              description:
                                "固定版本会核对原校验值；失败保留原文件，并阻止基于失败刷新状态的新发布。已发布配置包不改变。",
                              confirmLabel: "读取并接纳",
                              cancelLabel: "取消",
                              onConfirm: () => refresh.mutateAsync(r.id),
                              onClosed: () => setRefreshDecisionOpen(false),
                            });
                          }}
                        >
                          刷新文件
                        </ActionButton>
                      )}
                    </TableRowActions>
                  ),
                },
              ]}
              minWidth={{ x: 650 }.x}
            />
          )}
        </Section>
      </QueryState>
      {importing && (
        <RuleFileImport
          key={importing.identity}
          initial={importing.initial}
          onClose={() =>
            setImporting((current) => (current === importing ? null : current))
          }
        />
      )}
      <TaskDialog
        title={current ? "编辑公开规则引用" : "添加公开规则引用"}
        open={open}
        footer={
          <div className="space-y-3">
            <p id={`${formId}-delivery-disclosure`} className="text-sm text-muted-foreground">
              远程文件随配置交付时，客户端会直接访问此地址。只有明确公开的规则文件可用于这种方式。
            </p>
            <div className="form-footer flex flex-wrap items-center justify-end gap-2">
              <ActionButton
                onClick={close}
                disabled={mutation.isPending || !open}
                variant="outline"
              >
                取消
              </ActionButton>
              <ActionButton
                ref={submitButton}
                keepFocusableWhilePending
                type="submit"
                form={formId}
                disabled={!open || inspecting}
                aria-label="保存公开引用"
                aria-describedby={`${formId}-delivery-disclosure`}
                aria-busy={mutation.isPending}
                variant="default"
                pending={!!mutation.isPending}
              >
                保存公开引用
              </ActionButton>
            </div>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
        pending={mutation.isPending}
        size="lg"
      >
        <AppForm
          className="space-y-5"
          form={form}
          id={formId}
          name={formId}
          disabled={mutation.isPending}
          onTransitionEnd={(event) => {
            // An expansion already in flight can move the busy action after native focus.
            // Reveal only that same focus owner; never choose focus after submission.
            const submit = submitButton.current;
            const panel = event.target;
            if (
              !active.current ||
              !open ||
              !(
                editorTask.current &&
                (mutation.isPending
                  ? submitting.current === editorTask.current
                  : mutation.isError &&
                    mutation.variables?.task === editorTask.current)
              ) ||
              event.propertyName !== "height" ||
              !(panel instanceof HTMLElement) ||
              !panel.matches('[data-slot="accordion-content"]') ||
              panel.closest('[data-slot="accordion"]') !== disclosure.current ||
              !event.currentTarget.contains(panel) ||
              !submit ||
              submit.form !== event.currentTarget ||
              document.activeElement !== submit
            )
              return;
            const wrap = submit.closest<HTMLDivElement>("[data-task-overlay]");
            if (wrap)
              revealFocusedModalAction({ currentTarget: wrap, target: submit });
          }}
          onFinish={(v) => {
            const task = editorTask.current;
            if (
              !active.current ||
              !open ||
              !task ||
              submitting.current ||
              mutation.isPending ||
              confirming ||
              inspectionRequest.current
            )
              return;
            const intervalSeconds = resourceInteger(v.intervalSeconds, 60, 2592000);
            const formatVersion = resourceInteger(v.formatVersion, 1, 5);
            const needsVersion = v.format.startsWith("sing-box") || v.format === "srs";
            // Never turn invalid numeric intent into an omitted/defaulted payload.
            if ((v.location === "remote" && intervalSeconds === undefined) || (needsVersion && formatVersion === undefined)) return;
            const value = ruleResourceReference({
              ...current,
              ...v,
              id: current?.id || v.id || form.getFieldValue("id"),
              url: v.location === "remote" ? v.url : undefined,
              path: v.location === "local" ? v.path : undefined,
              intervalSeconds:
                v.location === "remote" ? intervalSeconds : undefined,
              formatVersion: needsVersion ? formatVersion : undefined,
            });
            submitting.current = task;
            const submit = submitButton.current;
            if (
              submit?.form?.contains(document.activeElement) &&
              !submit.closest('[inert], [aria-hidden="true"]')
            )
              submit.focus();
            mutation.mutate({
              value: structuredClone(value),
              isNew: !current,
              task,
            });
          }}
          onValuesChange={(changed) => {
            if (["url", "format", "location", "digest", "formatVersion"].some((field) => field in changed)) {
              cancelInspection();
              setInspection(null);
            }
            if ("url" in changed || "format" in changed || "location" in changed) {
              form.setFieldsValue({ digest: "" });
            }
          }}
        >
          {/* Keep a form-local default submit for implicit Enter; the visible
              footer action is associated with this same native form. */}
          <button
            type="submit"
            hidden
            tabIndex={-1}
            aria-hidden="true"
            disabled={mutation.isPending || inspecting || !open}
          />
          <ErrorNotice error={mutation.error || inspectionError} focusRef={errorFocus} />
          <AppField
            name="name"
            label="资源名称"
            rules={[{ required: true, message: "给规则资源起一个名称" }]}
          >
            <Input placeholder="例如：常用网站规则" />
          </AppField>
          <AppField name="location" label="文件位置" trigger="onValueChange">
            <ChoiceSelect
              options={[{ value: "remote", label: "远程 HTTPS 文件" }]}
              onValueChange={(value) => {
                if (value === undefined) return;
                form.setFieldsValue({
                  updatePolicy: value === "remote" ? "follow" : "pinned",
                  url: undefined,
                  path: undefined,
                  digest: "",
                });
                setInspection(null);
              }}
            />
          </AppField>
          {
            <>
              <AppField
                name="url"
                label="规则文件 URL"
                rules={[
                  { required: true },
                  {
                    pattern: /^https:\/\//,
                    message: "请使用不含凭据的 HTTPS 地址",
                  },
                ]}
              >
                <Input placeholder="https://…" autoComplete="off" />
              </AppField>
              <AppField
                name="visibility"
                label="内容可见性"
                trigger="onValueChange"
              >
                <ChoiceSelect
                  options={[
                    { value: "public", label: "公开且不含个人信息的规则文件" },
                  ]}
                />
              </AppField>
            </>
          }
          <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
            <AppField
              name="format"
              label="文件格式"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={[
                  "mihomo-yaml",
                  "mihomo-text",
                  "mrs",
                  "sing-box-source",
                  "srs",
                ].map((value) => ({
                  value,
                  label: (
                    {
                      "mihomo-yaml": "Mihomo YAML",
                      "mihomo-text": "Mihomo 文本",
                      mrs: "Mihomo MRS",
                      "sing-box-source": "sing-box JSON",
                      srs: "sing-box SRS",
                    } as Record<string, string>
                  )[value],
                }))}
              />
            </AppField>
            <AppField name="behavior" label="匹配内容" trigger="onValueChange">
              <ChoiceSelect
                options={[
                  { value: "domain", label: "域名" },
                  { value: "ipcidr", label: "IP 网段" },
                  { value: "classical", label: "复合规则" },
                ]}
              />
            </AppField>
            <AppField
              name="updatePolicy"
              label="更新策略"
              trigger="onValueChange"
            >
              <ChoiceSelect
                options={
                  location === "remote"
                    ? [{ value: "follow", label: "跟随远程更新" }]
                    : [{ value: "pinned", label: "固定文件版本" }]
                }
              />
            </AppField>
            <AppField
              name="revision"
              label="版本标识"
              rules={[{ required: true }]}
            >
              <Input />
            </AppField>
            {location === "remote" && (
              <AppField
                name="intervalSeconds"
                label="客户端更新间隔（秒）"
                required
                rules={[integerRule(60, 2592000)]}
                trigger="onValueChange"
              >
                <ResourceIntegerInput min={60} max={2592000} />
              </AppField>
            )}
            {(format === "sing-box-source" || format === "srs") && (
              <AppField
                name="formatVersion"
                label="sing-box 规则格式版本"
                required
                rules={[integerRule(1, 5)]}
                trigger="onValueChange"
              >
                <ResourceIntegerInput min={1} max={5} />
              </AppField>
            )}
          </div>
          {location === "remote" &&
            ["mihomo-yaml", "sing-box-source"].includes(format) && (
              <ActionButton
                leadingIcon={<Search aria-hidden="true" />}
                onClick={() => void inspect()}
                variant="outline"
                pending={inspecting}
                keepFocusableWhilePending
              >
                读取文件并计算校验值
              </ActionButton>
            )}
          {inspection && (
            <p role="status">
              已读取 {inspection.entries} 条记录，共{" "}
              {bytesLabel(inspection.bytes)}。发布时仍会校验目标兼容性。
            </p>
          )}
          <AppField
            name="digest"
            label="SHA-256 校验值"
            rules={[
              {
                required: true,
                message: "请先读取文件或填写可信文件的 SHA-256 校验值",
              },
              {
                pattern: /^(sha256:)?[a-fA-F0-9]{64}$/,
                message: "需要 64 位十六进制 SHA-256 值",
              },
            ]}
          >
            <Input placeholder="从可信文件计算；不填占位值" />
          </AppField>
          <Accordion ref={disclosure} type="multiple">
            {[
              {
                key: "identity",
                label: "稳定引用标识",
                children: (
                  <AppField
                    name="id"
                    label="资源标识"
                    rules={[
                      { required: true },
                      { pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/ },
                    ]}
                  >
                    <Input disabled={!!current || mutation.isPending} />
                  </AppField>
                ),
              },
            ].map((section) => (
              <AccordionItem
                key={section.key}
                value={String(section.key)}
                disabled={
                  (mutation.isPending ? "disabled" : undefined) ===
                    "disabled" ||
                  ("collapsible" in section &&
                    section.collapsible === "disabled")
                }
              >
                <AccordionTrigger>{section.label}</AccordionTrigger>
                <AccordionContent
                  forceMount
                  className="data-[state=closed]:hidden"
                >
                  {section.children}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </AppForm>
      </TaskDialog>
    </>
  );
}
