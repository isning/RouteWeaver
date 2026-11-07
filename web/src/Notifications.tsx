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
import { useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
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
// Read views use the existing Asia/Shanghai formatter; editor fields remain local.
const inboxDateLabel = (value?: string) => {
  const label = dateLabel(value);
  return label === "未设置" ? label : `${label}（北京时间）`;
};
export function InboxPage() {
  const query = useQuery({
    queryKey: ["inbox"],
    queryFn: () => list<InboxItem>("/me/notifications"),
    refetchInterval: 60000,
  });
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const currentSelected = selected
    ? query.data?.find((item) => item.eventId === selected.eventId)
    : undefined;
  // Keep only presentation alive while the dismissed sheet animates out.
  const presentation = useRef<InboxItem | null>(null);
  const selectedSnapshot = selected
    ? currentSelected || (presentation.current?.eventId === selected.eventId ? presentation.current : selected)
    : null;
  useLayoutEffect(() => {
    if (selectedSnapshot) presentation.current = selectedSnapshot;
  }, [selectedSnapshot]);
  const displayed = selectedSnapshot || presentation.current;
  const client = useQueryClient();
  const acknowledgements = useRef(new Set<string>());
  // Mutation observers follow only the latest call; outcomes belong to each event.
  const [readErrors, setReadErrors] = useState<Map<string, Error>>(new Map());
  const [pendingReads, setPendingReads] = useState<Set<string>>(new Set());
  const read = useMutation({
    mutationFn: (id: string) => post(`/me/notifications/${id}/read`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["inbox"] }),
    onError: (error, id) => {
      setReadErrors((previous) => new Map(previous).set(id, error));
    },
    onSettled: (_data, _error, id) => {
      acknowledgements.current.delete(id);
      setPendingReads((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    },
  });
  const canAcknowledge = (id: string) =>
    query.isSuccess && !query.isFetching && !query.isPaused &&
    !!query.data?.some((item) => item.eventId === id && !item.readAt);
  const acknowledge = (id: string) => {
    if (!canAcknowledge(id) || acknowledgements.current.has(id)) return;
    acknowledgements.current.add(id);
    setPendingReads((previous) => new Set(previous).add(id));
    setReadErrors((previous) => {
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    read.mutate(id);
  };
  const selectedError = selected ? readErrors.get(selected.eventId) : undefined;
  return (
    <>
      <PageHeader
        title="消息"
        action={
          <ActionButton
            leadingIcon={<ReloadOutlined aria-hidden="true" />}
            onClick={() => query.refetch()}
            pending={query.isFetching}
            variant="outline"
          >
            刷新
          </ActionButton>
        }
      />
      {query.data && (query.isFetching || query.isPaused) && (
        <Notice tone="info">{query.isPaused ? "等待网络连接，消息列表尚未更新。" : "正在刷新消息，列表仍为上次读取结果。"}</Notice>
      )}
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section variant="plain">
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
                    if (!item.readAt) acknowledge(item.eventId);
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
                      {inboxDateLabel(item.createdAt)}
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
        {selected && (query.isFetching || query.isPaused || query.isError || !currentSelected) && (
          <Notice tone="warning">
            {query.isFetching ? "正在核对消息，当前显示上次读取内容。"
              : query.isPaused ? "等待网络连接，当前显示上次读取内容。"
              : query.isError ? "消息刷新失败，当前显示上次读取内容。"
              : "此消息已不在当前列表中，以下为之前读取的内容。"}
          </Notice>
        )}
        <ErrorNotice error={selectedError} />
        {selected && !displayed?.readAt && (
          <ActionButton
            pending={pendingReads.has(selected.eventId)}
            keepFocusableWhilePending
            disabled={!canAcknowledge(selected.eventId) && !pendingReads.has(selected.eventId)}
            onClick={() => { if (selected && currentSelected?.eventId === selected.eventId) acknowledge(selected.eventId); }}
          >
            {selectedError ? "重试标记已读" : "标记已读"}
          </ActionButton>
        )}
        <p className="text-sm text-muted-foreground">
          {inboxDateLabel(displayed?.createdAt)}
        </p>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {displayed?.body}
        </div>
        {displayed?.expiresAt && (
          <p className="text-sm text-muted-foreground">
            有效至 {inboxDateLabel(displayed.expiresAt)}
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
// Match notifications.validText: Go counts UTF-8 bytes and rejects NUL and
// Unicode White_Space-only strings (not JavaScript trim's extra BOM character).
const announcementTextRule = (label: string, max: number) => ({
  validator: (_rule: unknown, value: string | undefined) => {
    if (!value || /^\p{White_Space}*$/u.test(value))
      return Promise.reject(new Error(`请填写${label}，不能只包含空白。`));
    if (value.includes("\0"))
      return Promise.reject(new Error(`${label}包含空字符，请删除后重试。`));
    if (new TextEncoder().encode(value).length > max)
      return Promise.reject(new Error(`${label}最多 ${max} 字节（UTF-8），请缩短${label}。`));
    return Promise.resolve();
  },
});
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
  const selectedUsers: string[] = useWatch("userIds", form) ?? [];
  const knownNames = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    for (const user of users.data?.users ?? []) knownNames.current.set(user.id, user.name);
  }, [users.data]);
  const recipientsReady = users.isSuccess && !users.isFetching && !users.isPaused;
  const currentUsers = users.data?.users ?? [];
  const missingUsers = selectedUsers.filter((id) => !currentUsers.some((u) => u.id === id));
  const recipientOptions = [
    ...currentUsers.map((u) => ({ id: u.id, name: u.name })),
    ...missingUsers.map((id) => ({ id, name: knownNames.current.get(id) ?? "未知用户" })),
  ].map((u) => ({
    value: u.id,
    label: <span className="grid gap-0.5"><span>{u.name}</span><span className="text-xs text-muted-foreground">用户标识 {u.id}</span>{recipientsReady && missingUsers.includes(u.id) && <span>当前用户列表中不存在</span>}</span>,
    "aria-label": `${u.name}，用户标识 ${u.id}`,
    searchText: `${u.name} ${u.id}`,
    disabled: !recipientsReady || missingUsers.includes(u.id),
  }));
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
          loading={query.isPending} paused={query.isPaused} loadingLayout="table"
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
                  className: "min-w-48 max-w-xs whitespace-normal wrap-anywhere",
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
                { title: "开始时间（北京时间）", render: (_, a) => dateLabel(a.startsAt) },
                { title: "结束时间（北京时间）", render: (_, a) => dateLabel(a.expiresAt) },
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
        scrollMode="auto"
        title={isNew ? "创建公告" : "编辑公告"}
        open={!!editing}
        footer={<div className="w-full space-y-3">
          <p className="text-sm text-muted-foreground">
            公告仅在站内向所选受众展示，按开始和结束时间安排。
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
              disabled={!editing || (audience === "users" && (!recipientsReady || missingUsers.length > 0))}
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
        pending={save.isPending}
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
              confirming ||
              (v.audience === "users" && (!recipientsReady || missingUsers.length > 0))
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
          <AppField name="title" label="公告标题" required rules={[announcementTextRule("标题", 160)]}>
            <Input />
          </AppField>
          <AppField name="body" label="公告正文" required rules={[announcementTextRule("正文", 8000)]}>
            <Textarea rows={6} />
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
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p role="status" className="text-sm text-muted-foreground">
                  {users.isPaused ? "等待网络连接，暂时无法核对公告接收用户。"
                    : users.isFetching || users.isPending ? "正在读取公告接收用户，请稍候。"
                    : users.isError ? "无法读取公告接收用户，请重试。草稿和已选用户已保留。"
                    : !currentUsers.length ? "暂无可选用户。"
                    : "按姓名或用户标识选择接收公告的用户。"}
                </p>
                <ActionButton type="button" variant="outline" pending={users.isFetching} onClick={() => users.refetch()}>
                  {users.isError || users.isPaused ? "重试读取用户" : "刷新用户列表"}
                </ActionButton>
              </div>
              {recipientsReady && missingUsers.length > 0 && <Notice tone="error">部分已选用户不在当前列表中。请移除这些用户或刷新列表后再保存。</Notice>}
              <AppField
                name="userIds"
                label="选择用户"
                required
                rules={[{ validator: (_rule, ids: string[] | undefined) => {
                  if (!recipientsReady) return Promise.reject(new Error("请等用户列表读取成功后再保存。"));
                  if (!ids?.length || ids.length > 500) return Promise.reject(new Error("请选择 1 至 500 位用户。"));
                  if (ids.some((id) => !currentUsers.some((u) => u.id === id))) return Promise.reject(new Error("请移除当前列表中不存在的用户后再保存。"));
                  return Promise.resolve();
                } }]}
                trigger="onValueChange"
              >
                <MultiChoice options={recipientOptions} />
              </AppField>
            </div>
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
        loading={query.isPending} paused={query.isPaused} loadingLayout="form"
        error={query.data ? null : query.error}
        retry={() => query.refetch()}
      >
        {query.data && <SettingsForm initial={query.data} />}
      </QueryState>
    </>
  );
}
// Validate the decimal spelling before Number can round a fractional input into
// an integer. Decimal/exponent spellings accepted by NumericInput stay supported.
function notificationInteger(value: unknown, max: number): number | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 && value <= max
      ? value
      : undefined;
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] || "") + fraction).replace(/^0+/, "");
  if (!digits) return undefined;
  const significant = digits.replace(/0+$/, "");
  const scale = Number(match[4] || 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(scale) || scale < 0 || significant.length + scale > String(max).length)
    return undefined;
  const integer = Number(significant) * 10 ** scale;
  return integer >= 1 && integer <= max ? integer : undefined;
}

// Keep partial edits in the form so dirty tracking and validation see them.
function NotificationIntegerInput({
  value,
  max,
  onRawChange,
  ...props
}: Omit<
  ComponentProps<typeof NumericInput>,
  "value" | "onValueChange" | "onInputText"
> & {
  max: number;
  value?: number | string | null;
  onRawChange?: (raw: string) => void;
}) {
  const numeric = useRef<number | null>(null);
  if (value == null || value === "") numeric.current = null;
  else if (
    (typeof value === "number" ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) &&
    Number.isFinite(Number(value))
  ) numeric.current = Number(value);
  // Incomplete text must not change NumericInput's numeric prop: it would
  // overwrite the user's local spelling with the previous accepted value.
  return (
    <NumericInput
      {...props}
      value={numeric.current}
      min={1}
      max={max}
      step={1}
      precision={0}
      aria-invalid={
        props["aria-invalid"] ||
        (value != null && value !== "" && notificationInteger(value, max) === undefined) ||
        undefined
      }
      onInputText={onRawChange}
    />
  );
}

function notificationIntegerRules(max: number) {
  return [{ validator: (_: unknown, value: unknown) =>
    notificationInteger(value, max) === undefined
      ? Promise.reject(new Error(`请输入 1–${max} 之间的整数`))
      : Promise.resolve(),
  }];
}
function notificationThresholdRules(max: number) {
  return [{ validator: (_: unknown, value: unknown) => {
    if (!Array.isArray(value)) return Promise.reject(new Error("请选择提醒阈值"));
    const parsed = value.map((token) => notificationInteger(token, max));
    return value.length > 10 || parsed.some((n) => n === undefined) || new Set(parsed).size !== parsed.length
      ? Promise.reject(new Error(`最多设置 10 个不重复的 1–${max} 整数阈值`))
      : Promise.resolve();
  } }];
}

function SettingsForm({ initial }: { initial: Settings }) {
  const [form] = useForm();
  const saveConsequenceId = useId();
  const senderInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const clearSMTPInput = useRef<HTMLButtonElement>(null);
  const clearWebhookInput = useRef<HTMLButtonElement>(null);
  const invalidSecretFocus = useRef<HTMLButtonElement | null>(null);
  const [openChannels, setOpenChannels] = useState<string[]>([]);
  useLayoutEffect(() => {
    const target = invalidSecretFocus.current;
    invalidSecretFocus.current = null;
    if (!target) return;
    const owner = saveButton.current;
    let current = true;
    const cancelOnNewFocus = (event: FocusEvent) => {
      if (event.target !== owner) current = false;
    };
    document.addEventListener("focusin", cancelOnNewFocus);
    const content = target.closest('[data-slot="accordion-content"]');
    const animations = content?.getAnimations?.() || [];
    // Reveal after expansion, only while the submission still owns focus.
    void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (!current || document.activeElement !== owner || !target.isConnected || target.closest('[hidden], [inert]')) return;
      target.focus({ preventScroll: true });
      // Keep the label, clear choice and recovery instruction together instead
      // of aligning only the checkbox against the bottom of a narrow viewport.
      if (document.activeElement === target && !target.closest('[hidden], [inert]'))
        (target.closest<HTMLElement>('[data-slot="field"]') || target)
          .scrollIntoView?.({ block: "center", inline: "nearest" });
    });
    return () => {
      current = false;
      document.removeEventListener("focusin", cancelOnNewFocus);
    };
  }, [openChannels]);
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
          email: { ...baseline.email, ...v.email, port: notificationInteger(v.email.port, 65535) },
          repeatHours: notificationInteger(v.repeatHours, 720),
          webhook: { ...baseline.webhook, ...v.webhook },
          smtpPasswordSet: undefined,
          webhookSecretSet: undefined,
          revision: baseline.revision,
          quotaPercent: v.quotaPercent.map((token) => notificationInteger(token, 100)),
          expiryHours: v.expiryHours.map((token) => notificationInteger(token, 8784)),
          providerRemainingPercent: v.providerRemainingPercent.map((token) => notificationInteger(token, 100)),
          smtpPassword: clearSMTP ? "" : v.smtpPassword || undefined,
          webhookSecret: clearWebhook ? "" : v.webhookSecret || undefined,
        }),
      });
    },
    onSuccess: (saved) => {
      setBaseline(saved);
      setDirty(false);
      form.setFieldsValue({
        smtpPassword: "",
        webhookSecret: "",
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
      description="账号额度与到期提醒仅在站内展示。外部渠道用于管理员的供应商提醒与显式测试；测试消息需单独发送。"
    >
      <AppForm
        form={form}
        disabled={save.isPending}
        noValidate
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name[0];
          invalidSecretFocus.current = document.activeElement === saveButton.current
            ? first === "clearSMTP" ? clearSMTPInput.current
              : first === "clearWebhook" ? clearWebhookInput.current : null
            : null;
          const invalidChannels = errorFields.flatMap(({ name }) =>
            ["email", "smtpPassword", "clearSMTP"].includes(String(name[0]))
              ? ["email"]
              : ["webhook", "webhookSecret", "clearWebhook"].includes(String(name[0]))
                ? ["webhook"]
                : [],
          );
          setOpenChannels((current) => [...new Set([...current, ...invalidChannels])]);
        }}
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
        <p className="text-sm text-muted-foreground">
          每类可设置多个阈值；清空即关闭该类提醒。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <AppField
            name="quotaPercent"
            rules={notificationThresholdRules(100)}
            label="已用额度提醒阈值（%）"
            description="账号已用流量达到任一比例时提醒本人；每个计费周期、每个阈值生成一次。"
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
            rules={notificationThresholdRules(8784)}
            label="到期前提醒（小时）"
            description="账号服务和供应商资源共用这些提前量；剩余时间进入范围后生成提醒。"
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
            rules={notificationThresholdRules(100)}
            label="供应商剩余配额提醒（%）"
            description="供应商剩余额度降至任一比例时提醒管理员。"
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
            rules={notificationIntegerRules(720)}
            label="到期提醒重复周期（小时）"
            description="按距到期时间划分时段，同一提醒阈值每段最多生成一次；额度提醒沿用原设置。"
            trigger="onRawChange"
          >
            <NotificationIntegerInput max={720} />
          </AppField>
        </div>
        <AppField
          name="inApp"
          label="站内提醒"
          description="控制新生成的账号和供应商站内提醒；公告展示与手动测试照常可用。"
          valuePropName="checked"
          trigger="onCheckedChange"
        >
          <Switch />
        </AppField>
        <Accordion type="multiple" value={openChannels} onValueChange={setOpenChannels}>
          {[
            {
              key: "email",
              label: "\u90AE\u4EF6\u901A\u77E5",
              children: (
                <>
                  <AppField
                    name={["email", "enabled"]}
                    label="启用邮件渠道"
                    description="启用并保存后可发送测试；自动提醒由下方选项控制。"
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
                    description="勾选并保存后，供应商配额和到期提醒将自动发送至配置的收件地址。"
                  >
                    <Checkbox />
                  </AppField>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <AppField
                      name={["email", "host"]}
                      label="SMTP 主机"
                      description="填写邮件服务商提供的公网 SMTP 主机，不含协议或端口。"
                    >
                      <Input />
                    </AppField>
                    <AppField
                      name={["email", "port"]}
                      label="端口"
                      rules={notificationIntegerRules(65535)}
                      trigger="onRawChange"
                    >
                      <NotificationIntegerInput max={65535} />
                    </AppField>
                    <AppField
                      name={["email", "tlsMode"]}
                      label="传输安全"
                      description="STARTTLS 在连接后升级为加密；TLS 从连接开始加密。请按邮件服务商要求选择。"
                      trigger="onValueChange"
                    >
                      <ChoiceSelect
                        options={[
                          { value: "starttls", label: "STARTTLS" },
                          { value: "tls", label: "TLS" },
                        ]}
                      />
                    </AppField>
                    <AppField
                      name={["email", "username"]}
                      label="用户名"
                      description="需要登录时填写；启用渠道时，填写用户名还须提供密码。"
                    >
                      <Input autoComplete="off" />
                    </AppField>
                  </div>
                  <AppField
                    name="smtpPassword"
                    label={
                      baseline.smtpPasswordSet
                        ? "\u66F4\u65B0 SMTP \u5BC6\u7801\uFF08\u7559\u7A7A\u4FDD\u7559\u5DF2\u4FDD\u5B58\u503C\uFF09"
                        : "SMTP \u5BC6\u7801"
                    }
                  >
                    <PasswordInput autoComplete="new-password" />
                  </AppField>
                  {baseline.smtpPasswordSet && (
                    <AppField
                      name="clearSMTP"
                      dependencies={["smtpPassword"]}
                      rules={[{ validator: (_rule, clear: boolean) =>
                        clear && form.getFieldValue("smtpPassword")
                          ? Promise.reject(new Error("请选择更新或清除 SMTP 密码，不能同时操作。"))
                          : Promise.resolve(),
                      }]}
                      valuePropName="checked"
                      trigger="onCheckedChange"
                      label="清除已保存的 SMTP 密码"
                    >
                      <Checkbox ref={clearSMTPInput} />
                    </AppField>
                  )}
                  <AppField
                    name={["email", "from"]}
                    label="发件地址"
                    rules={[{ validator: () => senderInput.current?.validity.typeMismatch
                      ? Promise.reject(new Error("请输入有效的发件地址"))
                      : Promise.resolve(),
                    }]}
                  >
                    <Input ref={senderInput} type="email" />
                  </AppField>
                  <AppField
                    name={["email", "to"]}
                    label="收件地址"
                    description="管理员提醒与邮件测试发送到这些地址，最多 10 个。"
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
                    description="启用并保存后可发送测试；自动提醒由下方选项控制。"
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
                    description="勾选并保存后，供应商配额和到期提醒将自动发送至配置的 Webhook。"
                  >
                    <Checkbox />
                  </AppField>
                  <AppField
                    name={["webhook", "url"]}
                    label="HTTPS Webhook 地址"
                    description="填写公网 HTTPS 接收地址，不含查询参数、片段或登录信息。"
                  >
                    <Input />
                  </AppField>
                  <AppField
                    name="webhookSecret"
                    description="启用时至少 32 字节，用于接收方验证通知签名。"
                    label={
                      baseline.webhookSecretSet
                        ? "\u66F4\u65B0\u7B7E\u540D\u5BC6\u94A5\uFF08\u7559\u7A7A\u4FDD\u7559\u5DF2\u4FDD\u5B58\u503C\uFF09"
                        : "\u7B7E\u540D\u5BC6\u94A5"
                    }
                  >
                    <PasswordInput revealLabel="签名密钥" autoComplete="new-password" />
                  </AppField>
                  {baseline.webhookSecretSet && (
                    <AppField
                      name="clearWebhook"
                      dependencies={["webhookSecret"]}
                      rules={[{ validator: (_rule, clear: boolean) =>
                        clear && form.getFieldValue("webhookSecret")
                          ? Promise.reject(new Error("请选择更新或清除签名密钥，不能同时操作。"))
                          : Promise.resolve(),
                      }]}
                      valuePropName="checked"
                      trigger="onCheckedChange"
                      label="清除已保存的签名密钥"
                    >
                      <Checkbox ref={clearWebhookInput} />
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
              <AccordionContent forceMount className="space-y-5">{section.children}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <p id={saveConsequenceId} className="w-full text-sm text-muted-foreground">
            保存会取消此前排队或等待重试的外部发送；已开始发送的请求仍可能完成。
          </p>
          <ActionButton onClick={() => sendTest("in-app")} variant="outline">
            发送站内测试
          </ActionButton>
          <ActionButton
            ref={saveButton}
            type="submit"
            aria-describedby={saveConsequenceId}
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
  const reasons: Record<string, string> = {
    "channel delivery failed; verify destination, credentials and TLS, then test again":
      "请在“提醒与渠道”检查该渠道的目标地址、凭据和 TLS 设置。",
    "delivery attempts exhausted; receiver acceptance may be unknown":
      "请先核对接收方记录，再决定是否在“提醒与渠道”发送新的测试。",
    "recipient or validity is no longer eligible":
      "接收对象或有效期已不符合发送条件。请核对通知的接收对象与有效期。",
    "channel settings or authorization changed; create a new explicit test":
      "渠道设置或发送许可已变更。请在“提醒与渠道”核对设置，需要验证时另行发送测试。",
  };
  return (
    <Section title="通知发送记录" description="渠道接收不等于收件人已经阅读。">
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <DataTable
          rowKey={(r) => `${r.eventId}-${r.channel}`}
          rows={query.data || []}
          className="[&_tbody_td]:align-top"
          columns={[
            {
              title: "通知",
              accessor: "title",
              render: (title, r) => {
                const channel = r.channel === "in-app"
                  ? "站内"
                  : r.channel === "email"
                    ? "邮件"
                    : r.channel === "webhook" ? "Webhook" : r.channel || "未知渠道";
                const knownStatus = Object.hasOwn(labels, r.status);
                const retrying = r.status === "retrying" || r.status === "retry";
                const waiting = r.status === "queued" || retrying;
                // Terminal rows retain their last deadline; it is not a new retry.
                const nextAttempt = waiting ? inboxDateLabel(r.nextAttemptAt) : "未设置";
                const showReason = retrying || r.status === "failed" || r.status === "cancelled" || !knownStatus;
                const recovery = showReason && r.lastError
                  ? Object.hasOwn(reasons, r.lastError)
                    ? reasons[r.lastError]
                    : "原因尚未识别，请查看技术详情。"
                  : showReason && knownStatus ? "服务端未提供原因，请核对该通知与渠道的记录。" : undefined;
                return (
                  <div className="w-[min(24rem,calc(var(--table-viewport-width,100vw)-2rem))] space-y-2 whitespace-normal wrap-anywhere">
                    <strong className="block font-medium">{title}</strong>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{channel}</span>
                      <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>
                        {knownStatus ? labels[r.status] : "未知状态"}
                      </Badge>
                    </div>
                    {waiting && (
                      <p>
                        {nextAttempt === "未设置"
                          ? "下次尝试时间未提供。"
                          : <>下次尝试不早于 <time dateTime={r.nextAttemptAt}>{nextAttempt}</time></>}
                      </p>
                    )}
                    {r.status === "failed" && <p>已停止自动重试。接收方是否已接收尚未确认。</p>}
                    {retrying && <p>接收方是否已接收尚未确认。</p>}
                    {r.status === "sending" && <p>接收结果尚未确认。</p>}
                    {r.status === "cancelled" && <p>已停止后续发送。</p>}
                    {!knownStatus && <p>请刷新记录并查看技术详情。</p>}
                    {recovery && <p>{recovery}</p>}
                    {(r.lastError || !knownStatus) && (
                      <details className="text-muted-foreground">
                        <summary
                          aria-label={`${title} 的${channel}发送技术详情`}
                          className="w-fit min-h-11 cursor-pointer rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >技术详情</summary>
                        <dl className="space-y-2">
                          <div><dt className="font-medium">服务端状态</dt><dd>{r.status || "未提供"}</dd></div>
                          {r.lastError && <div><dt className="font-medium">服务端原因</dt><dd>{r.lastError}</dd></div>}
                        </dl>
                      </details>
                    )}
                  </div>
                );
              },
            },
            { title: "尝试次数", accessor: "attempts" },
            {
              title: "创建时间（北京时间）",
              render: (_, r) => dateLabel(r.createdAt),
            },
          ]}
          empty="暂无发送记录"
          minWidth={760}
        />
      </QueryState>
    </Section>
  );
}
