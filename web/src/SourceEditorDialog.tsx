import { PasswordInput } from "@/ui-patterns/password-input";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { useConfirm } from "@/ui-patterns/confirmations";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
import { invalidateOutputInputs } from "./output-comparison";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { APIError, request, saveRecord } from "./api";
import { newID, diagnosticText } from "./model";
import { ErrorNotice, QueryState } from "./components";
import { useUnsavedChanges } from "./navigation";
import type { Source } from "./types";
import { sourceApplicationNoticeID } from "./source-notice";
import {
  sourceFailureText,
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";

async function readSourceEditor(id: string) {
  const path = `/me/sources/${encodeURIComponent(id)}`;
  const [full, summary] = await Promise.all([
    request<Source>(`${path}/reveal`),
    request<Source>(path),
  ]);
  // Both absent revisions support legacy records. A partial or mismatched pair
  // cannot authorize replacing local input or establish a new version fence.
  if (
    full?.id !== id ||
    summary?.id !== id ||
    (full.revision || undefined) !== (summary.revision || undefined)
  )
    throw new Error("来源在读取时发生变化，请重试。");
  return { full, summary };
}
/**
 * A source-only editor shared by management and contextual creation.
 * `onSaved` reports a successful source write before `onClose`; the caller decides
 * how to use that source. It never saves or publishes a containing profile.
 * An active dialog must not be unmounted by its containing drawer. Dirty and
 * pending writes also register with the application's global navigation guard.
 */
export interface SourceEditorDialogProps {
  open: boolean;
  /** Omit for creation. Identity and revealed values are fixed for each opening. */
  source?: Source | null;
  /** Closing never rolls back submitted input; returns its known saved summary. */
  onClose: (savedSource?: Source) => void;
  /** A successful source write; inspect diagnostics/candidate before using it. */
  onSaved: (source: Source) => void;
  primaryActionText?: string;
  /** Contextual owners show the selected source in their retained draft. */
  successFeedback?: "toast" | "parent";
  /** True while open, including loading, discard confirmation and pending writes. */
  onActivityChange?: (blocked: boolean) => void;
}
export function SourceEditorDialog({
  open,
  onActivityChange,
  ...editorProps
}: SourceEditorDialogProps) {
  useEffect(() => {
    onActivityChange?.(open);
    return () => onActivityChange?.(false);
  }, [open, onActivityChange]);
  // Each opening is a fresh editing session. Source list refetches must never
  // overwrite private fields or user-entered values inside that session.
  return open ? <SourceEditorSession {...editorProps} /> : null;
}
function SourceEditorSession({
  source,
  onClose,
  onSaved,
  primaryActionText,
  successFeedback = "toast",
}: Omit<SourceEditorDialogProps, "open" | "onActivityChange">) {
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const [initialSource] = useState(source);
  const [editing, setEditing] = useState(source || null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [savedSummary, setSavedSummary] = useState(source || undefined);
  const [savedFailure, setSavedFailure] = useState<Source | null>(
    sourceHasFailure(source) ? source! : null,
  );
  const [retainedDraft, setRetainedDraft] = useState<Source | null>(null);
  const [editorID] = useState(() => source?.id || newID("src"));
  const formID = `source-editor-${useId()}`;
  const [fileError, setFileError] = useState<Error | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!source);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const fileRead = useRef(0);
  // A local selection owns the next content value until read, cancelled, or replaced.
  const fileBlocked = useRef(false);
  const [fileState, setFileState] = useState<
    "idle" | "reading" | "failed" | "ready"
  >("idle");
  const clearFileSelection = () => {
    fileRead.current++;
    fileBlocked.current = false;
    setFileState("idle");
    setSelectedFileName("");
    setFileError(null);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const saving = useRef(false);
  const reloading = useRef(false);
  const sourceNameInput = useRef<HTMLInputElement>(null);
  const [reloadFocus, setReloadFocus] = useState(0);
  const focusedReload = useRef(0);
  const submitButton = useRef<HTMLButtonElement>(null);
  const modalBody = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [opener] = useState(() => document.activeElement);
  const closing = useRef<{
    summary?: Source;
    panel: HTMLElement | null;
  } | null>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const discardReview = useRef<{
    close: () => void;
  } | null>(null);
  const [form] = useForm();
  const submitErrorFocusOwner = useRef({});
  const [completionElement, setCompletionElement] =
    useState<HTMLDivElement | null>(null);
  const [sequentialScroll, setSequentialScroll] = useState(false);
  const watchedKind = useWatch("kind", form);
  // The watcher starts undefined until its passive subscription reads the form.
  // Present the same session value from the first commit; do not write or coerce
  // existing/unknown source kinds merely to choose which controls to render.
  const kind =
    watchedKind ??
    form.getFieldValue("kind") ??
    (initialSource ? initialSource.kind : "text");
  const watchedFormat = useWatch("format", form);
  // Reveal populates the form before passive watchers subscribe. Read its latest
  // value for the first ready commit, without coercing unknown parser formats.
  const format = watchedFormat ?? form.getFieldValue("format");
  // Parser aliases remain intact on save; never repair an unknown value implicitly.
  const formatAliases: Record<string, string> = {
    uri: "节点 URI 列表",
    "mihomo-json": "Mihomo JSON",
    "sing-box-json": "sing-box JSON",
  };
  const unsupportedFormat =
    !!format &&
    ![
      "auto",
      "uri-list",
      "base64",
      "mihomo",
      "sing-box",
      ...Object.keys(formatAliases),
    ].includes(format);
  useLayoutEffect(() => {
    if (!completionElement) return;
    const container = completionElement.closest<HTMLElement>(
      '[data-task-overlay="dialog"]',
    );
    const header = container?.querySelector<HTMLElement>(
      '[data-slot="dialog-header"]',
    );
    const footer = completionElement.closest<HTMLElement>(
      '[data-slot="dialog-footer"]',
    );
    if (!container || !header || !footer) return;
    const measure = () => {
      const style = getComputedStyle(container);
      const viewportHeight =
        window.visualViewport?.height || window.innerHeight;
      const chromeHeight =
        header.getBoundingClientRect().height +
        footer.getBoundingClientRect().height +
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0) +
        32;
      // Keep a usable field area, including when text grows. When there is not
      // enough room, the whole task scrolls in document order: no overlay footer.
      const fieldSpace = Math.max(200, (parseFloat(style.fontSize) || 16) * 14);
      setSequentialScroll(chromeHeight + fieldSpace > viewportHeight - 64);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    observer.observe(header);
    observer.observe(container);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [completionElement]);
  const snapshot = (values: Partial<Source> | undefined) =>
    JSON.stringify(
      (
        [
          "name",
          "kind",
          "enabled",
          "format",
          "content",
          "url",
          "applyMode",
        ] as const
      ).map((key) =>
        (key === "content" && values?.kind !== "text") ||
        (key === "url" && values?.kind !== "url")
          ? ""
          : (values?.[key] ?? ""),
      ),
    );
  const editorBaseline = useRef(
    snapshot(
      initialSource
        ? undefined
        : { kind: "text", enabled: true, applyMode: "auto" },
    ),
  );
  const [editorDirty, setEditorDirty] = useState(false);
  const editorSnapshot = () => snapshot(form.getFieldsValue(true));
  const updateEditorDirty = () =>
    setEditorDirty(editorSnapshot() !== editorBaseline.current);
  useEffect(() => {
    if (!initialSource) return;
    let current = true;
    setLoading(true);
    setLoadError(null);
    readSourceEditor(initialSource.id)
      .then(({ full, summary }) => {
        if (!current) return;
        setEditing(full);
        // Never derive a public summary from credential-bearing reveal data.
        setSavedSummary(summary);
        setSavedFailure(sourceHasFailure(summary) ? summary : null);
        form.setFieldsValue({ ...full, applyMode: full.applyMode ?? "auto" });
        editorBaseline.current = snapshot({
          ...full,
          applyMode: full.applyMode ?? "auto",
        });
        setEditorDirty(false);
      })
      .catch((error: Error) => {
        if (current) setLoadError(error);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [initialSource, loadAttempt, form]);
  useEffect(
    () => () => {
      fileRead.current++;
      const review = discardReview.current;
      discardReview.current = null;
      review?.close();
    },
    [],
  );
  const mutation = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    mutationFn: (values: Source) =>
      saveRecord<Source>(
        "me/sources",
        {
          id: editing?.id || retainedDraft?.id || editorID,
          revision: editing?.revision || retainedDraft?.revision,
          name: values.name,
          kind: values.kind,
          enabled: values.enabled,
          format: values.format,
          applyMode: values.applyMode ?? editing?.applyMode ?? "auto",
          content: values.kind === "text" ? values.content : undefined,
          url: values.kind === "url" ? values.url : undefined,
        },
        !editing && !retainedDraft,
      ),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["sources"] });
      if (!active.current) return;
      setSaveUncertain(false);
      setEditorDirty(false);
      if (!result.candidate && successFeedback === "toast")
        message.success(editing ? "来源已更新" : "来源已添加", {
          id: sourceApplicationNoticeID(result.id),
        });
      onSaved(result);
      onClose();
    },
    onError: (error, submitted) => {
      client.invalidateQueries({ queryKey: ["sources"] });
      if (!active.current) return;
      // A later conflict does not resolve a previous response lost after commit.
      if (
        !(error instanceof APIError) ||
        error.status === 0 ||
        error.status >= 500 ||
        error.status === 200
      )
        setSaveUncertain(true);
      const retained =
        error instanceof APIError
          ? (
              error.details as {
                source?: Source;
              }
            )?.source
          : undefined;
      if (
        error instanceof APIError &&
        error.status === 422 &&
        retained?.id === (editing?.id || retainedDraft?.id || editorID) &&
        retained.revision &&
        (sourceHasFailure(retained) || !retained.refreshStatus)
      ) {
        setSaveUncertain(false);
        setSavedSummary(retained);
        setSavedFailure(retained);
        editorBaseline.current = snapshot(submitted);
        setEditorDirty(editorSnapshot() !== editorBaseline.current);
        if (editing) setEditing({ ...editing, revision: retained.revision });
        else setRetainedDraft(retained);
      }
    },
    onSettled: () => {
      invalidateOutputInputs(client);
      saving.current = false;
    },
  });
  const rejectedSource =
    mutation.error instanceof APIError
      ? (
          mutation.error.details as {
            source?: Source;
          }
        )?.source
      : undefined;
  // Only a correlated, retained source failure can replace this mutation's
  // error panel. Transport/auth/conflict and uncertain-save handling stay intact.
  const savedRetainedFailure =
    !saveUncertain &&
    mutation.error instanceof APIError &&
    mutation.error.status === 422 &&
    rejectedSource?.id === (editing?.id || retainedDraft?.id || editorID) &&
    !!rejectedSource?.revision &&
    rejectedSource.id === savedFailure?.id &&
    rejectedSource.revision === savedFailure?.revision &&
    (sourceHasFailure(rejectedSource) || !rejectedSource.refreshStatus) &&
    (sourceHasFailure(savedFailure) || !savedFailure?.refreshStatus);
  const unresolvedFile = fileState === "reading" || fileState === "failed";
  const reload = useMutation({
    mutationFn: () => readSourceEditor(editorID),
    onSuccess: ({ full, summary }) => {
      if (!active.current || closing.current) return;
      // Discard permission covers the complete input, never just its revision.
      // Read failures leave this exact form and its uncertainty untouched.
      clearFileSelection();
      form.resetFields();
      form.setFieldsValue({ ...full, applyMode: full.applyMode ?? "auto" });
      editorBaseline.current = snapshot({ ...full, applyMode: full.applyMode ?? "auto" });
      setEditing(full);
      setRetainedDraft(null);
      setSavedSummary(summary);
      setSavedFailure(sourceHasFailure(summary) ? summary : null);
      setSaveUncertain(false);
      setEditorDirty(false);
      mutation.reset();
      setReloadFocus((version) => version + 1);
      client.invalidateQueries({ queryKey: ["sources"] });
    },
    onSettled: () => { reloading.current = false; },
  });
  useLayoutEffect(() => {
    if (reloadFocus === focusedReload.current || reload.isPending || !active.current) return;
    focusedReload.current = reloadFocus;
    const focused = document.activeElement;
    if (focused === document.body || (focused instanceof Node && modalBody.current?.contains(focused)))
      sourceNameInput.current?.focus();
  }, [reloadFocus, reload.isPending]);
  const sourceConflict = (
    mutation.error instanceof APIError && (
      mutation.error.status === 409 ||
      (mutation.error.status === 412 &&
        (mutation.error.details as { code?: string } | undefined)?.code === "SOURCE_CREATION_CONFLICT")
    )
  );
  const canReload = saveUncertain || sourceConflict;
  const reviewReload = () => {
    if (!active.current || !open || closing.current || saving.current || reloading.current || discardReview.current)
      return;
    let confirmed = false;
    const review = confirm({
      contentProps: { onFocusCapture: revealFocusedModalAction },
      title: "放弃当前修改并读取最新来源？",
      description: "这会替换当前窗口中的未保存输入。已保存的来源和已发布订阅不会改变。",
      confirmLabel: "放弃修改并读取",
      cancelLabel: "保留当前输入",
      destructive: true,
      onConfirm: () => {
        if (active.current && discardReview.current === review) confirmed = true;
      },
      onCancel: () => { confirmed = false; },
      onClosed: () => {
        if (discardReview.current !== review) return;
        discardReview.current = null;
        if (!confirmed || !active.current || closing.current) return;
        reloading.current = true;
        reload.mutate();
      },
    });
    discardReview.current = review;
  };
  const pending = mutation.isPending || reload.isPending;
  useUnsavedChanges(open && (editorDirty || unresolvedFile || pending));
  const closeEditor = () => {
    if (
      !active.current ||
      !open ||
      closing.current ||
      saving.current ||
      reloading.current ||
      mutation.isPending ||
      discardReview.current
    )
      return;
    const discard = () => {
      if (!active.current || closing.current) return;
      fileRead.current++;
      setEditorDirty(false);
      closing.current = {
        summary: savedSummary,
        panel:
          modalBody.current?.closest<HTMLElement>('[role="dialog"]') || null,
      };
      setOpen(false);
    };
    if (!fileBlocked.current && editorSnapshot() === editorBaseline.current)
      return discard();
    let confirmed = false;
    const review = confirm({
      contentProps: { onFocusCapture: revealFocusedModalAction },
      title: saveUncertain ? "关闭来源编辑？" : "放弃尚未保存的来源修改？",
      description: saveUncertain
        ? "尚未确认上次提交是否已保存。关闭不会撤销已提交的来源输入；当前窗口中的输入将不再保留。"
        : savedSummary
          ? "本次提交后的修改尚未保存。已保存的来源输入会保留。"
          : "这次修改的来源设置尚未保存。",
      confirmLabel: saveUncertain ? "关闭编辑" : "放弃修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: () => {
        if (active.current && discardReview.current === review)
          confirmed = true;
      },
      onCancel: () => {
        confirmed = false;
      },
      onClosed: () => {
        if (discardReview.current !== review) return;
        discardReview.current = null;
        // The nested confirmation must relinquish focus before its source
        // editor closes and returns focus to the owning task.
        if (confirmed && active.current) discard();
      },
    });
    discardReview.current = review;
  };
  return (
    <TaskDialog
      title={editing ? "编辑来源" : "添加订阅来源"}
      open={open}
      className="source-editor-modal"
      footer={
        !loading && !loadError ? (
          <div
            ref={setCompletionElement}
            role="group"
            aria-label="来源导入确认"
          >
            <div className="privacy-note mb-3 flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
              <FileText aria-hidden="true" />
              <span>
                订阅信息由平台解析并加密保存，仅供你的账号使用。
              </span>
            </div>
            <div className="form-footer flex flex-wrap items-center justify-end gap-2">
              <ActionButton
                onClick={closeEditor}
                disabled={pending || !open}
                variant="outline"
              >
                取消
              </ActionButton>
              <ActionButton
                keepFocusableWhilePending
                ref={submitButton}
                type="submit"
                form={formID}
                aria-label={
                  primaryActionText || (editing ? "保存修改" : "导入来源")
                }
                aria-busy={mutation.isPending}
                disabled={!open || unresolvedFile || reload.isPending}
                variant="default"
                pending={!!mutation.isPending}
              >
                {primaryActionText || (editing ? "保存修改" : "导入来源")}
              </ActionButton>
            </div>
          </div>
        ) : null
      }
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeEditor();
      }}
      pending={pending}
      onClosed={() => {
        const task = closing.current;
        if (!active.current || !task) return;
        closing.current = null;
        const focused = document.activeElement;
        // Contextual parents are still inert here and own their later return.
        // Standalone cancellation may restore only this exact, still-available
        // opener, never a newer dialog/control or a guessed replacement target.
        if (
          document.hasFocus() &&
          document.visibilityState === "visible" &&
          (focused === document.body ||
            (focused instanceof Node && task.panel?.contains(focused))) &&
          opener instanceof HTMLElement &&
          opener !== document.body &&
          opener.isConnected &&
          !opener.closest('[hidden], [inert], [aria-hidden="true"]') &&
          !opener.matches(':disabled, [aria-disabled="true"]') &&
          opener.getClientRects().length > 0 &&
          !["hidden", "collapse"].includes(getComputedStyle(opener).visibility)
        )
          opener.focus();
        onClose(task.summary);
      }}
      size="lg"
      contentRef={modalBody}
      scrollMode={sequentialScroll ? "task" : "body"}
    >
      <AppForm
        id={formID}
        name={formID}
        form={form}
        submitErrorFocusOwner={open ? submitErrorFocusOwner.current : null}
        onKeyDownCapture={(event) => {
          // A held confirmation key must not submit the freshly loaded form.
          // Keep ordinary Enter submission and textarea editing available.
          if (event.repeat && event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement))
            event.preventDefault();
        }}
        initialValues={
          initialSource
            ? undefined
            : { kind: "text", enabled: true, applyMode: "auto" }
        }
        onFinish={() => {
          if (
            !active.current ||
            closing.current ||
            !open ||
            saving.current ||
            reloading.current ||
            fileBlocked.current ||
            mutation.isPending ||
            discardReview.current ||
            loading ||
            loadError
          )
            return;
          saving.current = true;
          const submit = submitButton.current;
          if (
            submit?.form?.contains(document.activeElement) &&
            !submit.closest('[inert], [aria-hidden="true"]')
          )
            submit.focus();
          fileRead.current++;
          // Collapsed import options are not mounted until opened. Keep their
          // revealed values when saving without visiting that optional section.
          mutation.mutate(form.getFieldsValue(true));
        }}
        onValuesChange={(changed) => {
          if ("kind" in changed || "content" in changed) clearFileSelection();
          updateEditorDirty();
        }}
        disabled={pending || !open}
      >
        <QueryState
          loading={loading}
          error={loadError}
          retry={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          {sourceStatusUnknown(savedSummary) &&
            !savedFailure &&
            !saveUncertain && (
              <Notice
                className="form-error my-3"
                tone="warning"
                title="来源状态待确认"
              >
                {sourceIssueText(savedSummary)}
              </Notice>
            )}
          {savedFailure && !saveUncertain && (
            <Notice
              className="form-error my-3"
              tone="warning"
              title={
                editorDirty || unresolvedFile
                  ? "上次提交已保存，导入未完成"
                  : "输入已保存，导入未完成"
              }
            >
              {(savedFailure.snapshot
                ? "之前可用节点仍保留。"
                : "此来源尚无可用节点。") +
                (sourceFailureText(savedFailure) ||
                  "导入未完成。请检查来源设置和内容后重试。") +
                "关闭不会撤销已保存的输入。"}
            </Notice>
          )}
          {canReload && (
            <Notice
              className="form-error my-3"
              tone="warning"
              title={saveUncertain ? "尚未确认输入是否保存" : "来源已变化，当前输入已保留。"}
              action={
                <ActionButton
                  variant="outline"
                  disabled={mutation.isPending}
                  pending={reload.isPending}
                  onClick={reviewReload}
                >
                  读取最新来源
                </ActionButton>
              }
            >
              {saveUncertain
                ? "当前输入仍在此窗口中。关闭编辑不会撤销可能已保存的来源输入。"
                : "读取最新来源前会先确认是否放弃当前输入。"}
            </Notice>
          )}
          <ErrorNotice error={reload.error} />
          <ErrorNotice
            error={
              savedRetainedFailure || sourceConflict ? fileError : mutation.error || fileError
            }
          />
          {mutation.error instanceof APIError &&
            (
              mutation.error.details as {
                source?: Source;
              }
            )?.source?.diagnostics?.map((d, i) => (
              <Notice
                key={i}
                className="form-error my-3"
                tone="warning"
                title={diagnosticText(d)}
              />
            ))}
          {unsupportedFormat && (
            <Notice tone="warning" title="当前内容格式不受支持">
              当前值为「{format}
              」。请在“导入选项”中选择支持的格式；选择前会保留原值。
            </Notice>
          )}
          <AppField
            name="name"
            label="来源名称"
            rules={[{ required: true, message: "给来源取一个名称" }]}
          >
            <Input ref={sourceNameInput} placeholder="例如：我的机场" maxLength={80} />
          </AppField>
          <fieldset className="source-input-fieldset mb-6 min-w-0 space-y-2 [&>legend]:mb-2 [&>legend]:text-sm">
            <legend>导入方式</legend>
            <AppField name="kind" noStyle trigger="onValueChange">
              <RadioGroup
                aria-label="导入方式"
                className="source-input-methods grid gap-3 sm:grid-cols-2"
              >
                {[
                  { value: "text", label: "节点 URI / 配置文本" },
                  { value: "url", label: "订阅 URL" },
                ].map((option) => (
                  <Label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                  >
                    <RadioGroupItem
                      value={String(option.value)}
                      disabled={"disabled" in option && !!option.disabled}
                    />
                    {option.label}
                  </Label>
                ))}
              </RadioGroup>
            </AppField>
          </fieldset>
          {kind === "url" ? (
            <AppField
              name="url"
              label="订阅地址"
              rules={[
                { required: true, message: "请输入订阅地址" },
                { type: "url", message: "请输入完整的 https:// 地址" },
              ]}
            >
              <PasswordInput
                revealLabel="订阅地址"
                placeholder="https://…"
                autoComplete="off"
              />
            </AppField>
          ) : (
            <AppField
              name="content"
              label="节点链接或配置内容"
              rules={[{ required: true, message: "请粘贴内容" }]}
            >
              <Textarea
                className="min-h-40 font-mono text-sm"
                rows={7}
                placeholder="粘贴 SOCKS / Shadowsocks / VLESS 节点 URI，或 Mihomo、sing-box 配置内容"
                spellCheck={false}
              />
            </AppField>
          )}
          {kind === "text" && (
            <div className="source-file-control my-3 grid justify-items-start gap-2">
              <ActionButton
                leadingIcon={<FileText aria-hidden="true" />}
                disabled={pending || !open}
                onClick={() => fileInput.current?.click()}
                variant="outline"
              >
                选择配置文件
              </ActionButton>
              <span
                className="source-file-status max-w-full text-sm text-muted-foreground wrap-anywhere"
                role="status"
              >
                {fileState === "reading"
                  ? `正在读取文件：${selectedFileName}`
                  : fileState === "failed"
                    ? `文件未读取：${selectedFileName}`
                    : selectedFileName
                      ? `已读取文件：${selectedFileName}`
                      : "尚未选择文件"}
              </span>
              {unresolvedFile && (
                <ActionButton variant="outline" disabled={pending} onClick={clearFileSelection}>
                  取消文件选择
                </ActionButton>
              )}
              <input
                ref={fileInput}
                hidden
                aria-label="读取配置文件"
                type="file"
                accept=".txt,.yaml,.yml,.json,.conf"
                disabled={pending || !open}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file || !active.current || closing.current || saving.current || reloading.current)
                    return;
                  // Clear the native value so choosing the same file retries a failed read.
                  event.target.value = "";
                  setSelectedFileName(file.name);
                  const revision = ++fileRead.current;
                  fileBlocked.current = true;
                  setFileState("reading");
                  setFileError(null);
                  if (file.size > 1024 * 1024) {
                    setFileState("failed");
                    setFileError(
                      new Error(
                        "配置文件最大 1 MB。更大的订阅请使用 URL 导入。",
                      ),
                    );
                    return;
                  }
                  try {
                    const content = await file.text();
                    if (active.current && revision === fileRead.current) {
                      fileBlocked.current = false;
                      setFileState("ready");
                      form.setFieldValue("content", content);
                      updateEditorDirty();
                    }
                  } catch {
                    if (active.current && revision === fileRead.current) {
                      setFileState("failed");
                      setFileError(new Error("无法读取文件，请重新选择。"));
                    }
                  }
                }}
              />
              <small>
                文件先在本地读取，提交后才上传。仅提取受支持的连接内容。
              </small>
            </div>
          )}
          <AppField
            name="applyMode"
            label="更新应用方式"
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={[
                { value: "auto", label: "自动应用" },
                { value: "manual", label: "手动应用" },
              ]}
            />
          </AppField>
          <p className="mb-6 text-sm text-muted-foreground">
            首次导入立即可用。后续更新按此方式应用到来源，不会自动发布订阅。
          </p>
          <Accordion type="multiple">
            {[
              {
                key: "import-options",
                label: "导入选项",
                children: (
                  <>
                    <AppField
                      name="format"
                      label="内容格式"
                      trigger="onValueChange"
                    >
                      <ChoiceSelect
                        placeholder="自动识别"
                        selectedLabel={
                          unsupportedFormat
                            ? `${format}（不支持）`
                            : formatAliases[format]
                        }
                        options={[
                          { value: "auto", label: "自动识别" },
                          { value: "uri-list", label: "节点 URI 列表" },
                          { value: "base64", label: "Base64 订阅" },
                          { value: "mihomo", label: "Mihomo YAML / JSON" },
                          { value: "sing-box", label: "sing-box JSON" },
                        ]}
                      />
                    </AppField>
                  </>
                ),
              },
            ].map((section) => (
              <AccordionItem
                key={section.key}
                value={String(section.key)}
                disabled={
                  (pending || !open ? "disabled" : undefined) ===
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
          <AppField
            name="enabled"
            label="启用来源"
            valuePropName="checked"
            trigger="onCheckedChange"
          >
            <Switch />
          </AppField>
        </QueryState>
      </AppForm>
    </TaskDialog>
  );
}
