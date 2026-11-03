import { ContextLayout, PageSection, SectionIndex } from "@/ui-patterns/page-layout";
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PageBoundary } from "./PageBoundary";
import { LoadingState } from "@/ui-patterns/loading-state";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PasswordInput } from "@/ui-patterns/password-input";
import { AppField, AppForm, useForm, useWatch } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { useConfirm } from "@/ui-patterns/confirmations";
import { ErrorNotice, PageHeader, QueryState, Section } from "./components";
import { APIError, list, post, request } from "./api";
import { dateLabel } from "./model";
import { useUnsavedChanges } from "./navigation";
import type { Session } from "./types";

type Props = {
  session: Session;
  onSessionChanged: (session: Session) => void;
  onSignedOut: () => void;
  mfaSettings?: ReactNode;
};
function securityError(error: Error | null) {
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message === "invalid credentials"
  )
    return new Error("当前密码或验证码不正确，请核对后重试。");
  if (
    error instanceof APIError &&
    error.message === "local browser session required"
  )
    return new Error(
      "请使用账号密码登录后管理账号安全；管理员令牌不能执行此操作。",
    );
  return error;
}
type ActiveSession = { id: string; expiresAt: string; current: boolean };
const passwordRule = {
  validator: (_rule: unknown, value: string) => {
    const bytes = new TextEncoder().encode(value || "").length;
    return bytes >= 12 && bytes <= 72
      ? Promise.resolve()
      : Promise.reject(
          new Error("密码须为 12–72 个 UTF-8 字节（中文通常每字 3 字节）。"),
        );
  },
};
function Reauthentication({
  mfa,
  prefix = "",
}: {
  mfa?: boolean;
  prefix?: string;
}) {
  return (
    <>
      <AppField
        name="currentPassword"
        label={`${prefix}当前密码`}
        rules={[{ required: true }]}
      >
        <PasswordInput autoComplete="current-password" />
      </AppField>
      {mfa && (
        <AppField
          name="totp"
          label={
            prefix === "验证" ? "退出其他会话的验证码" : `${prefix}验证器验证码`
          }
          description="使用尚未用于登录或其他操作的新验证码。"
          rules={[
            { required: true },
            { pattern: /^\d{6}$/, message: "输入六位验证码" },
          ]}
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
        </AppField>
      )}
    </>
  );
}
export function AccountSecurityPage(props: Props) {
  return <AccountSecurityTask key={props.session.user.id} {...props} />;
}
function AccountSecurityTask({
  session,
  onSessionChanged,
  onSignedOut,
  mfaSettings,
}: Props) {
  const client = useQueryClient();
  const sectionID = useId();
  const confirm = useConfirm();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [form] = useForm();
  const [revokeForm] = useForm();
  const [dirty, setDirty] = useState(false);
  const [revokeDirty, setRevokeDirty] = useState(false);
  const submitting = useRef(false);
  const sessions = useQuery({
    queryKey: ["account-sessions", session.user.id],
    queryFn: () => list<ActiveSession>("/auth/sessions"),
  });
  const changePassword = useMutation({
    mutationFn: (values: {
      currentPassword: string;
      newPassword: string;
      totp?: string;
    }) => post<Session>("/auth/password", values),
    onSuccess: (next) => {
      if (!active.current) return;
      form.resetFields();
      setDirty(false);
      // The session owner adopts the rotated credentials and refreshes private
      // queries only after committing the new transport generation.
      onSessionChanged(next);
      toast.success("密码已修改，其他会话已退出");
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const revokeOthers = useMutation({
    mutationFn: (values: { currentPassword: string; totp?: string }) =>
      post("/auth/sessions/revoke-others", values),
    onSuccess: () => {
      if (!active.current) return;
      revokeForm.resetFields();
      setRevokeDirty(false);
      client.invalidateQueries({ queryKey: ["account-sessions"] });
      toast.success("其他会话已退出");
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      request<{ current: boolean }>(
        `/auth/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (result) => {
      if (!active.current) return;
      if (result.current) onSignedOut();
      else {
        client.invalidateQueries({ queryKey: ["account-sessions"] });
        toast.success("会话已退出");
      }
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const pending =
    changePassword.isPending || revokeOthers.isPending || revoke.isPending;
  useUnsavedChanges(dirty || revokeDirty || pending);
  return (
    <>
      <PageHeader title="账号安全" />
      {session.user.passwordChangeRequired && (
        <Notice tone="warning" title="请先更换临时密码">
          管理员已重置你的密码。更换后才能继续访问订阅和其他工作区内容。
        </Notice>
      )}
      <ContextLayout
        navigation
        rail={
          <SectionIndex
            label="本页账号设置"
            sections={[
              { id: `${sectionID}-account-password`, label: "修改密码" },
              { id: `${sectionID}-account-sessions`, label: "登录会话" },
              ...(session.user.role === "admin" && !session.user.passwordChangeRequired
                ? [{ id: `${sectionID}-account-recovery`, label: "账号恢复与退役" }]
                : []),
              ...(mfaSettings
                ? [{ id: `${sectionID}-account-mfa`, label: "管理员二次验证" }]
                : []),
            ]}
          />
        }
      >
      <PageSection id={`${sectionID}-account-password`} label="修改密码设置">
      <Section title="修改密码">
        <AppForm
          form={form}
          disabled={pending}
          onValuesChange={() => setDirty(true)}
          onFinish={(values) => {
            if (submitting.current || pending) return;
            submitting.current = true;
            changePassword.mutate({
              currentPassword: values.currentPassword,
              newPassword: values.newPassword,
              ...(values.totp ? { totp: values.totp } : {}),
            });
          }}
        >
          <ErrorNotice error={securityError(changePassword.error)} />
          <Reauthentication mfa={session.user.mfaEnabled} />
          <AppField
            name="newPassword"
            label="新密码"
            description="使用 12–72 个 UTF-8 字节；中文通常每字占 3 字节。"
            rules={[{ required: true }, passwordRule]}
          >
            <PasswordInput autoComplete="new-password" />
          </AppField>
          <AppField
            name="confirmation"
            label="确认新密码"
            dependencies={["newPassword"]}
            rules={[
              { required: true },
              {
                validator: (_rule, value) =>
                  value === form.getFieldValue("newPassword")
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次输入的新密码不一致")),
              },
            ]}
          >
            <PasswordInput autoComplete="new-password" />
          </AppField>
          <p className="text-sm text-muted-foreground">
            修改后保留当前会话，其他会话立即失效。已下载的连接凭据不会因此从节点撤销。
          </p>
          <ActionButton
            type="submit"
            pending={changePassword.isPending}
            disabled={pending && !changePassword.isPending}
          >
            修改密码
          </ActionButton>
        </AppForm>
      </Section>
      </PageSection>
      <PageSection id={`${sectionID}-account-sessions`} label="登录会话设置">
      <Section
        title="登录会话"
        extra={
          <ActionButton
            variant="outline"
            onClick={() => sessions.refetch()}
            disabled={pending}
          >
            刷新会话
          </ActionButton>
        }
      >
        <ErrorNotice error={revoke.error} />
        <QueryState
          loading={sessions.isPending} paused={sessions.isPaused} loadingLayout="table"
          error={securityError(sessions.error)}
          retry={() => sessions.refetch()}
        >
          {sessions.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">没有有效会话。</p>
          )}
          <ul className="divide-y rounded-lg border">
            {sessions.data?.map((entry, index) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0 space-y-1">
                  <strong className="text-sm">
                    {entry.current ? "当前会话" : `其他会话 ${index + 1}`}
                  </strong>
                  <p className="text-sm text-muted-foreground">
                    到期时间：{dateLabel(entry.expiresAt)}
                  </p>
                  <details className="text-xs text-muted-foreground">
                    <summary>会话标识</summary>
                    <span className="break-all">{entry.id}</span>
                  </details>
                </div>
                <ActionButton
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    confirm({
                      title: entry.current
                        ? "退出当前会话？"
                        : "退出所选会话？",
                      description: entry.current
                        ? "当前页面将返回登录。未保存的输入将丢失。"
                        : `此会话将立即失效，其他会话不受影响。到期时间：${dateLabel(entry.expiresAt)}。会话标识：${entry.id}`,
                      confirmLabel: "退出会话",
                      cancelLabel: "保留",
                      destructive: true,
                      onConfirm: async () => {
                        if (!active.current || submitting.current) return;
                        submitting.current = true;
                        await revoke.mutateAsync(entry.id);
                      },
                    })
                  }
                >
                  {entry.current ? "退出当前会话" : "退出此会话"}
                </ActionButton>
              </li>
            ))}
          </ul>
        </QueryState>
        <AppForm
          form={revokeForm}
          disabled={pending}
          className="mt-6 space-y-5 border-t pt-5"
          onValuesChange={() => setRevokeDirty(true)}
          onFinish={(values) => {
            if (pending || submitting.current) return;
            submitting.current = true;
            revokeOthers.mutate(values);
          }}
        >
          <h3 className="text-sm font-medium">退出其他所有会话</h3>
          <ErrorNotice error={securityError(revokeOthers.error)} />
          <Reauthentication mfa={session.user.mfaEnabled} prefix="验证" />
          <p className="text-sm text-muted-foreground">
            其他浏览器会话将立即失效，当前会话保留；不会撤销已下载的连接凭据。
          </p>
          <ActionButton
            type="submit"
            variant="outline"
            pending={revokeOthers.isPending}
            disabled={pending && !revokeOthers.isPending}
          >
            退出其他所有会话
          </ActionButton>
        </AppForm>
      </Section>
      </PageSection>
      {session.user.role === "admin" &&
        !session.user.passwordChangeRequired && (
          <PageSection id={`${sectionID}-account-recovery`} label="账号恢复与退役设置">
            <AccountRecovery session={session} />
          </PageSection>
        )}
      {mfaSettings && (
        <PageSection id={`${sectionID}-account-mfa`} label="管理员二次验证设置">
          <PageBoundary>
            <Suspense
              fallback={
                <LoadingState layout="form" label="正在加载二次验证设置" />
              }
            >
              {mfaSettings}
            </Suspense>
          </PageBoundary>
        </PageSection>
      )}
      </ContextLayout>
    </>
  );
}

type Account = Session["user"] & {
  username: string;
  disabled: boolean;
  retired: boolean;
};
type SecurityAction =
  "disable" | "enable" | "retire" | "reset-password" | "reset-mfa";
const actions: Record<SecurityAction, { label: string; consequence: string }> =
  {
    disable: {
      label: "停用账号",
      consequence:
        "立即阻止登录和订阅链接交付，并退出目标账号的所有会话。保留数据和服务授权配置；已下载的节点凭据不会从节点撤销。",
    },
    enable: {
      label: "恢复账号",
      consequence:
        "解除账号停用限制。服务授权仍按原配置判断，不会自动开启已停用的服务或恢复旧会话。",
    },
    retire: {
      label: "永久退役账号",
      consequence:
        "永久阻止登录和订阅链接交付，并退出所有会话。账号不能重新启用；历史数据保留，已下载的节点凭据仍需在节点另行撤销。",
    },
    "reset-password": {
      label: "重置账号密码",
      consequence:
        "退出目标账号的所有会话。对方下次登录必须更换临时密码；请通过你确认安全的渠道单独交付临时密码。此操作不会发送消息，也不会解除账号停用或二次验证。",
    },
    "reset-mfa": {
      label: "重置二次验证",
      consequence:
        "移除目标账号的二次验证并退出所有会话。密码保持不变；请先核实账号持有人的身份，再让对方重新设置验证器。",
    },
  };
function AccountRecovery({ session }: { session: Session }) {
  const accounts = useQuery({
    queryKey: ["security-accounts"],
    queryFn: () => list<Account>("/admin/accounts"),
  });
  const [target, setTarget] = useState<Account | null>(null);
  return (
    <Section
      title="账号恢复与退役"
      description="账号身份与用户的服务授权是两套设置。停用或退役会阻止登录和订阅交付，不会删除历史数据。"
    >
      <QueryState
        loading={accounts.isPending} paused={accounts.isPaused} loadingLayout="table"
        error={securityError(accounts.error)}
        retry={() => accounts.refetch()}
      >
        {accounts.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">没有账号记录。</p>
        )}
        <ul className="divide-y rounded-lg border">
          {accounts.data?.map((account) => (
            <li
              key={account.id}
              aria-label={account.name}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="min-w-0 space-y-1">
                <strong className="break-words text-sm">{account.name}</strong>
                <p className="break-all text-sm text-muted-foreground">
                  {account.username} ·{" "}
                  {account.role === "admin" ? "管理员" : "个人账号"}
                </p>
                <Badge variant="secondary">
                  {account.retired
                    ? "已永久退役"
                    : account.disabled
                      ? "已停用"
                      : account.passwordChangeRequired
                        ? "须更换密码"
                        : "可登录"}
                </Badge>
                {account.id === session.user.id && (
                  <p className="text-xs text-muted-foreground">
                    当前账号，请使用上方安全设置。
                  </p>
                )}
              </div>
              <ActionButton
                variant="outline"
                aria-label={`管理 ${account.name}`}
                disabled={account.id === session.user.id || account.retired}
                onClick={() => setTarget(account)}
              >
                管理账号
              </ActionButton>
            </li>
          ))}
        </ul>
      </QueryState>
      {target && (
        <AccountRecoveryTask
          key={target.id}
          target={target}
          actor={session.user}
          onClose={() => setTarget(null)}
        />
      )}
    </Section>
  );
}
function AccountRecoveryTask({
  target,
  actor,
  onClose,
}: {
  target: Account;
  actor: Session["user"];
  onClose: () => void;
}) {
  const [form] = useForm();
  const formId = useId();
  const action: SecurityAction =
    useWatch("action", form) || (target.disabled ? "enable" : "disable");
  const [dirty, setDirty] = useState(false);
  const { confirm, confirming } = useDiscardConfirmation(target.id);
  const active = useRef(true),
    submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (value: {
      action: SecurityAction;
      reason: string;
      currentPassword: string;
      totp?: string;
      newPassword?: string;
    }) =>
      post<Account>(
        `/admin/accounts/${encodeURIComponent(target.id)}/security`,
        value,
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["security-accounts"] });
      if (!active.current) return;
      form.resetFields();
      setDirty(false);
      toast.success("账号安全设置已更新");
      onClose();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  useUnsavedChanges(dirty || save.isPending);
  const close = () => {
    if (save.isPending || submitting.current || confirming) return;
    if (!dirty) return onClose();
    confirm(
      {
        title: "放弃未提交的账号操作？",
        description: "当前输入尚未提交，目标账号未因这些输入而改变。",
        confirmLabel: "放弃输入",
        cancelLabel: "继续编辑",
      },
      () => {
        if (active.current) onClose();
      },
    );
  };
  const options: SecurityAction[] = [
    target.disabled ? "enable" : "disable",
    "reset-password",
    ...(target.mfaEnabled ? ["reset-mfa" as const] : []),
    "retire",
  ];
  return (
    <TaskDialog
      scrollMode="auto"
      open
      title={`管理账号 · ${target.name}`}
      description={`登录名：${target.username}`}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      pending={save.isPending}
      footer={
        <div className="w-full space-y-3">
          <p className="text-sm text-muted-foreground">
            {actions[action].consequence}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton variant="outline" onClick={close}>
              取消
            </ActionButton>
            <ActionButton
              type="submit"
              form={formId}
              variant={action === "enable" ? "default" : "destructive"}
              pending={save.isPending}
            >
              {actions[action].label}
            </ActionButton>
          </div>
        </div>
      }
    >
      <AppForm
        id={formId}
        form={form}
        initialValues={{ action }}
        disabled={save.isPending}
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => {
          if (!active.current || submitting.current) return;
          submitting.current = true;
          save.mutate({
            action,
            reason: values.reason,
            currentPassword: values.currentPassword,
            ...(values.totp ? { totp: values.totp } : {}),
            ...(action === "reset-password"
              ? { newPassword: values.newPassword }
              : {}),
          });
        }}
      >
        <ErrorNotice error={securityError(save.error)} />
        <AppField name="action" label="账号操作" trigger="onValueChange">
          <ChoiceSelect
            options={options.map((value) => ({
              value,
              label: actions[value].label,
            }))}
          />
        </AppField>
        {action === "reset-password" && (
          <AppField
            name="newPassword"
            label="临时密码"
            description="使用 12–72 个 UTF-8 字节；中文通常每字占 3 字节。"
            rules={[{ required: true }, passwordRule]}
          >
            <PasswordInput autoComplete="new-password" />
          </AppField>
        )}
        {action === "retire" && (
          <AppField
            name="confirmTarget"
            label="输入登录名以确认永久退役"
            rules={[
              { required: true },
              {
                validator: (_rule, value) =>
                  value === target.username
                    ? Promise.resolve()
                    : Promise.reject(new Error("登录名不匹配")),
              },
            ]}
          >
            <Input autoComplete="off" />
          </AppField>
        )}
        <AppField
          name="reason"
          label="操作原因"
          rules={[
            { required: true },
            {
              validator: (_rule, value) => {
                const bytes = new TextEncoder().encode(
                  (value || "").trim(),
                ).length;
                return bytes >= 3 && bytes <= 500
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error("操作原因须为 3–500 个 UTF-8 字节"),
                    );
              },
            },
          ]}
        >
          <Input autoComplete="off" />
        </AppField>
        <Reauthentication mfa={actor.mfaEnabled} prefix="管理员" />
      </AppForm>
    </TaskDialog>
  );
}
