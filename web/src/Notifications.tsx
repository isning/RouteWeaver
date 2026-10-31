import { PasswordInput } from "@/ui-patterns/password-input";
import { NumericInput } from "@/ui-patterns/numeric-input";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TaskSheet, TaskDialog } from "@/ui-patterns/task-overlays";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/ui-patterns/confirmations";
import { Switch } from "@/components/ui/switch";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import {
  Bell as BellOutlined,
  Plus as PlusOutlined,
  RotateCw as ReloadOutlined,
} from "lucide-react";
import { useUnsavedChanges } from "./navigation";
import { DataTable, TableRowActions } from "./DataTable";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { wrapPublicationModalTab as wrapAnnouncementModalTab } from "./publication-modal-focus";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { list, loadState, post, request, saveRecord } from "./api";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { dateLabel, newID } from "./model";
interface InboxItem {
  eventId: string;
  title: string;
  body: string;
  createdAt: string;
  expiresAt?: string;
  readAt?: string;
  kind: string;
}
interface Announcement {
  id: string;
  title: string;
  body: string;
  audience: "all" | "users" | "admins";
  userIds: string[];
  startsAt: string;
  expiresAt: string;
  enabled: boolean;
}
interface Settings {
  revision: number;
  inApp: boolean;
  quotaPercent: number[];
  expiryHours: number[];
  providerRemainingPercent: number[];
  repeatHours: number;
  email: {
    enabled: boolean;
    automatic: boolean;
    host: string;
    port: number;
    tlsMode: string;
    username: string;
    from: string;
    to: string[];
  };
  webhook: {
    enabled: boolean;
    automatic: boolean;
    url: string;
  };
  smtpPasswordSet: boolean;
  webhookSecretSet: boolean;
}
interface Delivery {
  eventId: string;
  kind: string;
  title: string;
  channel: string;
  status: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
}
const localDate = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function InboxPage() {
  const query = useQuery({
    queryKey: ["inbox"],
    queryFn: () => list<InboxItem>("/me/notifications"),
    refetchInterval: 60000,
  });
  const [selected, setSelected] = useState<InboxItem | null>(null);
  // Keep only presentation alive while the dismissed sheet animates out.
  const presentation = useRef<InboxItem | null>(null);
  useLayoutEffect(() => {
    if (selected) presentation.current = selected;
  }, [selected]);
  const displayed = selected || presentation.current;
  const client = useQueryClient();
  const read = useMutation({
    mutationFn: (id: string) => post(`/me/notifications/${id}/read`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["inbox"] }),
  });
  return (
    <>
      <PageHeader
        title="消息"
        description="查看服务公告与账号提醒。"
        action={
          <ActionButton
            leadingIcon={<ReloadOutlined aria-hidden="true" />}
            onClick={() => query.refetch()}
            variant="outline"
          >
            刷新
          </ActionButton>
        }
      />
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section>
          {!query.data?.length ? (
            <EmptyState
              title="暂无消息"
              description="有服务变更或提醒时会显示在这里。"
            />
          ) : (
            <div className="divide-y rounded-lg border">
              {query.data.map((item) => (
                <button
                  key={item.eventId}
                  className="flex w-full flex-wrap items-start gap-3 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setSelected(item);
                    if (!item.readAt) read.mutate(item.eventId);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-muted-foreground/30" : "bg-primary"}`}
                  />
                  <span className="min-w-0 flex-1 basis-48 space-y-1">
                    <strong className="block text-sm font-medium [overflow-wrap:anywhere]">{item.title}</strong>
                    <span className="line-clamp-2 block text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{item.body}</span>
                  </span>
                  <small className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground sm:flex-col sm:items-end">
                    <span>{item.readAt ? "已读" : "未读"}</span>
                    <time dateTime={item.createdAt}>
                      {dateLabel(item.createdAt)}
                    </time>
                  </small>
                </button>
              ))}
            </div>
          )}
        </Section>
      </QueryState>
      <TaskSheet
        title={displayed?.title}
        open={!!selected}
        contentProps={{ inert: !selected }}
        bodyProps={{ className: "space-y-4" }}
        onClosed={() => { if (!selected) presentation.current = null; }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) (() => setSelected(null))();
        }}
        size="lg"
      >
        <ErrorNotice error={read.error} />
        <p className="text-sm text-muted-foreground">
          {dateLabel(displayed?.createdAt)}
        </p>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {displayed?.body}
        </div>
        {displayed?.expiresAt && (
          <p className="text-sm text-muted-foreground">
            有效至 {dateLabel(displayed.expiresAt)}
          </p>
        )}
      </TaskSheet>
    </>
  );
}
export function NotificationsAdminPage() {
  const [activeSection, setSection] = useState("announcements");
  const [settingsVisited, setSettingsVisited] = useState(false);
  const sections = [
    { key: "announcements", label: "公告", children: <Announcements /> },
    {
      key: "settings",
      label: "提醒与渠道",
      children: <NotificationSettings />,
    },
    { key: "deliveries", label: "发送记录", children: <Outbox /> },
  ];
  return (
    <>
      <PageHeader
        title="公告与通知"
        description="管理公告、提醒渠道与发送记录。"
      />
      <Tabs
        value={activeSection}
        onValueChange={(next) => {
          setSection(next);
          if (next === "settings") setSettingsVisited(true);
        }}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          {sections.map((section) => (
            <TabsTrigger key={section.key} value={section.key}>
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {sections.map((section) => (
          <TabsContent
            key={section.key}
            value={section.key}
            forceMount={
              section.key === "settings" && settingsVisited ? true : undefined
            }
            hidden={section.key !== activeSection}
          >
            {section.children}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
function Announcements() {
  const formId = useId();
  const query = useQuery({
    queryKey: ["announcements"],
    queryFn: () => list<Announcement>("/admin/announcements"),
  });
  const users = useQuery({
    queryKey: ["announcement-users"],
    queryFn: loadState,
  });
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const editorTask = useRef<object | null>(null);
  const submitting = useRef<object | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      editorTask.current = null;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation(String(editorKey));
  const [form] = useForm();
  const audience = useWatch("audience", form);
  const client = useQueryClient();
  const message = toast;
  const save = useMutation({
    mutationFn: ({
      value,
      isNew,
    }: {
      value: Announcement;
      isNew: boolean;
      task: object;
    }) => saveRecord("admin/announcements", value, isNew),
    onSettled: (_data, _error, { task }) => {
      if (submitting.current === task) submitting.current = null;
    },
    onSuccess: (_data, { task }) => {
      client.invalidateQueries({ queryKey: ["announcements"] });
      client.invalidateQueries({ queryKey: ["inbox"] });
      if (!active.current || editorTask.current !== task) return;
      editorTask.current = null;
      setEditing(null);
      setDirty(false);
      message.success("公告安排已保存");
    },
  });
  useUnsavedChanges(!!editing && (dirty || save.isPending));
  const close = () => {
    if (!editing || submitting.current || save.isPending || confirming) return;
    const discard = () => {
      editorTask.current = null;
      setEditing(null);
      setDirty(false);
    };
    if (!dirty) return discard();
    confirm(
      {
        title: "放弃未保存的公告修改？",
        description: "当前公告修改尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: {
          onKeyDown: wrapAnnouncementModalTab,
          onFocusCapture: revealFocusedModalAction,
        },
      },
      discard,
    );
  };
  const edit = (item?: Announcement) => {
    if (submitting.current || save.isPending || confirming) return;
    editorTask.current = {};
    setEditorKey((key) => key + 1);
    const value = item || {
      id: newID("notice"),
      title: "",
      body: "",
      audience: "all" as const,
      userIds: [],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      enabled: true,
    };
    setEditing(value);
    setDirty(false);
    setIsNew(!item);
    form.resetFields();
    form.setFieldsValue({
      ...value,
      startsAt: localDate(value.startsAt),
      expiresAt: localDate(value.expiresAt),
    });
    save.reset();
  };
  return (
    <>
      <Section
        title="服务公告"
        extra={
          <ActionButton
            leadingIcon={<PlusOutlined aria-hidden="true" />}
            onClick={() => edit()}
            variant="default"
          >
            创建公告
          </ActionButton>
        }
      >
        <QueryState
          loading={query.isLoading}
          error={query.error}
          retry={() => query.refetch()}
        >
          {!query.data?.length ? (
            <EmptyState
              title="暂无公告"
            />
          ) : (
            <DataTable
              rowKey="id"
              rows={query.data}
              columns={[
                {
                  title: "标题",
                  accessor: "title",
                  className: "max-w-xs whitespace-normal wrap-anywhere",
                },
                {
                  title: "受众",
                  render: (_, a) =>
                    a.audience === "all"
                      ? "全部用户"
                      : a.audience === "admins"
                        ? "管理员"
                        : `${a.userIds.length} 位指定用户`,
                },
                { title: "开始时间", render: (_, a) => dateLabel(a.startsAt) },
                { title: "结束时间", render: (_, a) => dateLabel(a.expiresAt) },
                {
                  title: "状态",
                  render: (_, a) => (
                    <Badge variant="secondary">
                      {!a.enabled
                        ? "已停用"
                        : Date.parse(a.expiresAt) <= Date.now()
                          ? "已结束"
                          : Date.parse(a.startsAt) > Date.now()
                            ? "已安排"
                            : "有效中"}
                    </Badge>
                  ),
                },
                {
                  title: "",
                  render: (_, a) => (
                    <TableRowActions name={a.title}>
                      <ActionButton onClick={() => edit(a)} variant="outline">
                        编辑
                      </ActionButton>
                    </TableRowActions>
                  ),
                },
              ]}
              minWidth={{ x: 700 }.x}
            />
          )}
        </QueryState>
      </Section>
      <TaskDialog
        title={isNew ? "创建公告" : "编辑公告"}
        open={!!editing}
        footer={<div className="w-full space-y-3">
          <p className="text-sm text-muted-foreground">
            公告仅在站内向所选受众展示，按开始和结束时间安排，不发送邮件或
            Webhook。
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ActionButton onClick={close} variant="outline">
              取消
            </ActionButton>
            <ActionButton
              ref={submitButton}
              keepFocusableWhilePending
              type="submit"
              form={formId}
              disabled={!editing}
              aria-label="保存并安排发布"
              aria-busy={save.isPending}
              pending={save.isPending}
              variant="default"
            >
              保存并安排发布
            </ActionButton>
          </div>
        </div>}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
        pending={!(!save.isPending && !confirming)}
        size="lg"
      >
        <AppForm
          id={formId}
          form={form}
          disabled={save.isPending}
          onValuesChange={() => setDirty(true)}
          onFinish={(v) => {
            const task = editorTask.current;
            if (
              !active.current ||
              !editing ||
              !task ||
              submitting.current ||
              save.isPending ||
              confirming
            )
              return;
            const value = structuredClone({
              ...v,
              id: editing.id,
              startsAt: new Date(v.startsAt).toISOString(),
              expiresAt: new Date(v.expiresAt).toISOString(),
              userIds: v.audience === "users" ? v.userIds : [],
            });
            submitting.current = task;
            const submit = submitButton.current;
            if (
              submit?.form?.contains(document.activeElement) &&
              !submit.closest('[inert], [aria-hidden="true"]')
            )
              submit.focus();
            save.mutate({ value, isNew, task });
          }}
        >
          <ErrorNotice error={save.error} />
          {!isNew && <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">修改此公告保留已读记录；需要重新通知时请创建新公告。</p>}
          <AppField name="title" label="公告标题" rules={[{ required: true }]}>
            <Input maxLength={160} />
          </AppField>
          <AppField name="body" label="公告正文" rules={[{ required: true }]}>
            <Textarea rows={6} maxLength={10000} />
          </AppField>
          <AppField name="audience" label="通知谁" trigger="onValueChange">
            <ChoiceSelect
              options={[
                { value: "all", label: "全部用户" },
                { value: "users", label: "指定用户" },
                { value: "admins", label: "管理员" },
              ]}
            />
          </AppField>
          {audience === "users" && (
            <AppField
              name="userIds"
              label="选择用户"
              rules={[{ required: true }]}
              trigger="onValueChange"
            >
              <MultiChoice
                options={(users.data?.users || []).map((u) => ({
                  value: u.id,
                  label: u.name,
                }))}
              />
            </AppField>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <AppField
              name="startsAt"
              label="开始时间（本机时区）"
              rules={[{ required: true }]}
            >
              <Input type="datetime-local" />
            </AppField>
            <AppField
              name="expiresAt"
              label="结束时间（本机时区）"
              rules={[{ required: true }]}
            >
              <Input type="datetime-local" />
            </AppField>
          </div>
          <AppField
            name="enabled"
            label="启用公告"
            valuePropName="checked"
            trigger="onCheckedChange"
          >
            <Switch />
          </AppField>

        </AppForm>
      </TaskDialog>
    </>
  );
}
function NotificationSettings() {
  const query = useQuery({
    queryKey: ["notification-settings"],
    queryFn: () => request<Settings>("/admin/notification-settings"),
  });
  return (
    <>
      {query.data && query.error && (
        <Notice
          tone="error"
          title="暂时无法刷新设置"
          action={
            <ActionButton
              variant="outline"
              pending={query.isFetching}
              onClick={() => query.refetch()}
            >
              重新读取设置
            </ActionButton>
          }
        >
          {query.error.message}
        </Notice>
      )}
      <QueryState
        loading={query.isLoading}
        error={query.data ? null : query.error}
        retry={() => query.refetch()}
      >
        {query.data && <SettingsForm initial={query.data} />}
      </QueryState>
    </>
  );
}
function SettingsForm({ initial }: { initial: Settings }) {
  const [form] = useForm();
  const [baseline, setBaseline] = useState(initial);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const save = useMutation({
    mutationFn: (
      values: Settings & {
        smtpPassword?: string;
        webhookSecret?: string;
        clearSMTP?: boolean;
        clearWebhook?: boolean;
      },
    ) => {
      const {
        smtpPasswordSet,
        webhookSecretSet,
        clearSMTP,
        clearWebhook,
        ...v
      } = values;
      return request<Settings>("/admin/notification-settings", {
        method: "PUT",
        body: JSON.stringify({
          ...baseline,
          ...v,
          email: { ...baseline.email, ...v.email },
          webhook: { ...baseline.webhook, ...v.webhook },
          smtpPasswordSet: undefined,
          webhookSecretSet: undefined,
          revision: baseline.revision,
          quotaPercent: v.quotaPercent.map(Number),
          expiryHours: v.expiryHours.map(Number),
          providerRemainingPercent: v.providerRemainingPercent.map(Number),
          smtpPassword: clearSMTP ? "" : v.smtpPassword || undefined,
          webhookSecret: clearWebhook ? "" : v.webhookSecret || undefined,
        }),
      });
    },
    onSuccess: (saved) => {
      setBaseline(saved);
      setDirty(false);
      form.setFieldsValue({
        smtpPassword: undefined,
        webhookSecret: undefined,
        clearSMTP: false,
        clearWebhook: false,
      });
      client.invalidateQueries({ queryKey: ["notification-settings"] });
      message.success("通知设置已保存");
    },
  });
  const test = useMutation({
    mutationFn: (channel: string) =>
      post<Delivery>("/admin/notifications/test", { channel }),
    onSuccess: (delivery) => {
      client.invalidateQueries({ queryKey: ["notification-outbox"] });
      client.invalidateQueries({ queryKey: ["inbox"] });
      if (["failed", "retrying"].includes(delivery.status)) {
        message.warning("此次发送未成功，请在发送记录查看重试状态");
      } else {
        message.success(
          delivery.status === "available"
            ? "测试通知已出现在站内消息"
            : delivery.status === "accepted"
              ? "通知已由发送渠道接收，请查看实际收件结果"
              : "测试通知已进入发送队列",
        );
      }
    },
  });
  const sendTest = (channel: string) =>
    confirm({
      title: "发送一条测试通知？",
      description:
        channel === "email"
          ? `将向已保存的收件人 ${baseline.email.to.join("、")} 发送测试内容。`
          : channel === "webhook"
            ? `将向已保存的 Webhook ${baseline.webhook.url} 发送测试内容。`
            : "将在站内消息中生成测试通知。",
      confirmLabel: "发送测试",
      cancelLabel: "取消",
      onConfirm: () => test.mutateAsync(channel),
    });
  return (
    <Section
      title="提醒与发送渠道"
      className="max-w-4xl"
      description="账号额度与到期提醒仅在站内展示。外部渠道用于管理员的供应商提醒与显式测试；保存设置不会发送测试消息。"
    >
      <AppForm
        form={form}
        disabled={save.isPending}
        onValuesChange={() => setDirty(true)}
        initialValues={{
          ...baseline,
          quotaPercent: baseline.quotaPercent.map(String),
          expiryHours: baseline.expiryHours.map(String),
          providerRemainingPercent:
            baseline.providerRemainingPercent.map(String),
        }}
        onFinish={(values) => save.mutate(values)}
      >
        <ErrorNotice error={save.error || test.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <AppField
            name="quotaPercent"
            label="已用额度提醒阈值（%）"
            trigger="onValueChange"
          >
            <MultiChoice
              options={[80, 90, 100].map((v) => ({
                value: String(v),
                label: String(v),
              }))}
              creatable
            />
          </AppField>
          <AppField
            name="expiryHours"
            label="到期前提醒（小时）"
            trigger="onValueChange"
          >
            <MultiChoice
              options={[72, 24, 6].map((v) => ({
                value: String(v),
                label: String(v),
              }))}
              creatable
            />
          </AppField>
          <AppField
            name="providerRemainingPercent"
            label="供应商剩余配额提醒（%）"
            trigger="onValueChange"
          >
            <MultiChoice
              options={[20, 10, 5].map((v) => ({
                value: String(v),
                label: String(v),
              }))}
              creatable
            />
          </AppField>
          <AppField
            name="repeatHours"
            label="同类提醒最短间隔（小时）"
            trigger="onValueChange"
          >
            <NumericInput min={1} />
          </AppField>
        </div>
        <AppField
          name="inApp"
          label="站内消息"
          valuePropName="checked"
          trigger="onCheckedChange"
        >
          <Switch />
        </AppField>
        <Accordion type="multiple">
          {[
            {
              key: "email",
              label: "\u90AE\u4EF6\u901A\u77E5",
              children: (
                <>
                  <AppField
                    name={["email", "enabled"]}
                    label="启用邮件渠道"
                    valuePropName="checked"
                    trigger="onCheckedChange"
                  >
                    <Switch />
                  </AppField>
                  <AppField
                    name={["email", "automatic"]}
                    valuePropName="checked"
                    trigger="onCheckedChange"
                    label="允许自动发送管理员供应商提醒邮件"
                  >
                    <Checkbox />
                  </AppField>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <AppField name={["email", "host"]} label="SMTP 主机">
                      <Input />
                    </AppField>
                    <AppField
                      name={["email", "port"]}
                      label="端口"
                      trigger="onValueChange"
                    >
                      <NumericInput min={1} max={65535} />
                    </AppField>
                    <AppField
                      name={["email", "tlsMode"]}
                      label="传输安全"
                      trigger="onValueChange"
                    >
                      <ChoiceSelect
                        options={[
                          { value: "starttls", label: "STARTTLS" },
                          { value: "tls", label: "TLS" },
                        ]}
                      />
                    </AppField>
                    <AppField name={["email", "username"]} label="用户名">
                      <Input autoComplete="off" />
                    </AppField>
                  </div>
                  <AppField
                    name="smtpPassword"
                    label={
                      baseline.smtpPasswordSet
                        ? "\u66F4\u65B0 SMTP \u5BC6\u7801\uFF08\u5DF2\u4FDD\u5B58\uFF0C\u7559\u7A7A\u4E0D\u53D8\uFF09"
                        : "SMTP \u5BC6\u7801"
                    }
                  >
                    <PasswordInput autoComplete="new-password" />
                  </AppField>
                  {baseline.smtpPasswordSet && (
                    <AppField
                      name="clearSMTP"
                      valuePropName="checked"
                      trigger="onCheckedChange"
                      label="清除已保存的 SMTP 密码"
                    >
                      <Checkbox />
                    </AppField>
                  )}
                  <AppField name={["email", "from"]} label="发件地址">
                    <Input type="email" />
                  </AppField>
                  <AppField
                    name={["email", "to"]}
                    label="收件地址"
                    trigger="onValueChange"
                  >
                    <MultiChoice creatable options={[]} />
                  </AppField>
                  <ActionButton
                    disabled={!baseline.email.enabled}
                    onClick={() => sendTest("email")}
                    variant="outline"
                  >
                    发送邮件测试
                  </ActionButton>
                </>
              ),
            },
            {
              key: "webhook",
              label: "Webhook \u901A\u77E5",
              children: (
                <>
                  <AppField
                    name={["webhook", "enabled"]}
                    label="启用 Webhook 渠道"
                    valuePropName="checked"
                    trigger="onCheckedChange"
                  >
                    <Switch />
                  </AppField>
                  <AppField
                    name={["webhook", "automatic"]}
                    valuePropName="checked"
                    trigger="onCheckedChange"
                    label="允许自动发送管理员供应商提醒 Webhook"
                  >
                    <Checkbox />
                  </AppField>
                  <AppField
                    name={["webhook", "url"]}
                    label="HTTPS Webhook 地址"
                  >
                    <Input />
                  </AppField>
                  <AppField
                    name="webhookSecret"
                    label={
                      baseline.webhookSecretSet
                        ? "\u66F4\u65B0\u7B7E\u540D\u5BC6\u94A5\uFF08\u5DF2\u4FDD\u5B58\uFF0C\u7559\u7A7A\u4E0D\u53D8\uFF09"
                        : "\u7B7E\u540D\u5BC6\u94A5"
                    }
                  >
                    <PasswordInput revealLabel="签名密钥" autoComplete="new-password" />
                  </AppField>
                  {baseline.webhookSecretSet && (
                    <AppField
                      name="clearWebhook"
                      valuePropName="checked"
                      trigger="onCheckedChange"
                      label="清除已保存的签名密钥"
                    >
                      <Checkbox />
                    </AppField>
                  )}
                  <ActionButton
                    disabled={!baseline.webhook.enabled}
                    onClick={() => sendTest("webhook")}
                    variant="outline"
                  >
                    发送 Webhook 测试
                  </ActionButton>
                </>
              ),
            },
          ].map((section) => (
            <AccordionItem
              key={section.key}
              value={String(section.key)}
              disabled={
                "collapsible" in section && section.collapsible === "disabled"
              }
            >
              <AccordionTrigger>{section.label}</AccordionTrigger>
              <AccordionContent className="space-y-5">{section.children}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <ActionButton onClick={() => sendTest("in-app")} variant="outline">
            发送站内测试
          </ActionButton>
          <ActionButton
            type="submit"
            pending={save.isPending}
            variant="default"
          >
            保存通知设置
          </ActionButton>
        </div>
      </AppForm>
    </Section>
  );
}
function Outbox() {
  const query = useQuery({
    queryKey: ["notification-outbox"],
    queryFn: () => list<Delivery>("/admin/notifications/outbox"),
    refetchInterval: 15000,
  });
  const labels: Record<string, string> = {
    queued: "等待发送",
    retry: "等待重试",
    retrying: "等待重试",
    sending: "发送中",
    available: "站内已可读",
    cancelled: "已取消",
    accepted: "渠道已接收",
    failed: "发送失败",
    suppressed: "未发送",
  };
  return (
    <Section title="通知发送记录" description="渠道接收不等于收件人已经阅读。">
      <QueryState
        loading={query.isLoading}
        error={query.error}
        retry={() => query.refetch()}
      >
        <DataTable
          rowKey={(r) => `${r.eventId}-${r.channel}`}
          rows={query.data || []}
          columns={[
            { title: "通知", accessor: "title" },
            {
              title: "渠道",
              render: (_, r) =>
                r.channel === "in-app"
                  ? "站内"
                  : r.channel === "email"
                    ? "邮件"
                    : "Webhook",
            },
            {
              title: "状态",
              render: (_, r) => (
                <Badge variant="secondary">
                  {labels[r.status] || r.status}
                </Badge>
              ),
            },
            { title: "尝试次数", accessor: "attempts" },
            { title: "创建时间", render: (_, r) => dateLabel(r.createdAt) },
            { title: "原因", accessor: "lastError" },
          ]}
          empty="暂无发送记录"
          minWidth={760}
        />
      </QueryState>
    </Section>
  );
}
