import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { useConfirm } from "@/ui-patterns/confirmations";
import { AppField, AppForm, useForm } from "@/ui-patterns/form";
import { Notice } from "@/ui-patterns/notice";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";
import { list, post, request } from "./api";
import { EmptyState, ErrorNotice, QueryState } from "./components";
import { newID } from "./model";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { invalidateOutputInputs } from "./output-comparison";
import type {
  Connection,
  Entitlement,
  PlatformEntry,
  RouteRecord,
  Service,
  UserRecord,
} from "./types";
interface Grant extends PlatformEntry {
  userId?: string;
  publishedRouteId?: string;
  subjectId?: string;
  deploymentId?: string;
  revoked?: boolean;
  connection?: Connection;
}
type UserEntriesProps = {
  user: UserRecord | null;
  routes: RouteRecord[];
  publishedRoutes?: {
    id: string;
    name: string;
  }[];
  services: Service[];
  onClose: () => void;
  allocationHref?: string;
};
export function UserEntries(props: UserEntriesProps) {
  const [surface, setSurface] = useState({
    user: props.user,
    open: !!props.user,
    generation: 0,
  });
  let current = surface;
  if (props.user && (!surface.open || props.user.id !== surface.user?.id)) {
    current = {
      user: props.user,
      open: true,
      generation: surface.generation + 1,
    };
    setSurface(current);
  } else if (props.user && props.user !== surface.user) {
    current = { ...surface, user: props.user };
    setSurface(current);
  } else if (!props.user && surface.open) {
    current = { ...surface, open: false };
    setSurface(current);
  }
  if (!current.user) return null;
  return (
    <UserEntryTask
      key={current.generation}
      {...props}
      user={props.user || current.user}
      open={current.open}
      onExited={() =>
        setSurface((latest) =>
          latest.generation === current.generation && !latest.open
            ? { ...latest, user: null }
            : latest,
        )
      }
    />
  );
}
function UserEntryTask({
  user,
  open,
  onExited,
  routes,
  publishedRoutes = [],
  services,
  onClose,
  allocationHref = "#published-routes",
}: {
  user: UserRecord;
  open: boolean;
  onExited: () => void;
  routes: RouteRecord[];
  publishedRoutes?: {
    id: string;
    name: string;
  }[];
  services: Service[];
  onClose: () => void;
  allocationHref?: string;
}) {
  const formId = useId();
  const active = useRef(open);
  active.current = open;
  useEffect(() => {
    active.current = open;
    return () => {
      active.current = false;
    };
  }, []);
  const client = useQueryClient();
  const confirm = useConfirm();
  const message = toast;
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Grant | null>(null);
  const [form] = useForm();
  const owner = useRef<object | null>(null);
  const revealController = useRef<AbortController | null>(null);
  const revealTrigger = useRef<HTMLElement | null>(null);
  const submitting = useRef<object | null>(null);
  const [revealing, setRevealing] = useState<Grant | null>(null);
  const [dirty, setDirty] = useState(false);
  const { confirm: confirmDiscard, confirming } = useDiscardConfirmation(
    `${user.id}:${editing?.id || ""}:${open}`,
  );
  const invalidate = () => {
    owner.current = null;
    revealController.current?.abort();
    revealController.current = null;
  };
  useLayoutEffect(() => {
    if (!open) invalidate();
    return invalidate;
  }, [open, user.id]);
  const [error, setError] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: ["user-entries", user?.id],
    queryFn: () => list<Grant>(`/users/${user!.id}/entries`),
    enabled: open,
  });
  const pageCount = Math.max(1, Math.ceil((query.data?.length || 0) / 10));
  const visiblePage = Math.min(page, pageCount);
  useEffect(
    () => setPage((current) => Math.min(current, pageCount)),
    [pageCount],
  );
  const entitlement = useQuery({
    queryKey: ["entitlement", user?.id],
    queryFn: () => request<Entitlement>(`/users/${user!.id}/entitlement`),
    enabled: open,
  });
  const permitted = new Set([
    ...(services.find((s) => s.id === entitlement.data?.serviceId)?.routeIds ||
      []),
    ...routes
      .filter((r) => r.userIds.includes(user?.id || ""))
      .map((r) => r.id),
  ]);
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: (_data, _error, { task }) => {
      invalidateOutputInputs(client);
      if (submitting.current === task) submitting.current = null;
    },
    mutationFn: ({ value, id }: { value: Grant; id: string; task: object }) =>
      post(`/users/${user.id}/entries`, {
        id,
        name: value.name,
        routeId: value.routeId,
        credentialVersion: value.credentialVersion,
        connection: normalizeConnection(value.connection!),
      }),
    onSuccess: (_data, { task }) => {
      client.invalidateQueries({ queryKey: ["user-entries", user?.id] });
      if (!active.current || owner.current !== task) return;
      invalidate();
      setDirty(false);
      setEditing(null);
      form.resetFields();
      message.success("平台入口已保存");
    },
  });
  const rotate = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    mutationFn: (entry: Grant) =>
      post(`/published-routes/${entry.publishedRouteId}/principals`, {
        accountId: user!.id,
        entryId: entry.id,
        credentialVersion: newID("credential"),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["user-entries", user?.id] });
      client.invalidateQueries({ queryKey: ["infrastructure"] });
      if (active.current) message.success("新凭据已准备");
    },
    onError: (failure) => {
      if (active.current) setError(failure);
    },
  });
  const revoke = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    mutationFn: (id: string) =>
      request(`/users/${user!.id}/entries/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["user-entries", user?.id] });
      if (active.current) message.success("已停止此入口的订阅交付");
    },
    onError: (failure) => {
      if (active.current) setError(failure);
    },
  });
  const pending = save.isPending || rotate.isPending || revoke.isPending;
  useUnsavedChanges(open && (dirty || save.isPending));
  const clearEditor = () => {
    invalidate();
    setRevealing(null);
    setEditing(null);
    setDirty(false);
    form.resetFields();
    save.reset();
  };
  const discardThen = (next: () => void) => {
    if (!active.current || save.isPending || submitting.current || confirming)
      return;
    if (!dirty) return next();
    confirmDiscard(
      {
        title: "放弃未保存的入口修改？",
        description: "当前入口修改尚未保存。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      },
      () => {
        if (active.current) next();
      },
    );
  };
  const closeEditor = () => discardThen(clearEditor);
  const closeSheet = () =>
    discardThen(() => {
      clearEditor();
      onClose();
    });
  const beginEdit = async (value?: Grant) => {
    invalidate();
    const task = {};
    owner.current = task;
    const controller = new AbortController();
    revealController.current = controller;
    setError(null);
    setEditing(null);
    form.resetFields();
    save.reset();
    setDirty(false);
    setRevealing(value && !value.revoked ? value : null);
    revealTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    try {
      const full =
        value && !value.revoked
          ? await request<Grant>(
              `/users/${user.id}/entries/${value.id}/reveal`,
              { signal: controller.signal },
            )
          : {
              id: value?.id || newID("entry"),
              name: value?.name || "",
              routeId: value?.routeId || "",
              credentialVersion: newID("credential"),
              status: "",
              revoked: value?.revoked,
              connection: { protocol: "socks", host: "", port: 1080 },
            };
      if (!active.current || owner.current !== task) return;
      form.resetFields();
      form.setFieldsValue(full);
      setEditing(full);
      save.reset();
    } catch (e) {
      if (active.current && owner.current === task) setError(e as Error);
    } finally {
      if (owner.current === task) {
        setRevealing(null);
        revealController.current = null;
      }
    }
  };
  const edit = (value?: Grant) => {
    if (pending) return;
    discardThen(() => {
      void beginEdit(value);
    });
  };
  return (
    <TaskSheet
      title={`${user?.name || ""} · 平台入口`}
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSheet();
      }}
      onReady={() =>
        ((visible) => {
          if (!visible && !open) onExited();
        })(true)
      }
      onClosed={() => {
        ((visible) => {
          if (!visible && !open) onExited();
        })(false);
      }}
      size="lg"
      footer={
        <ActionButton variant="default" asChild>
          <a
            href={!open || pending ? undefined : allocationHref}
            aria-disabled={!open || pending}
            tabIndex={!open || pending ? -1 : undefined}
            onClick={(event) => {
              if (!open || pending) {
                event.preventDefault();
                return;
              }
              event.preventDefault();
              discardThen(() => {
                clearEditor();
                onClose();
                window.location.assign(allocationHref);
              });
            }}
          >
            从公开线路分配
          </a>
        </ActionButton>
      }
    >
      <div inert={!open}>
        <ErrorNotice error={error} />
        {revealing && (
          <Notice tone="info" title={`正在读取「${revealing.name}」的入口凭据`}>
            <ActionButton
              variant="outline"
              onClick={() => {
                const trigger = revealTrigger.current;
                clearEditor();
                if (trigger?.isConnected && active.current) trigger.focus();
              }}
            >
              取消读取
            </ActionButton>
          </Notice>
        )}
        <QueryState
          loading={open && (query.isPending || entitlement.isPending)} paused={query.isPaused || entitlement.isPaused} loadingLayout="table"
          error={query.error || entitlement.error}
          retry={() => {
            if (!active.current) return;
            query.refetch();
            entitlement.refetch();
          }}
        >
          {!query.data?.length ? (
            <EmptyState
              title="还没有分配公开入口"
              description="从公开线路为此用户分配入口。"
            />
          ) : (
            <>
              <ul className="user-entry-list space-y-3">
                {query.data
                  .slice((visiblePage - 1) * 10, visiblePage * 10)
                  .map((g) => (
                    <li
                      key={g.id}
                      aria-label={g.name}
                      className="user-entry-row flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4"
                    >
                      <div className="user-entry-info min-w-0 flex-1 basis-48 space-y-2 [overflow-wrap:anywhere]">
                        <h3 className="text-sm font-medium">{g.name}</h3>
                        <div className="user-entry-line flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                          {g.publishedRouteId
                            ? publishedRoutes.find(
                                (r) => r.id === g.publishedRouteId,
                              )?.name || g.publishedRouteId
                            : routes.find((r) => r.id === g.routeId)?.name ||
                              g.routeId}
                        </div>
                        <Badge variant="secondary">
                          {g.revoked
                            ? "已撤销"
                            : g.status === "effective"
                              ? "已确认生效"
                              : g.publishedRouteId
                                ? "尚未确认生效"
                                : "已配置"}
                        </Badge>
                      </div>
                      <div className="user-entry-actions flex flex-wrap items-center gap-2 sm:justify-end">
                        {!g.revoked &&
                          g.publishedRouteId &&
                          g.status !== "effective" && (
                            <ActionButton variant="default" asChild>
                              <a
                                href={
                                  !open || pending
                                    ? undefined
                                    : `#routes?${g.deploymentId ? `deployment=${encodeURIComponent(g.deploymentId)}&` : ""}line=${encodeURIComponent(g.publishedRouteId)}&user=${encodeURIComponent(user!.id)}`
                                }
                                aria-disabled={!open || pending}
                                tabIndex={!open || pending ? -1 : undefined}
                                onClick={(event) => {
                                  if (!open || pending) {
                                    event.preventDefault();
                                    return;
                                  }
                                  event.preventDefault();
                                  const href = event.currentTarget.href;
                                  discardThen(() => {
                                    clearEditor();
                                    onClose();
                                    window.location.assign(href);
                                  });
                                }}
                              >
                                检查并应用路径
                              </a>
                            </ActionButton>
                          )}
                        <div className={"flex flex-wrap items-center gap-2"}>
                          {g.publishedRouteId ? (
                            <ActionButton
                              disabled={!open || pending}
                              aria-label={
                                g.revoked
                                  ? "\u91CD\u65B0\u5206\u914D"
                                  : "\u8F6E\u6362\u51ED\u636E"
                              }
                              aria-busy={
                                rotate.isPending &&
                                rotate.variables?.id === g.id
                              }
                              pending={
                                rotate.isPending &&
                                rotate.variables?.id === g.id
                              }
                              variant="outline"
                              onClick={() =>
                                confirm({
                                  title: g.revoked
                                    ? "\u91CD\u65B0\u5206\u914D\u72EC\u7ACB\u51ED\u636E\uFF1F"
                                    : "\u8F6E\u6362\u6B64\u7528\u6237\u7684\u5165\u53E3\u51ED\u636E\uFF1F",
                                  description:
                                    "\u4F1A\u51C6\u5907\u65B0\u7684\u51ED\u636E\u7248\u672C\uFF1B\u9700\u8981\u91CD\u65B0\u68C0\u67E5\u5E76\u5E94\u7528\u670D\u52A1\u5668\u8DEF\u5F84\uFF0C\u786E\u8BA4\u540E\u624D\u80FD\u518D\u6B21\u4EA4\u4ED8\u3002\u65E7\u8BA2\u9605\u4E2D\u7684\u51ED\u636E\u4E0D\u80FD\u7EE7\u7EED\u4F7F\u7528\u3002",
                                  confirmLabel:
                                    "\u51C6\u5907\u65B0\u51ED\u636E",
                                  cancelLabel: "\u53D6\u6D88",
                                  destructive: false,
                                  onConfirm: () => {
                                    if (active.current)
                                      void rotate
                                        .mutateAsync(g)
                                        .catch(() => undefined);
                                  },
                                })
                              }
                            >
                              {g.revoked
                                ? "\u91CD\u65B0\u5206\u914D"
                                : "\u8F6E\u6362\u51ED\u636E"}
                            </ActionButton>
                          ) : (
                            <ActionButton
                              disabled={!open || pending}
                              onClick={() => edit(g)}
                              variant="outline"
                            >
                              {g.revoked ? "重新分配" : "编辑"}
                            </ActionButton>
                          )}
                          {!g.revoked && (
                            <ActionButton
                              disabled={!open || pending}
                              variant="destructive"
                              onClick={() =>
                                confirm({
                                  title: `停止交付「${g.name}」？`,
                                  description:
                                    "\u5C06\u963B\u6B62\u76F8\u5173\u5E73\u53F0\u8BA2\u9605\u7EE7\u7EED\u4EA4\u4ED8\u3002\u5DF2\u4E0B\u8F7D\u7684\u51ED\u636E\u4E0D\u4F1A\u56E0\u6B64\u4ECE\u8282\u70B9\u64A4\u9500\u3002",
                                  confirmLabel: "\u505C\u6B62\u4EA4\u4ED8",
                                  cancelLabel: "\u4FDD\u7559",
                                  destructive: true,
                                  onConfirm: () => {
                                    if (active.current)
                                      void revoke
                                        .mutateAsync(g.id)
                                        .catch(() => undefined);
                                  },
                                })
                              }
                            >
                              停止交付
                            </ActionButton>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
              </ul>
              {query.data.length > 10 && (
                <PageNavigation
                  pageSize={10}
                  total={query.data.length}
                  page={visiblePage}
                  onPageChange={setPage}
                />
              )}
            </>
          )}
        </QueryState>
      </div>
      <TaskDialog
        title={
          editing?.revoked
            ? `重新分配 ${editing.name}`
            : editing?.name
              ? `编辑 ${editing.name}`
              : "分配平台入口"
        }
        open={open && !!editing}
        footer={
          <div className="w-full space-y-3">
            <Notice tone="info" title="登记已准备好的公开连接">
              {
                "\u8BF7\u4F7F\u7528\u5DF2\u4E3A\u8BE5\u7528\u6237\u51C6\u5907\u7684\u5165\u53E3\u51ED\u636E\u3002\u8FD0\u884C\u72B6\u6001\u9700\u5728\u5BF9\u5E94\u5B9E\u4F8B\u5355\u72EC\u6838\u5B9E\u3002"
              }
            </Notice>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ActionButton onClick={closeEditor} variant="outline">
                取消
              </ActionButton>
              <ActionButton
                type="submit"
                form={formId}
                pending={save.isPending}
                variant="default"
              >
                保存入口
              </ActionButton>
            </div>
          </div>
        }
        onOpenChange={(next) => {
          if (!next) closeEditor();
        }}
        size="md"
        pending={save.isPending}
      >
        <AppForm
          id={formId}
          form={form}
          disabled={save.isPending}
          onValuesChange={() => setDirty(true)}
          onFinish={(v) => {
            const task = owner.current;
            if (!active.current || !editing || !task || submitting.current)
              return;
            submitting.current = task;
            save.mutate({
              value: {
                ...v,
                credentialVersion:
                  v.credentialVersion ||
                  form.getFieldValue("credentialVersion"),
              },
              id: editing.id,
              task,
            });
          }}
        >
          <ErrorNotice error={save.error} />
          {editing?.revoked && (
            <Notice tone="info" title="填写新连接凭据">
              已撤销的凭据不会重新读取。请填写为此用户新准备的连接；保存将使用新凭据版本，旧版本仍不可用于订阅交付。
            </Notice>
          )}
          <AppField name="name" label="入口名称" rules={[{ required: true }]}>
            <Input placeholder="例如：伦敦入口" />
          </AppField>
          <AppField
            name="routeId"
            label="授权线路"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect
              options={routes
                .filter((r) => permitted.has(r.id))
                .map((r) => ({ value: r.id, label: r.name }))}
            />
          </AppField>
          <ConnectionFields />

          <Accordion type="multiple" defaultValue={[]} className="w-full">
            {[
              {
                key: "version",
                label: "\u51ED\u636E\u7248\u672C",
                children: (
                  <>
                    <AppField
                      name="credentialVersion"
                      label="版本标识"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </AppField>
                    <p className="muted text-sm text-muted-foreground">
                      更换连接凭据时必须使用新版本。撤销过的版本不能恢复旧订阅。
                    </p>
                    <ActionButton
                      onClick={() => {
                        form.setFieldValue(
                          "credentialVersion",
                          newID("credential"),
                        );
                        setDirty(true);
                      }}
                      variant="outline"
                    >
                      生成新版本标识
                    </ActionButton>
                  </>
                ),
              },
            ].map((item) => (
              <AccordionItem key={String(item.key)} value={String(item.key)}>
                <AccordionTrigger>{item.label}</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-4">{item.children}</div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </AppForm>
      </TaskDialog>
    </TaskSheet>
  );
}
