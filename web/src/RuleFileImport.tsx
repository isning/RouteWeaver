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
import { prepareFilePost } from "./api";
import { bytesLabel, newID } from "./model";
import type { RuleResource } from "./types";
import { ErrorNotice } from "./components";
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
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择。"));
    reader.readAsDataURL(file);
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
    [error, setError] = useState<Error | null>(null),
    [form] = useForm();
  const [initialValues] = useState(() => ({
    name: initial?.name || "",
    format: initial?.format || "mihomo-yaml",
    behavior: initial?.behavior || "domain",
    updatePolicy: initial?.updatePolicy || "pinned",
  }));
  const values = useWatch([], { form, preserve: true });
  const dirty =
    !!file ||
    mode !== "upload" ||
    (values !== undefined &&
      draftSnapshot(values) !== draftSnapshot(initialValues));
  const active = useRef(true);
  const submitting = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
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
    }: {
      values: Record<string, any>;
      mode: string;
      file: File | null;
    }) => {
      const postFile = prepareFilePost();
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
      return postFile<RuleResource>("/me/resources/import", {
        resource,
        ...(mode === "fetch"
          ? { fetch: true }
          : { contentBase64: await readFile(file!) }),
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["resources"] });
      if (!active.current) return;
      message.success("规则文件已接纳，发布配置时会一并打包");
      setOpen(false);
    },
    onError: (error) => {
      if (active.current) setError(error);
    },
  });
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
          });
        }}
      >
        <ErrorNotice error={error} />
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
            options={[
              { value: "upload", label: "上传本地文件" },
              { value: "fetch", label: "读取 HTTPS 文件并接纳" },
            ]}
            onValueChange={(value) => {
              if (value !== undefined) setMode(value);
            }}
          />
        </label>
        {initial?.canRefresh && mode === "upload" && (
          <p className="muted text-sm text-muted-foreground">
            改用本地文件后，后续通过上传文件更新。若需继续从原地址更新，请返回资源列表选择“刷新文件”。
          </p>
        )}
        {mode === "upload" ? (
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            选择规则文件
            <Input
              type="file"
              aria-label="选择规则文件"
              disabled={save.isPending || !open}
              onChange={(e) => {
                const selected = e.target.files?.[0] || null;
                if (
                  selected &&
                  (selected.size === 0 || selected.size > 8 * 1024 ** 2)
                ) {
                  setError(new Error("规则文件必须为 1 字节至 8 MiB。"));
                  setFile(null);
                  e.target.value = "";
                  return;
                }
                setFile(selected);
                setError(null);
              }}
            />
            {file && (
              <small className="grid gap-1 font-normal text-muted-foreground wrap-anywhere">
                <span>{file.name}</span>{" "}
                <span>{bytesLabel(file.size)}</span>
              </small>
            )}
          </label>
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
