import { TaskDialog } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { invalidateOutputInputs } from "./output-comparison";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { APIError, prepareFilePost } from "./api";
import { bytesLabel, newID } from "./model";
import type { RuleResource } from "./types";
import { ErrorNotice, type ErrorNoticeFocusHandle } from "./components";
import { Notice } from "@/ui-patterns/notice";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { useUnsavedChanges } from "./navigation";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
const draftSnapshot = (values: object) =>
  JSON.stringify(
    Object.entries(values)
      .filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
function readFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error);
      else resolve(String(reader.result).split(",", 2)[1]);
    };
    const cancel = () => {
      finish(new Error("文件读取已取消，请重新选择。"));
      reader.abort();
    };
    reader.onload = () => finish();
    reader.onerror = () => finish(new Error("文件读取失败，请重新选择。"));
    reader.onabort = () => finish(new Error("文件读取已取消，请重新选择。"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else {
      try {
        reader.readAsDataURL(file);
      } catch {
        finish(new Error("文件读取失败，请重新选择。"));
      }
    }
  });
}
export function RuleFileImport({
  initial,
  onClose,
}: {
  initial?: RuleResource;
  onClose: () => void;
}) {
  const formId = useId();
  const [id] = useState(initial?.id || newID("resource")),
    [open, setOpen] = useState(true),
    [mode, setMode] = useState("upload"),
    [file, setFile] = useState<File | null>(null),
    [fileSelected, setFileSelected] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [form] = useForm();
  // Keep the opened record's precondition for this dialog's entire lifetime.
  const [openedRevision] = useState(() =>
    initial ? initial.revisionToken ?? "" : undefined,
  );
  const [initialValues] = useState(() => ({
    name: initial?.name || "",
    format: initial?.format || "mihomo-yaml",
    behavior: initial?.behavior || "domain",
    updatePolicy: initial?.updatePolicy || "pinned",
  }));
  const values = useWatch([], { form, preserve: true });
  const dirty =
    fileSelected ||
    mode !== "upload" ||
    (values !== undefined &&
      draftSnapshot(values) !== draftSnapshot(initialValues));
  const active = useRef(true);
  const submitting = useRef(false);
  const lifetime = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const errorFocus = useRef<ErrorNoticeFocusHandle>(null);
  const envelopeSummary = useRef<HTMLDivElement>(null);
  const failureFocus = useRef<{ error: Error; owner: number } | null>(null);
  const disclosure = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      lifetime.current++;
      reading.current?.abort();
      reading.current = null;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation(id);
  const client = useQueryClient(),
    message = toast;
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => {
      submitting.current = false;
      invalidateOutputInputs(client);
    },
    mutationFn: async ({
      values,
      mode,
      file,
      owner,
    }: {
      values: Record<string, any>;
      mode: string;
      file: File | null;
      owner: number;
    }) => {
      const stillCurrent = () => active.current && lifetime.current === owner;
      if (!stillCurrent()) throw new Error("文件导入已取消。");
      if (openedRevision === "")
        throw new Error(
          "无法确认已打开的规则文件版本。当前输入已保留，请关闭后重新打开规则文件。",
        );
      const postFile = prepareFilePost(stillCurrent);
      const resource = {
        id,
        name: values.name,
        format: values.format,
        behavior: values.behavior,
        updatePolicy: values.updatePolicy,
        visibility: "private",
        digest: values.digest
          ? values.digest.startsWith("sha256:")
            ? values.digest
            : `sha256:${values.digest}`
          : undefined,
        ...(mode === "fetch" ? { url: values.url } : {}),
      };
      if (mode === "upload" && !file)
        throw new Error("请选择要导入的规则文件。");
      let contentBase64: string | undefined;
      if (mode === "upload") {
        const controller = new AbortController();
        reading.current = controller;
        try {
          contentBase64 = await readFile(file!, controller.signal);
        } finally {
          if (reading.current === controller) reading.current = null;
        }
      }
      if (!stillCurrent()) throw new Error("文件导入已取消。");
      return postFile<RuleResource>(
        "/me/resources/import",
        {
          resource,
          ...(mode === "fetch" ? { fetch: true } : { contentBase64 }),
        },
        openedRevision === undefined ? undefined : { "If-Match": openedRevision },
      );
    },
    onSuccess: (_result, { owner }) => {
      client.invalidateQueries({ queryKey: ["resources"] });
      if (!active.current || lifetime.current !== owner) return;
      message.success("规则文件已接纳，发布配置时会一并打包");
      setOpen(false);
    },
    onError: (error, { owner }) => {
      client.invalidateQueries({ queryKey: ["resources"] });
      if (active.current && lifetime.current === owner) {
        failureFocus.current = { error, owner };
        setError(error);
      }
    },
  });
  // Local recovery copy applies only to this submitted file format's known
  // envelope rejection, never to URL fetches, auth, pins or unknown failures.
  const submittedFormat = save.variables?.values.format;
  const envelopeFailure = error instanceof APIError && error.status === 422 &&
    save.variables?.mode === "upload" && typeof submittedFormat === "string" &&
    ["mihomo-yaml", "mihomo-text", "mrs", "sing-box-source", "srs"].includes(submittedFormat) &&
    error.message === `invalid or excessive ${submittedFormat} rule file envelope`;
  const privateAddressFailure = error instanceof APIError && error.status === 422 &&
    save.variables?.mode === "fetch" && error.message === "resource address is not public";
  useLayoutEffect(() => {
    const failure = failureFocus.current;
    if (!failure || save.isPending) return;
    // Consume once: inactive/newer tasks must not replay focus on a later render.
    failureFocus.current = null;
    if (!active.current || !open || failure.owner !== lifetime.current ||
        failure.error !== error ||
        (error instanceof APIError && [401, 403].includes(error.status))) return;
    const dialog = submitButton.current?.closest('[role="dialog"]');
    if (!document.hasFocus() || document.visibilityState !== "visible" ||
        document.activeElement !== submitButton.current ||
        !dialog || document.activeElement?.closest('[role="dialog"],[role="alertdialog"]') !== dialog) return;
    if (!envelopeFailure) {
      errorFocus.current?.focus();
      return;
    }
    const summary = envelopeSummary.current;
    if (!summary?.isConnected || !document.hasFocus() || document.visibilityState !== "visible" ||
        summary.closest('[hidden],[inert],[aria-hidden="true"],[data-session-workspace][aria-busy="true"]')) return;
    for (let node: HTMLElement | null = summary; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return;
    }
    summary.tabIndex = -1;
    summary.focus({ preventScroll: true });
    if (document.activeElement === summary)
      summary.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [error, envelopeFailure, open, save.isPending]);
  useUnsavedChanges(open && (dirty || save.isPending));
  const close = () => {
    if (!open || submitting.current || save.isPending || confirming) return;
    if (!dirty) return setOpen(false);
    confirm(
      {
        title: "放弃未保存的规则文件修改？",
        description: "当前填写的信息和选择的文件尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedModalAction },
      },
      () => setOpen(false),
    );
  };
  return (
    <TaskDialog
      title={initial ? `替换 ${initial.name || initial.id}` : "导入规则文件"}
      open={open}
      footer={null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      pending={save.isPending}
      onClosed={() => {
        if (active.current) onClose();
      }}
      size="lg"
    >
      <AppForm
        className="space-y-5"
        form={form}
        name={formId}
        disabled={save.isPending || !open}
        onTransitionEnd={(event) => {
          // An expansion already in flight can move the busy action after native focus.
          // Reveal only that same focus owner; never choose focus after submission.
          const submit = submitButton.current;
          const panel = event.target;
          if (
            !active.current ||
            !open ||
            !(save.isPending ? submitting.current : save.isError) ||
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
        initialValues={initialValues}
        onFinish={(v) => {
          if (
            !active.current ||
            !open ||
            submitting.current ||
            save.isPending ||
            confirming
          )
            return;
          submitting.current = true;
          const submit = submitButton.current;
          if (
            submit?.form?.contains(document.activeElement) &&
            !submit.closest('[inert], [aria-hidden="true"]')
          )
            submit.focus();
          setError(null);
          save.mutate({
            values: structuredClone({ ...form.getFieldsValue(true), ...v }),
            mode,
            file,
            owner: lifetime.current,
          });
        }}
      >
        {envelopeFailure ? (
          <div
            ref={envelopeSummary}
            className="form-error"
            role="group"
            aria-labelledby={`${formId}-error-title`}
            aria-describedby={`${formId}-error-recovery`}
          >
            <Notice tone="error" title={<span id={`${formId}-error-title`}>规则文件未通过格式检查</span>}>
              <p id={`${formId}-error-recovery`}>已保留所选文件和填写内容。请核对文件格式，或修正文件后重新选择，再导入。</p>
              <details>
                <summary className="cursor-pointer">查看检查详情</summary>
                <p>{error.message}</p>
              </details>
            </Notice>
          </div>
        ) : <ErrorNotice
          error={error}
          focusRef={errorFocus}
          presentation={privateAddressFailure ? {
            title: "无法读取此规则文件地址",
            recovery: "该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或将导入方式切换为“上传本地文件”。",
            detailsLabel: "查看检查详情",
          } : undefined}
        />}
        {initial?.acceptedVersion && (
          <p className="muted text-sm text-muted-foreground">
            当前文件 {bytesLabel(initial.sizeBytes)}
            。导入失败时保留已接纳文件，已发布订阅继续使用原文件版本。
          </p>
        )}
        <AppField
          name="name"
          label="导入资源名称"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
        </AppField>
        <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
          导入方式
          <ChoiceSelect
            aria-label="规则文件导入方式"
            value={mode}
            disabled={save.isPending || !open}
            options={[
              { value: "upload", label: "上传本地文件" },
              { value: "fetch", label: "读取 HTTPS 文件并接纳" },
            ]}
            onValueChange={(value) => {
              if (value !== undefined && !submitting.current && open) {
                setMode(value);
                setError(null);
              }
            }}
          />
        </label>
        {initial?.canRefresh && mode === "upload" && (
          <p className="muted text-sm text-muted-foreground">
            改用本地文件后，后续通过上传文件更新。若需继续从原地址更新，请返回资源列表选择“刷新文件”。
          </p>
        )}
        {mode === "upload" ? (
          <div className="grid min-w-0 gap-2">
            <ActionButton
              className="justify-self-start"
              variant="outline"
              aria-controls={`${formId}-file`}
              aria-describedby={`${formId}-selection`}
              disabled={save.isPending || !open}
              onClick={() => fileInput.current?.click()}
            >
              选择规则文件
            </ActionButton>
            <input
              ref={fileInput}
              id={`${formId}-file`}
              hidden
              type="file"
              aria-label="选择规则文件"
              disabled={save.isPending || !open}
              onChange={(e) => {
                if (submitting.current || !active.current || !open) return;
                const selected = e.target.files?.[0];
                // A canceled picker is not a request to discard the prior choice.
                if (!selected) return;
                e.target.value = "";
                setFileSelected(true);
                if (selected.size === 0 || selected.size > 8 * 1024 ** 2) {
                  setError(new Error("规则文件必须为 1 字节至 8 MiB。"));
                  setFile(null);
                  return;
                }
                setFile(selected);
                setError(null);
              }}
            />
            <div id={`${formId}-selection`} role="status" className="grid gap-1 text-sm text-muted-foreground wrap-anywhere">
              {file ? <><span>{file.name}</span><span>{bytesLabel(file.size)}</span></> : "尚未选择文件"}
            </div>
          </div>
        ) : (
          <>
            <AppField
              name="url"
              label="导入文件 HTTPS 地址"
              rules={[
                { required: true },
                { pattern: /^https:\/\//, message: "请输入 HTTPS 文件地址" },
              ]}
            >
              <Input autoComplete="off" placeholder="https://…" />
            </AppField>
            <p className="muted text-sm text-muted-foreground">
              保存时由平台读取一次文件并保存私有副本。读取地址仅保存在平台，文件内容随客户端配置包交付。
            </p>
          </>
        )}
        {mode === "upload" && fileSelected && (
          <ActionButton
            variant="outline"
            disabled={save.isPending || !open}
            onClick={() => {
              if (submitting.current || !active.current || !open) return;
              setFile(null);
              setFileSelected(false);
              setError(null);
            }}
          >
            清除文件选择
          </ActionButton>
        )}
        <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
          <AppField
            name="format"
            label="导入文件格式"
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
            label="配置引用策略"
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={[
                { value: "pinned", label: "固定这次接纳的版本" },
                { value: "follow", label: "跟随以后明确接纳的版本" },
              ]}
            />
          </AppField>
        </div>
        <p className="muted text-sm text-muted-foreground">
          文件最多 8
          MiB，先检查文件封装与完整性。客户端兼容性仍需在配置预览中核对；引用此文件的输出以配置包交付。
        </p>
        <Accordion ref={disclosure} type="multiple">
          {[
            {
              key: "pin",
              label: "可选：核对预期文件校验值",
              children: (
                <AppField
                  name="digest"
                  label="预期 SHA-256"
                  rules={[
                    {
                      pattern: /^(sha256:)?[a-fA-F0-9]{64}$/,
                      message: "请输入 64 位 SHA-256",
                    },
                  ]}
                >
                  <Input placeholder="留空由服务器计算；填写后不一致会拒绝导入" />
                </AppField>
              ),
            },
          ].map((section) => (
            <AccordionItem
              key={section.key}
              value={String(section.key)}
              disabled={
                (save.isPending ? "disabled" : undefined) === "disabled" ||
                ("collapsible" in section && section.collapsible === "disabled")
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
        <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
          <ActionButton
            disabled={save.isPending || !open}
            onClick={close}
            variant="outline"
          >
            取消
          </ActionButton>
          <ActionButton
            ref={submitButton}
            keepFocusableWhilePending
            type="submit"
            disabled={!open}
            aria-label={mode === "upload" ? "导入并保存文件" : "读取并接纳文件"}
            aria-busy={save.isPending}
            variant="default"
            pending={!!save.isPending}
          >
            {mode === "upload" ? "导入并保存文件" : "读取并接纳文件"}
          </ActionButton>
        </div>
      </AppForm>
    </TaskDialog>
  );
}
