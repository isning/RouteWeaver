import { ContextLayout, PageSection, SectionIndex } from "@/ui-patterns/page-layout";
import { BackupCapacity } from "./BackupCapacity";
import { PasswordInput } from "@/ui-patterns/password-input";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { DataTable } from "./DataTable";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { toast } from "sonner";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { Download as DownloadOutlined, LoaderCircle as LoadingOutlined, Upload as UploadOutlined } from "lucide-react";
import { wrapPublicationModalTab } from "./publication-modal-focus";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BackupRestoreError, postArchive, requestFile, restoreArchive, type BackupRestoreResult, } from "./api";
import { ErrorNotice, Section } from "./components";
import { bytesLabel, dateLabel } from "./model";
interface BackupPreview {
    manifest: {
        format: string;
        version: number;
        schemaVersion: number;
        createdAt: string;
        records: number;
        identities: number;
        tokens: number;
        counters: number;
        containsSecrets: boolean;
    };
    digest: string;
    counts: Record<string, number>;
    impact: {
        mode: string;
        replacesLiveStore: boolean;
        includesSecrets: boolean;
        requiresRestart: boolean;
    };
    restoreAvailable: boolean;
}
const backupKindLabels = new Map<string, string>([
    ["records", "记录"],
    ["users", "用户"],
    ["sources", "来源"],
    ["collections", "集合"],
    ["profiles", "分流配置"],
    ["outputs", "客户端订阅"],
]);
const restoreConfirmationPhrase = "恢复到新数据库";
export function BackupSettings() {
  const sectionID = useId();
    const fileInputID = useId();
    const fileDescriptionID = useId();
    const uploadDescriptionID = useId();
    const fileInput = useRef<HTMLInputElement | null>(null);
    const revision = useRef(0);
    const activeInspection = useRef<number | null>(null);
    const inspectionSubmission = useRef<{
        version: number;
        password: string;
        file: File;
    } | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [form] = useForm();
    const [file, setFile] = useState<File | null>(null);
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [preview, setPreview] = useState<BackupPreview | null>(null);
    const [fileError, setFileError] = useState<Error | null>(null);
    const [result, setResult] = useState<BackupRestoreResult | null>(null);
    const nextAttempt = useRef(0);
    const activeAttempt = useRef<number | null>(null);
    // One transient submission snapshot; credentials never enter mutation cache.
    const submission = useRef<{
        id: number;
        password: string;
        digest: string;
        confirmation: string;
        file: File;
    } | null>(null);
    const [unresolved, setUnresolved] = useState<{
        id: number;
        target?: string;
    } | null>(null);
    const [reviewed, setReviewed] = useState<{
        id: number;
        target?: string;
    } | null>(null);
    const [restoreError, setRestoreError] = useState<Error | null>(null);
    useEffect(() => () => {
        activeAttempt.current = null;
        submission.current = null;
        activeInspection.current = null;
        inspectionSubmission.current = null;
    }, []);
    const message = toast;
    const create = useMutation({
        mutationFn: (values: {
            password: string;
        }) => requestFile("/admin/backups", { password: values.password }),
        onSuccess: (blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `routeweaver-${new Date().toISOString().slice(0, 10)}.age`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            form.resetFields();
            setCreateOpen(false);
            message.success("加密备份已准备好，请保管好文件和密码");
        },
    });
    const inspect = useMutation({
        mutationFn: async ({ version }: {
            version: number;
        }) => {
            const snapshot = inspectionSubmission.current;
            inspectionSubmission.current = null;
            if (!snapshot ||
                snapshot.version !== version ||
                activeInspection.current !== version) {
                throw new Error("备份校验已失效，未发送请求。");
            }
            return {
                value: await postArchive<BackupPreview>("/admin/backups/preview", { password: snapshot.password }, snapshot.file),
                version,
            };
        },
        onSuccess: ({ value, version }) => {
            if (version !== revision.current || activeInspection.current !== version)
                return;
            setPreview(value);
            setResult(null);
        },
        onSettled: (_value, _error, { version }) => {
            if (activeInspection.current === version)
                activeInspection.current = null;
        },
    });
    const restore = useMutation({
        retry: false,
        mutationFn: ({ id }: {
            id: number;
            version: number;
        }) => {
            const snapshot = submission.current;
            submission.current = null;
            if (!snapshot || snapshot.id !== id || activeAttempt.current !== id) {
                throw new Error("恢复提交已失效，未发送请求。");
            }
            return restoreArchive({
                password: snapshot.password,
                digest: snapshot.digest,
                confirmation: snapshot.confirmation,
            }, snapshot.file);
        },
        onSuccess: (value, attempt) => {
            if (activeAttempt.current !== attempt.id)
                return;
            activeAttempt.current = null;
            // An authoritative target belongs to the attempt, not the current draft.
            setResult(value);
            setRestoreError(null);
            if (attempt.version !== revision.current)
                return;
            setPassword("");
            setFile(null);
            if (fileInput.current)
                fileInput.current.value = "";
            setPreview(null);
            setConfirmation("");
        },
        onError: (error, attempt) => {
            if (activeAttempt.current !== attempt.id)
                return;
            activeAttempt.current = null;
            const knownFailure = error instanceof BackupRestoreError &&
                error.outcome === "not_published";
            setRestoreError(knownFailure ? error : null);
            if (!knownFailure) {
                setUnresolved({
                    id: attempt.id,
                    target: error instanceof BackupRestoreError ? error.target : undefined,
                });
                setConfirmation("");
            }
        },
    });
    const beginRestore = () => {
        if (activeAttempt.current !== null ||
            activeInspection.current !== null ||
            !preview ||
            !file ||
            confirmation !== restoreConfirmationPhrase ||
            unresolved)
            return;
        const id = ++nextAttempt.current;
        activeAttempt.current = id;
        setRestoreError(null);
        setResult(null);
        submission.current = {
            id,
            password,
            digest: preview.digest,
            confirmation: "RESTORE TO NEW STORE",
            file,
        };
        restore.mutate({ id, version: revision.current });
    };
    const selectFile = (value: File | undefined) => {
        if (activeAttempt.current !== null)
            return;
        revision.current++;
        setPreview(null);
        setResult(null);
        setConfirmation("");
        setFileError(null);
        setFile(value || null);
        if (value && value.size > 1024 ** 3) {
            setFileError(new Error("备份文件超过 1 GiB，无法在当前上传上限内校验。"));
        }
    };
    return (<div className="grid gap-6" role="region" aria-label="备份与恢复">
      <ContextLayout
        contentKind="settings"
        navigation
        rail={
          <SectionIndex
            label="本页备份任务"
            sections={[
              { id: `${sectionID}-backup-export`, label: "完整加密备份" },
              { id: `${sectionID}-backup-restore`, label: "恢复备份" },
            ]}
          />
        }
      >
      <PageSection id={`${sectionID}-backup-export`} label="完整加密备份设置">
      <Section title="完整加密备份" description="加密下载账号、配置、历史及恢复凭据。">
        <BackupCapacity primaryAction={
          <ActionButton leadingIcon={<DownloadOutlined aria-hidden="true"/>} onClick={() => {
            create.reset();
            form.resetFields();
            setCreateOpen(true);
        }} variant="default">
            创建加密备份
          </ActionButton>
        } />
      </Section>
      </PageSection>
      <PageSection id={`${sectionID}-backup-restore`} label="恢复备份设置">
      <Section title="恢复备份" description="恢复到新数据库，不覆盖当前数据，也不会自动切换服务。">
        <div className="settings-form backup-restore-form max-w-[38.75rem] space-y-5">
          <ErrorNotice error={fileError || inspect.error}/>
          <ErrorNotice error={restoreError}/>
          {unresolved && (<Notice tone="warning" title="恢复结果尚未确认">{<>
                  <p>
                    新数据库可能已创建。再次恢复前，请确认上次操作已结束，并检查恢复目录。
                  </p>
                  {unresolved.target && (<p className="[overflow-wrap:anywhere]">
                      待检查目标：{unresolved.target}
                    </p>)}
                  <ActionButton className="h-auto max-w-full whitespace-normal" disabled={restore.isPending} onClick={() => {
                    if (activeAttempt.current !== null)
                        return;
                    revision.current++;
                    setReviewed(unresolved);
                    setUnresolved(null);
                    setPreview(null);
                    setConfirmation("");
                }} variant="outline">
                    已检查，允许再次恢复
                  </ActionButton>
                </>}</Notice>)}
          {reviewed && (<details className="my-4 space-y-3 rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">此前恢复的人工检查记录</summary>
              <p>
                你已确认上次操作结束，并检查了恢复目录；恢复结果未经系统确认。
              </p>
              {reviewed.target && (<p className="[overflow-wrap:anywhere]">
                  此前检查的目标：{reviewed.target}
                </p>)}
            </details>)}
          {result && (<Notice className="mb-5" tone="success" title="已恢复到新数据库，尚未启用">{`目标：${result.target}。由运维人员停止服务后选择该数据库启动；当前服务未切换。`}</Notice>)}
          <div className="standalone-label grid gap-2 text-sm font-medium">
            <label htmlFor={fileInputID}>加密备份文件</label>
            <input id={fileInputID} ref={fileInput} type="file" hidden accept=".age,application/octet-stream" aria-label="选择加密备份" aria-describedby={fileDescriptionID} disabled={restore.isPending} onChange={(e) => selectFile(e.target.files?.[0])}/>
            <ActionButton className="backup-file-trigger w-full sm:w-auto sm:justify-self-start" disabled={restore.isPending} aria-controls={fileInputID} aria-describedby={fileDescriptionID} onClick={() => fileInput.current?.click()} variant="outline">
              选择备份文件
            </ActionButton>
            <span id={fileDescriptionID} className="[overflow-wrap:anywhere]">
              {file ? `${file.name} · ${bytesLabel(file.size)}` : "未选择文件"}
            </span>
          </div>
          <label className="standalone-label grid gap-2 text-sm font-medium">
            备份密码
            <PasswordInput value={password} disabled={restore.isPending} autoComplete="off" onChange={(e) => {
            if (activeAttempt.current !== null)
                return;
            revision.current++;
            setPassword(e.target.value);
            setPreview(null);
            setConfirmation("");
        }}/>
          </label>
          <p id={uploadDescriptionID} className="text-sm text-muted-foreground">
            选择文件不会上传；校验时会将备份文件和密码发送到当前控制平面。
          </p>
          <ActionButton leadingIcon={<UploadOutlined aria-hidden="true"/>} aria-describedby={uploadDescriptionID} aria-label="校验备份并查看影响" aria-busy={inspect.isPending} pending={inspect.isPending} disabled={!file || !!fileError || !password || restore.isPending} onClick={() => {
            if (activeAttempt.current !== null ||
                activeInspection.current !== null ||
                !file ||
                !password ||
                fileError)
                return;
            const version = ++revision.current;
            activeInspection.current = version;
            inspectionSubmission.current = { version, password, file };
            restore.reset();
            setRestoreError(null);
            inspect.mutate({ version });
        }} variant="outline">
            校验备份并查看影响
          </ActionButton>
          {(file || password) && (<ActionButton disabled={restore.isPending} onClick={() => {
                if (activeAttempt.current !== null)
                    return;
                revision.current++;
                setPassword("");
                setFile(null);
                setPreview(null);
                setConfirmation("");
                setFileError(null);
                inspect.reset();
                restore.reset();
                setRestoreError(null);
                if (fileInput.current)
                    fileInput.current.value = "";
            }} variant="ghost">
              清空备份输入
            </ActionButton>)}
          {preview && (<div className="backup-preview space-y-4 border-t pt-4">
              <p role="status">文件校验通过</p>
              <div className="key-value flex flex-wrap justify-between gap-x-6 gap-y-1 text-sm">
                <span>备份时间</span>
                <strong>{dateLabel(preview.manifest.createdAt)}</strong>
              </div>
              <details className="my-4 space-y-3 rounded-lg border p-3 text-sm">
                <summary className="cursor-pointer font-medium">备份详情</summary>
                <div className="key-value flex flex-wrap justify-between gap-x-6 gap-y-1 text-sm">
                  <span>数据版本</span>
                  <strong>{preview.manifest.schemaVersion}</strong>
                </div>
                <DataTable rowKey="kind" rows={Object.entries(preview.counts).map(([kind, count]) => ({ kind, count }))} columns={[
                {
                    title: "内容",
                    accessor: "kind",
                    render: (kind: string) => backupKindLabels.get(kind) ?? kind,
                },
                { title: "记录数", accessor: "count" },
            ]} pageSize={0} compact/>
              </details>
              {!preview.restoreAvailable ? (<Notice tone="warning" title="当前环境未开放恢复写入">{"\u5907\u4EFD\u5DF2\u9A8C\u8BC1\uFF0C\u53EF\u4EE5\u7531\u8FD0\u7EF4\u4EBA\u5458\u5728\u914D\u7F6E\u597D\u7684\u6062\u590D\u76EE\u5F55\u6267\u884C\u4E0B\u4E00\u6B65\u3002"}</Notice>) : (<>
                  <p>
                    备份包含当时的账号、二次验证、会话与订阅凭据。启用前，请复核备份后撤销过的权限和凭据。
                  </p>
                  <label className="standalone-label mt-5 grid gap-2 text-sm font-medium">
                    {`输入“${restoreConfirmationPhrase}”以确认`}
                    <Input value={confirmation} disabled={restore.isPending} onChange={(e) => {
                    if (activeAttempt.current !== null)
                        return;
                    setConfirmation(e.target.value);
                }} autoComplete="off"/>
                  </label>
                  <ActionButton disabled={confirmation !== restoreConfirmationPhrase ||
                    inspect.isPending ||
                    !!unresolved} aria-label="恢复到新数据库" aria-busy={restore.isPending} pending={restore.isPending} onClick={beginRestore} variant="default">
                    恢复到新数据库
                  </ActionButton>
                </>)}
            </div>)}
        </div>
      </Section>
      </PageSection>
      </ContextLayout>
      <TaskDialog title="创建加密备份" open={createOpen} footer={null} onOpenChange={open => {
            if (!open)
                (() => {
                    if (create.isPending)
                        return;
                    setCreateOpen(false);
                    form.resetFields();
                })();
        }} pending={!(!create.isPending)} contentProps={{ onFocusCapture: revealFocusedPolicyModalControl }}>
        <AppForm form={form} disabled={create.isPending} onFinish={(values) => create.mutate(values)}>
          <ErrorNotice error={create.error}/>
          <AppField name="password" label="设置备份密码" rules={[
            {
                required: true,
                min: 12,
                message: "请使用至少 12 个字符的独立密码",
            },
        ]}>
            <PasswordInput autoComplete="new-password" maxLength={1024}/>
          </AppField>
          <AppField name="confirm" label="再次输入密码" dependencies={["password"]} rules={[
            { required: true },
            ({ getFieldValue }) => ({
                validator: (_, value) => value === getFieldValue("password")
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次输入的密码不一致")),
            }),
        ]}>
            <PasswordInput autoComplete="new-password"/>
          </AppField>
          <p className="muted text-sm text-muted-foreground">
            备份包含账号与订阅凭据，仅下载到你的设备，不发送到第三方。请将文件与密码分开保管；忘记密码无法恢复。
          </p>
          <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <ActionButton disabled={create.isPending} onClick={() => {
            setCreateOpen(false);
            form.resetFields();
        }} variant="outline">
              取消
            </ActionButton>
            <ActionButton type="submit" aria-label="加密并下载" aria-busy={create.isPending} pending={create.isPending} variant="default">
              加密并下载
            </ActionButton>
          </div>
        </AppForm>
      </TaskDialog>
    </div>);
}
