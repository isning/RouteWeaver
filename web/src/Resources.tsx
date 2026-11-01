import { useConfirm } from "@/ui-patterns/confirmations";
import { NumericInput } from "@/ui-patterns/numeric-input";
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
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { list, post, saveRecord } from "./api";
import type { RuleResource } from "./types";
import { bytesLabel, newID } from "./model";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
interface Inspection {
  digest: string;
  formatVersion?: number;
  bytes: number;
  entries: number;
  inspection: string;
  nativeChecked: boolean;
}
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
  const confirmRefresh = useConfirm();
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
  const [form] = useForm<RuleResource>();
  const values = useWatch([], { form, preserve: true });
  const [baseline, setBaseline] = useState("");
  const [editorIdentity, setEditorIdentity] = useState("closed");
  const editorTask = useRef<object | null>(null);
  const submitting = useRef<object | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      editorTask.current = null;
    };
  }, []);
  const changed =
    open && baseline !== "" && draftSnapshot(values || {}) !== baseline;
  const { confirm, confirming } = useDiscardConfirmation(editorIdentity);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const revision = useRef(0);
  const location = useWatch("location", form);
  const format = useWatch("format", form);
  const digest = useWatch("digest", form);
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
  useUnsavedChanges(changed || (open && mutation.isPending));
  const inspect = useMutation({
    mutationFn: async () => {
      await form.validateFields(["url", "format"]);
      const version = revision.current;
      return {
        value: await post<Inspection>("/me/resources/inspect", {
          url: form.getFieldValue("url"),
          format: form.getFieldValue("format"),
        }),
        version,
      };
    },
    onSuccess: ({ value, version }) => {
      if (version !== revision.current) return;
      setInspection(value);
      form.setFieldsValue({
        digest: value.digest,
        formatVersion: value.formatVersion,
      });
    },
  });
  const edit = (resource?: RuleResource) => {
    if (resource?.acceptedVersion || resource?.location === "local") {
      startImport(resource);
      return;
    }
    editorTask.current = {};
    setEditorIdentity(newID("resource-task"));
    revision.current++;
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
    inspect.reset();
    setOpen(true);
  };
  const close = () => {
    if (submitting.current || mutation.isPending || confirming) return;
    const task = editorTask.current;
    const finish = () => {
      if (!active.current || !task || editorTask.current !== task) return;
      revision.current++;
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
      <ErrorNotice error={refresh.error} />
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section variant="plain">
          {!query.data?.length ? (
            <EmptyState
              title="暂无规则资源"
              action={
                <ActionButton onClick={() => startImport()} variant="default">
                  导入规则文件
                </ActionButton>
              }
            />
          ) : (
            <DataTable
              rowKey="id"
              rows={query.data}
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
                  render: (_, r) =>
                    r.acceptedVersion ? (
                      <>
                        <Badge variant="secondary">随配置打包</Badge>
                        <small className="ml-2 text-xs text-muted-foreground">
                          {bytesLabel(r.sizeBytes)}
                        </small>
                        {r.refreshStatus === "failed" && (
                          <p role="alert">
                            刷新失败，保留已接纳文件。新发布前请重试或替换。
                          </p>
                        )}
                      </>
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
                  title: "",
                  render: (_, r) => (
                    <TableRowActions name={r.name || r.id}>
                      <ActionButton onClick={() => edit(r)} variant="outline">
                        {r.acceptedVersion ? "替换文件" : "编辑"}
                      </ActionButton>
                      {r.canRefresh && (
                        <ActionButton
                          variant="outline"
                          pending={
                            !!(refresh.isPending && refresh.variables === r.id)
                          }
                          onClick={() =>
                            confirmRefresh({
                              title: `重新读取并接纳「${r.name || r.id}」的远程规则文件？`,
                              description:
                                "固定版本会核对原校验值；失败保留原文件，并阻止基于失败刷新状态的新发布。已发布配置包不改变。",
                              confirmLabel: "读取并接纳",
                              cancelLabel: "取消",
                              onConfirm: () => refresh.mutateAsync(r.id),
                            })
                          }
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
              disabled={!open}
              aria-label="保存公开引用"
              aria-busy={mutation.isPending}
              variant="default"
              pending={!!mutation.isPending}
            >
              保存公开引用
            </ActionButton>
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
              confirming
            )
              return;
            const value = ruleResourceReference({
              ...current,
              ...v,
              id: current?.id || v.id || form.getFieldValue("id"),
              url: v.location === "remote" ? v.url : undefined,
              path: v.location === "local" ? v.path : undefined,
              intervalSeconds:
                v.location === "remote" ? v.intervalSeconds : undefined,
              formatVersion:
                v.format.startsWith("sing-box") || v.format === "srs"
                  ? v.formatVersion
                  : undefined,
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
            revision.current++;
            if ("url" in changed || "format" in changed) {
              inspect.reset();
              setInspection(null);
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
            disabled={mutation.isPending || !open}
          />
          <ErrorNotice error={mutation.error || inspect.error} />
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
              <p className="muted text-sm text-muted-foreground">
                远程文件随配置交付时，客户端会直接访问此地址。只有明确公开的规则文件可用于这种方式。
              </p>
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
                rules={[{ required: true }]}
                trigger="onValueChange"
              >
                <NumericInput min={60} max={2592000} />
              </AppField>
            )}
            {(format === "sing-box-source" || format === "srs") && (
              <AppField
                name="formatVersion"
                label="sing-box 规则格式版本"
                rules={[
                  { required: true, message: "检查远程文件或填写规则格式版本" },
                ]}
                trigger="onValueChange"
              >
                <NumericInput min={1} max={5} />
              </AppField>
            )}
          </div>
          {location === "remote" &&
            ["mihomo-yaml", "sing-box-source"].includes(format) && (
              <ActionButton
                leadingIcon={<Search aria-hidden="true" />}
                onClick={() => inspect.mutate()}
                variant="outline"
                pending={!!inspect.isPending}
              >
                读取文件并计算校验值
              </ActionButton>
            )}
          {inspection && (
            <p role="status">
              已读取 {bytesLabel(inspection.bytes)} · {inspection.entries}{" "}
              条记录。发布时仍会校验目标兼容性。
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
