import { exactDraftInteger } from "./draft-integer";
import { Metadata, MetadataItem } from "@/ui-patterns/metadata";
import { ResourceToolbar, SearchField } from "@/ui-patterns/resource-toolbar";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { MultiChoice } from "@/ui-patterns/choice-select";
import { Notice } from "@/ui-patterns/notice";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { toast } from "sonner";
import {
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Trash2,
  FileText,
  Link,
  Plus,
  Search,
} from "lucide-react";
import {
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";
import { invalidateOutputInputs } from "./output-comparison";
import { DataTable, TableRowActions } from "./DataTable";
import { useUnsavedChanges } from "./navigation";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, deleteRecord, list, post, request, saveRecord } from "./api";
import type {
  Collection,
  Preview,
  Profile,
  RuleResource,
  Source,
} from "./types";
import { dateLabel, newID, diagnosticText, moveItem } from "./model";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { StepsEditor } from "./Pipeline";
import { CollectionPreview } from "./CollectionPreview";
import {
  SourceApplyButton,
  useSourceApplication,
  type SourceApplyRecovery,
} from "./SourceApplyButton";
import { SourceUpdateReview } from "./SourceUpdateReview";
import { SourceActionMenu } from "./SourceActionMenu";
import {
  SourceUpdateContinuation,
  type SourceAcceptanceReceipt,
} from "./SourceUpdateContinuation";
import { SourceEditorDialog } from "./SourceEditorDialog";
import { sourceApplicationNoticeID } from "./source-notice";
import { SourceImportTask, canResumeSourceReview } from "./SourceImportTask";
import {
  SourceSelectionIssues,
  sourceSelectionIssue,
  sourceSelectionLabel,
} from "./SourceSelectionIssues";
export { SourceEditorDialog } from "./SourceEditorDialog";
export type { SourceEditorDialogProps } from "./SourceEditorDialog";
export function SourcesPage({
  onAdded,
  onEditingChange,
  acceptanceReceipts,
  acceptanceScope,
  onAccepted,
  onCreateProfile,
}: {
  onAdded?: (source: Source) => void;
  onEditingChange?: (blocked: boolean) => void;
  acceptanceReceipts?: Record<string, SourceAcceptanceReceipt>;
  acceptanceScope?: string | null;
  onAccepted?: (receipt: SourceAcceptanceReceipt) => void;
  // Only standalone source management can start a different configuration task.
  onCreateProfile?: (sourceId: string) => void;
} = {}) {
  const query = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Source | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Source | null>(null);
  const [review, setReview] = useState<Source | null>(null);
  const [reviewRecovery, setReviewRecovery] = useState<SourceApplyRecovery>();
  const openChanges = (source: Source) => {
    if (application.isRunning() || refreshStarted.current || otherWritePending)
      return;
    message.dismiss(sourceApplicationNoticeID(source.id));
    setReviewRecovery(undefined);
    setReview(source);
  };
  const applied = (source: Source, receipt: SourceAcceptanceReceipt) => {
    if (!acceptanceReceipts)
      setLocalReceipts((current) => ({
        ...current,
        [receipt.sourceId]: receipt,
      }));
    onAccepted?.(receipt);
    setDetail((current) => (current?.id === source.id ? source : current));
    message.success(`「${source.name}」已应用，已发布订阅未改变`, {
      id: sourceApplicationNoticeID(source.id),
    });
  };
  const recoverApplication = (
    source: Source,
    recovery: SourceApplyRecovery,
  ) => {
    message.dismiss(sourceApplicationNoticeID(source.id));
    setDetail(null);
    setReviewRecovery(recovery);
    setReview(source);
  };
  const applyCommand = useSourceApplication({
    scope: acceptanceScope,
    onApplied: applied,
    onRecover: recoverApplication,
  });
  const [localReceipts, setLocalReceipts] = useState<
    Record<string, SourceAcceptanceReceipt>
  >({});
  const receipts = acceptanceReceipts ?? localReceipts;
  const [accepted, setAccepted] = useState<SourceAcceptanceReceipt | null>(
    null,
  );
  const [actionError, setActionError] = useState<Error | null>(null);
  const [deleteReview, setDeleteReview] = useState<string | null>(null);
  const deleteSequence = useRef(0);
  useLayoutEffect(() => {
    // Session-scoped confirmations expire without throwing away an editor draft.
    setReview(null);
    setAccepted(null);
    setLocalReceipts({});
    setDeleteReview(null);
    deleteSequence.current++;
  }, [acceptanceScope]);
  useEffect(
    () => () => {
      deleteSequence.current++;
    },
    [],
  );
  const refreshStarted = useRef(false);
  const refresh = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => {
      refreshStarted.current = false;
      invalidateOutputInputs(client);
    },
    mutationFn: (id: string) => post<Source>(`/me/sources/${id}/refresh`),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["sources"] });
      setReview(null);
      message.success(
        result.candidate
          ? "发现更新，可手动应用"
          : result.refreshStatus === "unchanged"
            ? "已是最新内容"
            : "来源已更新",
        { id: sourceApplicationNoticeID(result.id) },
      );
    },
    onError: (error) => {
      client.invalidateQueries({ queryKey: ["sources"] });
      setActionError(error);
      setReview(null);
    },
  });
  const remove = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    mutationFn: (id: string) => deleteRecord("me/sources", id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["sources"] });
      message.success("来源已删除");
    },
    onError: setActionError,
  });
  const otherWritePending =
    refresh.isPending || remove.isPending || !!deleteReview;
  const application = {
    ...applyCommand,
    apply(source: Source) {
      if (otherWritePending || refreshStarted.current) return;
      applyCommand.apply(source);
    },
  };
  // The containing configuration drawer must not unmount a source editor,
  // review or in-flight operation. Keep this independent of the profile's dirty state.
  const blocksContainerClose =
    open ||
    !!review ||
    !!deleteReview ||
    refresh.isPending ||
    remove.isPending ||
    application.pending;
  useUnsavedChanges(!!deleteReview || refresh.isPending || remove.isPending);
  useEffect(() => {
    onEditingChange?.(blocksContainerClose);
  }, [blocksContainerClose, onEditingChange]);
  const reviewDelete = async (source: Source) => {
    if (application.isRunning() || refreshStarted.current || otherWritePending)
      return;
    const sequence = ++deleteSequence.current;
    setDeleteReview(source.id);
    setActionError(null);
    try {
      const [collections, profiles] = await Promise.all([
        list<Collection>("/me/collections"),
        list<Profile>("/me/profiles"),
      ]);
      if (sequence !== deleteSequence.current) return;
      const references = [
        ...collections
          .filter((collection) =>
            collection.sources.some((ref) => ref.sourceId === source.id),
          )
          .map((collection) => `集合：${collection.name}`),
        ...profiles
          .filter((profile) => profile.sourceIds?.includes(source.id))
          .map((profile) => `客户端配置：${profile.name}`),
      ];
      if (references.length) {
        confirm({
          title: `「${source.name}」仍在使用`,
          description: (
            <>
              <p>先从以下位置移除此来源，再删除：</p>
              <ul className="mt-3 list-disc space-y-2 pl-5 wrap-anywhere">
                {references.map((reference, index) => (
                  <li key={index}>{reference}</li>
                ))}
              </ul>
            </>
          ),
          confirmLabel: "知道了",
        });
        return;
      }
      confirm({
        title: `删除「${source.name}」？`,
        description:
          "删除后不再从此来源更新节点。已经下载到客户端的配置不会被收回。",
        confirmLabel: "删除来源",
        cancelLabel: "保留来源",
        destructive: true,
        onConfirm: () => remove.mutateAsync(source.id),
      });
    } catch (error) {
      if (sequence === deleteSequence.current) setActionError(error as Error);
    } finally {
      if (sequence === deleteSequence.current) setDeleteReview(null);
    }
  };
  const edit = (source: Source | null) => {
    if (application.isRunning() || refreshStarted.current || otherWritePending)
      return;
    setActionError(null);
    setEditing(source);
    setOpen(true);
  };
  const filtered = (query.data || []).filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );
  const configurationSource = query.data?.find(
    (source) => source.id === detail?.id,
  );
  return (
    <>
      <PageHeader
        title="订阅来源"
        description="导入外部订阅和节点，与平台节点组合使用。"
        action={
          <ActionButton
            leadingIcon={<Plus aria-hidden="true" />}
            disabled={application.pending || otherWritePending}
            onClick={() => edit(null)}
            variant="default"
          >
            添加来源
          </ActionButton>
        }
      />
      <ErrorNotice error={actionError} />
      <QueryState
        loading={query.isPending}
        paused={query.isPaused}
        loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section variant="plain">
          <ResourceToolbar
            label="查找订阅来源"
            search={
              <SearchField
                ref={searchInput}
                value={search}
                onValueChange={setSearch}
                placeholder="搜索来源"
                aria-label="搜索来源"
              />
            }
          />
          {!query.data?.length ? (
            <EmptyState
              title="暂无订阅来源"
              action={
                <ActionButton
                  leadingIcon={<Plus aria-hidden="true" />}
                  disabled={application.pending || otherWritePending}
                  onClick={() => edit(null)}
                  variant="default"
                >
                  添加来源
                </ActionButton>
              }
            />
          ) : (
            <DataTable<Source>
              className="@container/source-table"
              rowKey="id"
              rows={filtered}
              count={{ total: query.data.length, unit: "个私有来源", filtered: !!search }}
              columns={[
                {
                  title: "来源",
                  accessor: "name",
                  className: "min-w-52 whitespace-normal @min-[80rem]/source-table:w-[36%]",
                  render: (_, source) => (
                    <button
                      className="table-name inline-flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      disabled={application.pending || otherWritePending}
                      onClick={() => {
                        if (!application.isRunning()) setDetail(source);
                      }}
                    >
                      <span className="table-icon size-4 shrink-0 text-muted-foreground [&_svg]:size-4">
                        {source.kind === "url" ? (
                          <Link aria-hidden="true" />
                        ) : (
                          <FileText aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 wrap-anywhere">
                        {source.name}{" "}
                        <small className="block text-xs font-normal text-muted-foreground">
                          {source.kind === "url" ? "订阅链接" : "文本导入"}
                        </small>
                      </span>
                    </button>
                  ),
                },
                {
                  title: "节点",
                  align: "right",
                  className: "w-20 tabular-nums @min-[80rem]/source-table:w-[8%]",
                  render: (_, s) =>
                    s.snapshot?.endpoints?.length ??
                    s.endpoints?.length ??
                    s.nodeCount ??
                    "—",
                },
                {
                  title: "状态",
                  className: "w-[7.75rem] @min-[80rem]/source-table:w-[16%]",
                  render: (_, s) => (
                    <Badge
                      variant={
                        s.enabled && sourceHasFailure(s)
                          ? "destructive"
                          : "secondary"
                      }
                      className={
                        s.enabled &&
                        !sourceStatusUnknown(s) &&
                        !sourceHasFailure(s) &&
                        s.candidate
                          ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                          : undefined
                      }
                    >
                      {!s.enabled
                        ? "已暂停"
                        : sourceStatusUnknown(s)
                          ? "状态待确认"
                          : sourceHasFailure(s)
                            ? "更新失败"
                            : s.candidate
                              ? "有更新"
                              : "已导入"}
                    </Badge>
                  ),
                },
                {
                  title: "最近更新",
                  className: "w-[11.5rem] @min-[80rem]/source-table:w-auto",
                  render: (_, s) => (
                    <span className="muted whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                      {dateLabel(s.updatedAt)}
                    </span>
                  ),
                },
                {
                  title: "操作",
                  width: 280,
                  align: "right",
                  render: (_, s) => (
                    <TableRowActions name={s.name}>
                      {s.candidate && (
                        <>
                          <SourceApplyButton
                            key={`${acceptanceScope ?? ""}:${s.id}`}
                            source={s}
                            application={application}
                            disabled={otherWritePending}
                          />
                          <ActionButton
                            disabled={application.pending || otherWritePending}
                            onClick={() => openChanges(s)}
                            variant="link"
                          >
                            查看变化
                          </ActionButton>
                        </>
                      )}
                      {receipts[s.id] && !s.candidate && (
                        <ActionButton
                          aria-label={`查看上次应用结果 ${s.name}`}
                          disabled={application.pending || otherWritePending}
                          onClick={() => {
                            if (!application.isRunning()) {
                              // This durable receipt now owns the success feedback.
                              // Preserve unrelated-source and failure notices.
                              message.dismiss(sourceApplicationNoticeID(s.id));
                              setAccepted(receipts[s.id]);
                            }
                          }}
                          variant="link"
                        >
                          上次应用结果
                        </ActionButton>
                      )}
                      <SourceActionMenu
                        sourceName={s.name}
                        loading={
                          application.pendingId === s.id ||
                          deleteReview === s.id ||
                          (refresh.isPending && refresh.variables === s.id) ||
                          (remove.isPending && remove.variables === s.id)
                        }
                        disabled={application.pending || otherWritePending}
                        deleteDisabled={
                          application.pending || otherWritePending
                        }
                        onDelete={() => reviewDelete(s)}
                        refreshDisabled={
                          !s.enabled || application.pending || otherWritePending
                        }
                        onRefresh={() => {
                          if (
                            application.isRunning() ||
                            refreshStarted.current ||
                            otherWritePending
                          )
                            return;
                          setActionError(null);
                          refreshStarted.current = true;
                          refresh.mutate(s.id);
                        }}
                        editDisabled={application.pending || otherWritePending}
                        onEdit={() => edit(s)}
                      />
                    </TableRowActions>
                  ),
                },
              ]}
              pageSize={10}
              minWidth={880}
              empty={
                {
                  emptyText: (
                    <EmptyState
                      title="没有匹配的来源"
                      action={
                        <ActionButton
                          onClick={() => {
                            setSearch("");
                            searchInput.current?.focus();
                          }}
                          variant="outline"
                        >
                          清除搜索
                        </ActionButton>
                      }
                    />
                  ),
                }.emptyText
              }
            />
          )}
        </Section>
      </QueryState>
      <SourceEditorDialog
        open={open}
        source={editing}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        onSaved={(result) => {
          if (result.candidate)
            message.info("来源已保存，有更新可手动应用", {
              id: sourceApplicationNoticeID(result.id),
            });
          else if (!editing && result.snapshot) onAdded?.(result);
        }}
      />
      <SourceUpdateReview
        source={review}
        recovery={reviewRecovery}
        onAccepted={(receipt, source) => {
          // Acceptance is complete: do not keep a pending review/dirty guard alive.
          setReview(null);
          message.success(`「${source.name}」已应用，已发布订阅未改变`, {
            id: sourceApplicationNoticeID(source.id),
          });
          if (!acceptanceReceipts)
            setLocalReceipts((current) => ({
              ...current,
              [receipt.sourceId]: receipt,
            }));
          onAccepted?.(receipt);
        }}
        onClose={() => setReview(null)}
      />
      <SourceUpdateContinuation
        receipt={accepted}
        onClose={() => setAccepted(null)}
      />
      <TaskSheet
        title={detail?.name}
        open={!!detail}
        footer={
          onCreateProfile &&
          configurationSource?.enabled === true &&
          configurationSource.snapshot ? (
            <ActionButton
              disabled={application.pending || otherWritePending}
              onClick={() => {
                if (!application.isRunning())
                  onCreateProfile(configurationSource.id);
              }}
              variant="default"
            >
              用此来源新建分流配置
            </ActionButton>
          ) : null
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) (() => setDetail(null))();
        }}
        size="lg"
      >
        {detail && (
          <>
            {sourceIssueText(detail) && (
              <Notice
                tone="warning"
                title={
                  sourceStatusUnknown(detail)
                    ? "来源状态待确认"
                    : "最近更新未完成"
                }
              >
                {sourceIssueText(detail)}
              </Notice>
            )}
            {detail.candidate && (
              <Notice
                tone="info"
                title="有更新可应用"
                action={
                  <div className="flex flex-wrap gap-2">
                    <SourceApplyButton
                      key={`${acceptanceScope ?? ""}:${detail.id}`}
                      source={detail}
                      application={application}
                      disabled={otherWritePending}
                    />
                    <ActionButton
                      disabled={application.pending || otherWritePending}
                      onClick={() => {
                        if (
                          application.isRunning() ||
                          refreshStarted.current ||
                          otherWritePending
                        )
                          return;
                        openChanges(detail);
                        setDetail(null);
                      }}
                      variant="outline"
                    >
                      查看变化
                    </ActionButton>
                  </div>
                }
              />
            )}
            <p className="muted text-sm text-muted-foreground">
              <Metadata>
                <MetadataItem>最近更新 {dateLabel(detail.updatedAt)}</MetadataItem>
                <MetadataItem>{(detail.snapshot?.endpoints || detail.endpoints || []).length} 个节点</MetadataItem>
              </Metadata>
            </p>
            <DataTable
              rowKey="id"
              rows={detail.snapshot?.endpoints || detail.endpoints || []}
              summary={false}
              columns={[
                { title: "名称", accessor: "name" },
                {
                  title: "协议",
                  render: (_, node) => node.connection?.protocol,
                },
                { title: "地区", accessor: "region" },
              ]}
              pageSize={10}
              compact
            />
            <section className="mt-6 space-y-3">
              <h3 className="text-sm font-medium">应用记录</h3>
              {detail.applyHistory?.length ? (
                <ul className="divide-y rounded-lg border px-4">
                  {detail.applyHistory.map((event) => (
                    <li key={event.id} className="space-y-1 py-3 text-sm">
                      <p>
                        <Metadata>
                          <MetadataItem>{dateLabel(event.appliedAt)}</MetadataItem>
                          <MetadataItem>{event.mode === "manual" ? "手动应用" : "自动应用"}</MetadataItem>
                        </Metadata>
                      </p>
                      <p className="text-muted-foreground">
                        <Metadata>
                          <MetadataItem>{event.beforeCount} → {event.afterCount} 个节点</MetadataItem>
                          <MetadataItem>新增 {event.added}</MetadataItem>
                          <MetadataItem>移除 {event.removed}</MetadataItem>
                          <MetadataItem>连接变化 {event.connectionChanged}</MetadataItem>
                          <MetadataItem>改名 {event.renamed}</MetadataItem>
                          {event.reordered && <MetadataItem>顺序已调整</MetadataItem>}
                        </Metadata>
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">暂无应用记录</p>
              )}
            </section>
            {detail.diagnostics?.map((d, i) => (
              <Notice key={i} title={diagnosticText(d)} tone="warning" />
            ))}
          </>
        )}
      </TaskSheet>
    </>
  );
}
/** Disclosure and reorder are sibling controls, so each native key action has one owner. */
function CollectionSourceStage({
  summary,
  actions,
  children,
  disclosure,
  recoveryRequest = 0,
}: {
  summary: ReactNode;
  actions: ReactNode;
  children: ReactNode;
  disclosure: { expanded: boolean; hasOpened: boolean };
  recoveryRequest?: number;
}) {
  const [expanded, setExpanded] = useState(disclosure.expanded);
  const [hasOpened, setHasOpened] = useState(disclosure.hasOpened);
  useLayoutEffect(() => {
    if (!recoveryRequest) return;
    disclosure.expanded = true;
    disclosure.hasOpened = true;
    setExpanded(true);
    setHasOpened(true);
  }, [recoveryRequest, disclosure]);
  const panelId = `collection-source-${useId()}`;
  return (
    <div
      className="collection-source-stage space-y-4 rounded-lg border p-3 sm:p-4"
      role="group"
      aria-labelledby={`${panelId}-label`}
    >
      <div className="collection-source-heading flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="collection-source-disclosure flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          id={`${panelId}-label`}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => {
            disclosure.hasOpened = true;
            disclosure.expanded = !expanded;
            setHasOpened(true);
            setExpanded(disclosure.expanded);
          }}
        >
          <ChevronRight
            className={`collection-source-chevron order-last ml-auto size-4 shrink-0 ${expanded ? "rotate-90" : "rotate-0"}`}
            aria-hidden="true"
          />
          {summary}
        </button>
        {actions}
      </div>
      <div
        id={panelId}
        className="collection-source-panel space-y-4"
        hidden={!expanded}
      >
        {hasOpened && children}
      </div>
    </div>
  );
}
/** Go's present null slices are empty recipes, not missing response fields. */
function collectionRecipe(value: unknown): Collection | null {
  if (!value || typeof value !== "object") return null;
  const collection = value as Collection;
  const steps = (value: unknown) => value === null || (Array.isArray(value) &&
    value.every((step) => step && typeof step.id === "string" && typeof step.kind === "string" && typeof step.enabled === "boolean"));
  if (typeof collection.id !== "string" || typeof collection.name !== "string" ||
    !steps(collection.steps) || (collection.sources !== null && !Array.isArray(collection.sources)) ||
    (collection.sources ?? []).some((source) => !source || typeof source.sourceId !== "string" || !steps(source.steps)))
    return null;
  return {
    ...collection,
    sources: (collection.sources ?? []).map((source) => ({ ...source, steps: source.steps ?? [] })),
    steps: collection.steps ?? [],
  };
}

export function CollectionsPage() {
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const query = useQuery({
    queryKey: ["collections"],
    queryFn: () => list<Collection>("/me/collections"),
    // Other pages populate this shared cache. Normalize before any cached render.
    select: (items) => items.map((item) => {
      const value = collectionRecipe(item);
      if (!value) throw new Error("未能读取完整的集合，请重试。");
      return value;
    }),
  });
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<Collection | null>(null);
  const [portDrafts, setPortDrafts] = useState<Record<string, string>>({});
  const [portFocus, setPortFocus] = useState({ source: null as string | null, id: "", request: 0 });
  const portKey = (source: string | null, id: string) => JSON.stringify([source, id]);
  const portLocations = (value: Collection | null) => [
    ...(value?.sources.flatMap((source) => source.steps.filter((step) => step.kind === "override").map((step) => ({ source: source.sourceId, id: step.id }))) ?? []),
    ...(value?.steps.filter((step) => step.kind === "override").map((step) => ({ source: null, id: step.id })) ?? []),
  ];
  const invalidPort = portLocations(draft).find(({ source, id }) => {
    const raw = portDrafts[portKey(source, id)];
    return raw !== undefined && raw !== "" && exactDraftInteger(raw, 65535) === undefined;
  });
  const checkPorts = () => {
    if (!invalidPort) return true;
    setError(new Error("请完成覆盖端口输入，范围为 1–65535 的整数。"));
    setPortFocus((previous) => ({ ...invalidPort, request: previous.request + 1 }));
    return false;
  };
  const editPort = (source: string | null, id: string, raw: string) => {
    setPortDrafts((previous) => ({ ...previous, [portKey(source, id)]: raw }));
    revision.current++;
    setPreview(null);
  };
  const stagePorts = (source: string | null, steps: Collection["steps"]) =>
    Object.fromEntries(steps.flatMap((step) => {
      const raw = portDrafts[portKey(source, step.id)];
      return raw === undefined ? [] : [[step.id, raw]];
    }));
  // Disclosure belongs to the collection task, not the temporarily hidden sheet.
  const stageDisclosures = useRef(
    new Map<string, { expanded: boolean; hasOpened: boolean }>(),
  );
  const [baseline, setBaseline] = useState("");
  const changed = !!draft && (JSON.stringify(draft) !== baseline || !!invalidPort);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [creationConflict, setCreationConflict] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const collectionSession = useRef(0);
  const saving = useRef<number | null>(null);
  const reloading = useRef<number | null>(null);
  const discardReview = useRef<ReturnType<typeof confirm> | null>(null);
  const collectionName = useRef<HTMLInputElement>(null);
  const [reloadFocus, setReloadFocus] = useState(0);
  const focusedReload = useRef(0);
  const busy = () => saving.current !== null || reloading.current !== null || !!discardReview.current;
  const [sourceTask, setSourceTask] = useState<{
    owner: number;
    source?: Source;
  } | null>(null);
  const [sourceNotice, setSourceNotice] = useState<Source | null>(null);
  const [sourceSelectionStatus, setSourceSelectionStatus] = useState("");
  const [savedSourceNames, setSavedSourceNames] = useState(
    () => new Map<string, string>(),
  );
  // Keep the source subtask tied to this collection opening, including callbacks
  // that may outlive a discarded/unmounted workspace.
  const sourceOwner = useRef<typeof sourceTask>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const sourceSelection = useRef<HTMLButtonElement>(null);
  const sourceReturnTrigger = useRef<HTMLElement | null>(null);
  const sourceNoticeTrigger = useRef<HTMLButtonElement>(null);
  const sourceReturnNotice = useRef(false);
  const sourceReturnSelectedID = useRef<string | null>(null);
  const sourceRepairButtons = useRef(new Map<string, HTMLButtonElement>());
  const sourceReturnTarget = () => {
    if (sourceReturnTrigger.current?.isConnected)
      return sourceReturnTrigger.current;
    // The owning Sheet remounts after a subtask. Resolve the logical source
    // identity, not its now-disconnected DOM node or a duplicate display name.
    const repair = sourceReturnSelectedID.current
      ? sourceRepairButtons.current.get(sourceReturnSelectedID.current)
      : null;
    return (
      repair ||
      (sourceReturnNotice.current && sourceNoticeTrigger.current) ||
      sourceTrigger.current
    );
  };
  const returnFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (sourceTask || returnFocus.current !== collectionSession.current) return;
    const owner = collectionSession.current;
    // Only repair focus lost by removing the subtask. A still-focused control
    // already owns the next interaction, even if it predates this commit.
    if (document.activeElement !== document.body) return;
    // A fast subtask can return while the Sheet's exit animation still keeps
    // its DOM mounted. Radix mount autofocus will not run again in that case.
    queueMicrotask(() => {
      if (
        sourceOwner.current ||
        returnFocus.current !== owner ||
        collectionSession.current !== owner
      )
        return;
      const current = document.activeElement;
      if (current !== document.body) return;
      const target = sourceReturnTarget();
      if (
        !target?.isConnected ||
        target.closest("[hidden],[inert],[aria-hidden='true']")
      )
        return;
      target.focus();
      if (document.activeElement === target) returnFocus.current = null;
    });
  }, [sourceTask]);
  useLayoutEffect(
    () => () => {
      sourceOwner.current = null;
      returnFocus.current = null;
      collectionSession.current++;
      const review = discardReview.current;
      discardReview.current = null;
      review?.close();
    },
    [],
  );
  const ownsSourceTask = () =>
    !!sourceTask &&
    sourceOwner.current === sourceTask &&
    sourceTask.owner === collectionSession.current;
  const closeSourceTask = () => {
    if (!ownsSourceTask()) return;
    returnFocus.current = sourceTask!.owner;
    sourceOwner.current = null;
    setSourceTask(null);
  };
  const revision = useRef(0);
  const changeDraft = (value: Collection | null) => {
    setSourceSelectionStatus("");
    revision.current++;
    if (!value || value.id !== draft?.id) stageDisclosures.current.clear();
    else
      for (const sourceId of stageDisclosures.current.keys()) {
        if (!value.sources.some((source) => source.sourceId === sourceId))
          stageDisclosures.current.delete(sourceId);
      }
    const liveKeys = new Set(portLocations(value).map(({ source, id }) => portKey(source, id)));
    setPortDrafts((previous) => !value || value.id !== draft?.id ? {} : Object.fromEntries(Object.entries(previous).filter(([key]) => liveKeys.has(key))));
    setDraft(value);
    setPreview(null);
  };
  type DraftTask = { owner: number; version: number };
  const ownsDraft = ({ owner, version }: DraftTask) =>
    owner === collectionSession.current && version === revision.current;
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: (_result, _error, { owner }) => {
      if (saving.current === owner) saving.current = null;
      invalidateOutputInputs(client);
    },
    mutationFn: ({ value, creating }: DraftTask & { value: Collection; creating: boolean }) =>
      saveRecord<Collection>("me/collections", value, creating),
    onSuccess: (_result, task) => {
      client.invalidateQueries({ queryKey: ["collections"] });
      if (!ownsDraft(task)) return;
      changeDraft(null);
      message.success("集合已保存");
    },
    onError: (error, task) => {
      if (!ownsDraft(task)) return;
      // A rejected retry cannot resolve an earlier response lost after commit.
      if (task.creating && (!(error instanceof APIError) || error.status === 0 ||
        error.status >= 500 || error.status === 200)) setCreationUncertain(true);
      if (task.creating && error instanceof APIError && error.status === 412 &&
        (error.details as { code?: string } | undefined)?.code === "COLLECTION_CREATION_CONFLICT") {
        setCreationConflict(true);
        setError(null);
      } else if (error instanceof APIError && error.status === 409 &&
        (error.details as { code?: string } | undefined)?.code === "COLLECTION_DRAFT_CHANGED") {
        setConflicted(true);
        setError(null);
      } else setError(error);
    },
  });
  const inspect = useMutation({
    mutationFn: ({ value }: DraftTask & { value: Collection }) => {
      if (invalidPort) throw new Error("请完成覆盖端口输入，范围为 1–65535 的整数。");
      const { revisionToken: _revisionToken, ...recipe } = value;
      return post<Preview>("/me/collections/preview", recipe);
    },
    onSuccess: (result, task) => {
      if (ownsDraft(task) && !busy()) setPreview(result);
    },
    onError: (error, task) => {
      if (ownsDraft(task) && !busy()) setError(error);
    },
  });
  const reload = useMutation({
    mutationFn: async ({ id }: DraftTask & { id: string }) => {
      const value = collectionRecipe(await request<unknown>(`/me/collections/${encodeURIComponent(id)}`));
      // A partial read must never enable an unguarded save or discard local input.
      if (!value || value.id !== id || typeof value.revisionToken !== "string" || !value.revisionToken.trim())
        throw new Error("未能读取完整的最新集合，当前输入已保留。请重试。");
      return value;
    },
    onSuccess: (value, task) => {
      if (!ownsDraft(task)) return;
      // Permission is to replace the whole recipe, never just its revision.
      setPortDrafts({});
      setPortFocus({ source: null, id: "", request: 0 });
      stageDisclosures.current.clear();
      setSourceNotice(null);
      setSavedSourceNames(new Map());
      setBaseline(JSON.stringify(value));
      setIsNew(false);
      changeDraft(value);
      setConflicted(false);
      setCreationConflict(false);
      setCreationUncertain(false);
      setError(null);
      setReloadFocus((version) => version + 1);
      client.invalidateQueries({ queryKey: ["collections"] });
    },
    onError: (error, task) => { if (ownsDraft(task)) setError(error); },
    onSettled: (_result, _error, { owner }) => {
      if (reloading.current === owner) reloading.current = null;
    },
  });
  const pending = save.isPending || reload.isPending;
  useUnsavedChanges(changed || pending || (!!draft && creationUncertain));
  useLayoutEffect(() => {
    if (reloadFocus === focusedReload.current || pending) return;
    focusedReload.current = reloadFocus;
    collectionName.current?.focus();
  }, [reloadFocus, pending]);
  const reviewReload = () => {
    if (!draft || !(conflicted || creationConflict || creationUncertain) || sourceOwner.current || busy()) return;
    const task = { id: draft.id, owner: collectionSession.current, version: revision.current };
    let confirmed = false;
    const review = confirm({
      title: "放弃当前修改并读取最新集合？",
      description: "这会替换集合名称、来源选择、顺序和处理步骤。已保存的来源和已发布订阅不会改变。",
      confirmLabel: "放弃修改并读取",
      cancelLabel: "保留当前输入",
      destructive: true,
      onConfirm: () => { if (discardReview.current === review && ownsDraft(task)) confirmed = true; },
      onCancel: () => { confirmed = false; },
      onClosed: () => {
        if (discardReview.current !== review) return;
        discardReview.current = null;
        if (!confirmed || !ownsDraft(task)) return;
        reloading.current = task.owner;
        setError(null);
        // Invalidate a preview already in flight without changing the retained recipe.
        revision.current++;
        reload.mutate({ ...task, version: revision.current });
      },
    });
    discardReview.current = review;
  };
  const edit = (item?: Collection) => {
    if (sourceOwner.current || busy()) return;
    collectionSession.current++;
    setPortDrafts({});
    setPortFocus({ source: null, id: "", request: 0 });
    const value = item
      ? structuredClone(item)
      : { id: newID("collection"), name: "", sources: [], steps: [] };
    setBaseline(JSON.stringify(value));
    changeDraft(value);
    setIsNew(!item);
    setError(null);
    setConflicted(false);
    setCreationConflict(false);
    setCreationUncertain(false);
    setPreview(null);
    setSourceNotice(null);
    setSavedSourceNames(new Map());
  };
  const close = () => {
    if (sourceOwner.current || busy()) return;
    if (!changed && !creationUncertain) return changeDraft(null);
    const task = { owner: collectionSession.current, version: revision.current };
    let confirmed = false;
    const review = confirm({
      title: "放弃尚未保存的集合修改？",
      description:
        creationUncertain
          ? "此前保存结果尚未确认。关闭会丢弃当前输入，不会删除可能已保存的集合或已保存的来源。"
          : "集合名称、来源选择、顺序和处理步骤尚未保存。已保存的来源会保留。",
      confirmLabel: "放弃修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: () => { if (discardReview.current === review && ownsDraft(task)) confirmed = true; },
      onCancel: () => { confirmed = false; },
      onClosed: () => {
        if (discardReview.current !== review) return;
        discardReview.current = null;
        if (confirmed && ownsDraft(task)) changeDraft(null);
      },
    });
    discardReview.current = review;
  };
  // A saved source can precede its list refresh. Keep only its name in this
  // opening; actual list names take precedence and read errors stay visible.
  const sourceNames = new Map(
    (sources.data || []).map((source) => [source.id, source.name]),
  );
  for (const { sourceId } of draft?.sources || []) {
    const savedName = savedSourceNames.get(sourceId);
    if (savedName && !sourceNames.has(sourceId))
      sourceNames.set(sourceId, savedName);
  }
  const sourceCatalogChecked =
    sources.isSuccess && !sources.isFetching && !sources.isPaused;
  const unavailableSources = sourceCatalogChecked
    ? (draft?.sources || []).flatMap((ref) => {
        const source = sources.data?.find((item) => item.id === ref.sourceId);
        return source && sourceSelectionIssue(source) ? [source] : [];
      })
    : [];
  const openSelectedSource = (source: Source, trigger: HTMLElement) => {
    if (sourceOwner.current || busy()) return;
    sourceReturnTrigger.current = trigger;
    sourceReturnNotice.current = false;
    sourceReturnSelectedID.current = source.id;
    const task = { owner: collectionSession.current, source };
    setSourceNotice(null);
    setError(null);
    sourceOwner.current = task;
    setSourceTask(task);
  };
  return (
    <>
      <PageHeader
        title="节点集合"
        description="组合多个来源，按顺序处理节点，再复用到分流配置。"
        action={
          <ActionButton
            ref={createTrigger}
            leadingIcon={<Plus aria-hidden="true" />}
            onClick={() => edit()}
            variant="default"
          >
            新建集合
          </ActionButton>
        }
      />
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        {!query.data?.length ? (
          <Section>
            <EmptyState
              title="暂无节点集合"
              action={
                <ActionButton onClick={() => edit()} variant="default">
                  新建集合
                </ActionButton>
              }
            />
          </Section>
        ) : (
          <div className="card-grid grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {query.data.map((item) => (
              <article
                key={item.id}
                aria-labelledby={`collection-${encodeURIComponent(item.id)}-name`}
                className="collection-card surface flex min-w-0 flex-col rounded-xl border bg-card p-5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3 pb-4">
                  <span className="tile-icon flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Link className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <h2
                      id={`collection-${encodeURIComponent(item.id)}-name`}
                      className="text-base font-semibold tracking-tight wrap-anywhere"
                    >
                      {item.name}
                    </h2>
                    <p
                      id={`collection-${encodeURIComponent(item.id)}-summary`}
                      className="text-sm leading-relaxed text-muted-foreground"
                    >
                      <Metadata>
                        <MetadataItem>{item.sources.length} 个来源</MetadataItem>
                        <MetadataItem>{item.steps.length} 个聚合步骤</MetadataItem>
                      </Metadata>
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 border-t pt-2">
                  <ActionButton
                    variant="ghost"
                    className="justify-start px-2 font-medium"
                    aria-labelledby={`collection-${encodeURIComponent(item.id)}-name collection-${encodeURIComponent(item.id)}-summary collection-${encodeURIComponent(item.id)}-edit`}
                    onClick={() => edit(item)}
                  >
                    <span id={`collection-${encodeURIComponent(item.id)}-edit`}>编辑集合</span>
                    <span aria-hidden="true">→</span>
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    className="px-2 text-muted-foreground hover:text-destructive"
                    aria-label={`删除集合 ${item.name}`}
                    onClick={() => setDeleting(item)}
                  >
                    删除
                  </ActionButton>
                </div>
              </article>
            ))}
          </div>
        )}
      </QueryState>
      {deleting && (
        <CollectionDelete
          collection={deleting}
          onClose={() => setDeleting(null)}
          afterDelete={() => createTrigger.current?.focus()}
        />
      )}
      <TaskSheet
        title={isNew ? "新建集合" : draft?.name}
        open={!!draft && !sourceTask}
        pending={pending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
        onReady={() =>
          ((open) => {
            if (open && returnFocus.current === collectionSession.current) {
              returnFocus.current = null;
              sourceReturnTarget()?.focus();
            }
          })(true)
        }
        onClosed={() =>
          ((open) => {
            if (open && returnFocus.current === collectionSession.current) {
              returnFocus.current = null;
              sourceReturnTarget()?.focus();
            }
          })(false)
        }
        size="lg"
        footer={
          <ActionButton
            className="collection-save-action"
            aria-label="保存集合"
            aria-busy={save.isPending}
            onKeyDown={(event) => {
              if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
            }}
            onClick={() => {
              if (!draft || sourceOwner.current || busy() || (conflicted && !isNew) || !checkPorts()) return;
              setError(null);
              const owner = collectionSession.current;
              saving.current = owner;
              save.mutate({ value: draft, creating: isNew, owner, version: revision.current });
            }}
            disabled={
              !draft?.name.trim() ||
              !!sourceTask ||
              (conflicted && !isNew) ||
              reload.isPending ||
              unavailableSources.length > 0
            }
            variant="default"
            pending={!!save.isPending}
          >
            保存集合
          </ActionButton>
        }
      >
        {draft && (
          <fieldset className="min-w-0 space-y-6" disabled={pending || !!sourceTask} inert={pending || !!sourceTask}>
            <ErrorNotice error={error} />
            {(conflicted || creationConflict || creationUncertain) && (
              <Notice tone="warning" title={creationConflict ? "集合创建发生冲突" : creationUncertain ? "集合保存结果尚未确认" : "集合或来源已变化"} action={
                <ActionButton variant="outline" onClick={reviewReload}
                  pending={reload.isPending}
                  onKeyDown={(event) => {
                    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
                  }}>
                  读取最新集合
                </ActionButton>
              }>
                {creationConflict
                  ? creationUncertain ? "此前保存结果尚未确认。当前输入已保留，不能覆盖已保存的集合。" : "当前输入已保留，不能覆盖已保存的集合。"
                  : creationUncertain ? "当前输入已保留。重试不会覆盖已保存的集合。"
                  : isNew ? "当前输入已保留。可重试创建，或读取已保存的集合。"
                  : "当前输入已保留，不能覆盖新版本。"}
              </Notice>
            )}
            <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
              集合名称
              <Input
                ref={collectionName}
                value={draft.name}
                onChange={(e) =>
                  changeDraft({ ...draft, name: e.target.value })
                }
                placeholder="例如：日常连接"
              />
            </label>
            <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
              订阅来源
              <MultiChoice
                ref={sourceSelection}
                aria-label="订阅来源"
                disabled={sources.isPending || sources.isError}
                value={draft.sources.map((s) => s.sourceId)}
                options={Array.from(sourceNames, ([value, label]) => {
                  const source = sources.data?.find(
                    (item) => item.id === value,
                  );
                  return {
                    value,
                    label: source
                      ? sourceSelectionLabel(source, sourceCatalogChecked)
                      : label,
                  };
                })}
                onValueChange={(ids) =>
                  changeDraft({
                    ...draft,
                    sources: ids.map(
                      (id) =>
                        draft.sources.find((s) => s.sourceId === id) || {
                          sourceId: id,
                          steps: [],
                        },
                    ),
                  })
                }
              />
            </label>
            <SourceSelectionIssues
              sources={unavailableSources}
              onRepair={openSelectedSource}
              onRepairButtonRef={(id, button) => {
                if (button) sourceRepairButtons.current.set(id, button);
                else sourceRepairButtons.current.delete(id);
              }}
              onRemove={(source) => {
                setError(null);
                changeDraft({
                  ...draft,
                  sources: draft.sources.filter(
                    (ref) => ref.sourceId !== source.id,
                  ),
                });
                sourceSelection.current?.focus();
              }}
            />
            <ActionButton
              ref={sourceTrigger}
              onKeyDown={(event) => {
                if (
                  event.repeat &&
                  (event.key === "Enter" || event.key === " ")
                )
                  event.preventDefault();
              }}
              className="collection-source-action"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={(event) => {
                if (sourceOwner.current || busy()) return;
                sourceReturnTrigger.current = event.currentTarget;
                sourceReturnNotice.current = false;
                sourceReturnSelectedID.current = null;
                const task = { owner: collectionSession.current };
                setSourceNotice(null);
                sourceOwner.current = task;
                setSourceTask(task);
              }}
              variant="outline"
            >
              添加来源
            </ActionButton>
            <p role="status" className="sr-only">
              {sourceSelectionStatus}
            </p>
            {sourceNotice && (
              <Notice
                className="collection-source-notice my-3"
                tone="warning"
                title="来源尚未加入集合"
                action={
                  <ActionButton
                    ref={sourceNoticeTrigger}
                    onKeyDown={(event) => {
                      if (
                        event.repeat &&
                        (event.key === "Enter" || event.key === " ")
                      )
                        event.preventDefault();
                    }}
                    onClick={(event) => {
                      if (sourceOwner.current || busy()) return;
                      sourceReturnTrigger.current = event.currentTarget;
                      sourceReturnNotice.current = true;
                      sourceReturnSelectedID.current = null;
                      const task = {
                        owner: collectionSession.current,
                        source: sourceNotice,
                      };
                      sourceOwner.current = task;
                      setSourceTask(task);
                    }}
                    variant="outline"
                  >
                    {canResumeSourceReview(sourceNotice)
                      ? "查看变化"
                      : "继续编辑"}
                  </ActionButton>
                }
              >
                {
                  <>
                    <p>「{sourceNotice.name}」已单独保存，尚未加入当前集合。</p>
                    {!sourceNotice.enabled && <p>来源已暂停。</p>}
                    {!sourceNotice.candidate && !sourceNotice.snapshot && (
                      <p>尚无可用节点。</p>
                    )}
                    {sourceIssueText(sourceNotice) && (
                      <p>{sourceIssueText(sourceNotice)}</p>
                    )}
                  </>
                }
              </Notice>
            )}
            {sources.isPending && <p role="status">正在加载可选来源…</p>}
            {sources.isError && (
              <Notice
                tone="error"
                title="暂时无法加载来源"
                action={
                  <ActionButton
                    onClick={() => sources.refetch()}
                    variant="outline"
                    pending={!!sources.isFetching}
                  >
                    重试加载来源
                  </ActionButton>
                }
              >
                {"已选来源、顺序和处理步骤已保留。重试后可更改来源选择。"}
              </Notice>
            )}
            {sources.isSuccess && sourceNames.size === 0 && <p>暂无可选来源</p>}
            {sources.isSuccess &&
              sourceNames.size > 0 &&
              !draft.sources.length && <p>尚未选择来源</p>}
            {draft.sources.length > 0 && (
              <div className="collection-source-stages space-y-4">
                {draft.sources.map((source, index) => (
                  <CollectionSourceStage
                    key={`${reloadFocus}:${source.sourceId}`}
                    recoveryRequest={portFocus.source === source.sourceId ? portFocus.request : 0}
                    disclosure={(() => {
                      let state = stageDisclosures.current.get(source.sourceId);
                      if (!state) {
                        state = { expanded: false, hasOpened: false };
                        stageDisclosures.current.set(source.sourceId, state);
                      }
                      return state;
                    })()}
                    summary={
                      <span className="collection-source-summary flex min-w-0 flex-col gap-1 text-sm wrap-anywhere [&>span:first-child]:font-medium [&>span:first-child]:text-foreground">
                        <span>{`${index + 1}. ${sourceNames.get(source.sourceId) || source.sourceId}`}</span>
                        <span className="muted text-sm text-muted-foreground">
                          <Metadata>
                            <MetadataItem>来源处理</MetadataItem>
                            {source.steps.length > 0 && <MetadataItem>已配置 {source.steps.length} 步</MetadataItem>}
                          </Metadata>
                        </span>
                      </span>
                    }
                    actions={
                      draft.sources.length > 1 ? (
                        <div className={"flex flex-wrap items-center gap-2"}>
                          <ActionButton
                            aria-label={`上移来源 ${index + 1}`}
                            className="aria-disabled:text-muted-foreground aria-disabled:hover:bg-background aria-disabled:hover:text-muted-foreground dark:aria-disabled:hover:bg-input/30"
                            leadingIcon={<ArrowUp />}
                            aria-disabled={index === 0}
                            onClick={() =>
                              index > 0 &&
                              changeDraft({
                                ...draft,
                                sources: moveItem(
                                  draft.sources,
                                  index,
                                  index - 1,
                                ),
                              })
                            }
                            variant="outline"
                            size="sm"
                          />
                          <ActionButton
                            aria-label={`下移来源 ${index + 1}`}
                            className="aria-disabled:text-muted-foreground aria-disabled:hover:bg-background aria-disabled:hover:text-muted-foreground dark:aria-disabled:hover:bg-input/30"
                            leadingIcon={<ArrowDown />}
                            aria-disabled={index === draft.sources.length - 1}
                            onClick={() =>
                              index < draft.sources.length - 1 &&
                              changeDraft({
                                ...draft,
                                sources: moveItem(
                                  draft.sources,
                                  index,
                                  index + 1,
                                ),
                              })
                            }
                            variant="outline"
                            size="sm"
                          />
                        </div>
                      ) : null
                    }
                  >
                    <StepsEditor
                      value={source.steps}
                      onPortFocused={() => setPortFocus((previous) => ({ ...previous, id: "" }))}
                      portDrafts={stagePorts(source.sourceId, source.steps)}
                      onPortInput={(id, raw) => editPort(source.sourceId, id, raw)}
                      portFocus={portFocus.source === source.sourceId ? portFocus : undefined}
                      label="来源处理"
                      emptyText="未添加处理步骤"
                      onChange={(steps) =>
                        changeDraft({
                          ...draft,
                          sources: draft.sources.map((s, i) =>
                            i === index ? { ...s, steps } : s,
                          ),
                        })
                      }
                    />
                  </CollectionSourceStage>
                ))}
              </div>
            )}
            {draft.sources.length > 1 && (
              <div className="pipeline-merge border-y py-3 text-center text-sm text-muted-foreground">
                按此顺序合并
              </div>
            )}
            <StepsEditor
              value={draft.steps}
              onPortFocused={() => setPortFocus((previous) => ({ ...previous, id: "" }))}
              portDrafts={stagePorts(null, draft.steps)}
              onPortInput={(id, raw) => editPort(null, id, raw)}
              portFocus={portFocus.source === null ? portFocus : undefined}
              label="合并后处理"
              emptyText={draft.sources.length ? "未添加处理步骤" : null}
              onChange={(steps) => changeDraft({ ...draft, steps })}
            />
            <ActionButton
              leadingIcon={<Search aria-hidden="true" />}
              disabled={unavailableSources.length > 0}
              aria-label="预览处理结果"
              aria-busy={inspect.isPending}
              onClick={() => {
                if (busy() || inspect.isPending) return;
                setError(null);
                if (draft && checkPorts())
                  inspect.mutate({ value: draft, owner: collectionSession.current, version: revision.current });
              }}
              variant="outline"
              pending={!!inspect.isPending}
            >
              预览处理结果
            </ActionButton>
            {preview && (
              <CollectionPreview
                value={preview}
                sources={sources.data || []}
                collection={draft}
              />
            )}
          </fieldset>
        )}
      </TaskSheet>
      <SourceImportTask
        open={!!sourceTask}
        source={sourceTask?.source}
        onFinish={(result) => {
          if (!ownsSourceTask() || !draft) return;
          if (result.kind === "ready") {
            const source = result.source;
            setSavedSourceNames((current) =>
              new Map(current).set(source.id, source.name),
            );
            changeDraft({
              ...draft,
              sources: draft.sources.some((item) => item.sourceId === source.id)
                ? draft.sources
                : [...draft.sources, { sourceId: source.id, steps: [] }],
            });
            setSourceNotice(null);
            setSourceSelectionStatus(`当前集合已选择来源「${source.name}」。`);
          } else
            setSourceNotice(
              result.source &&
                !draft.sources.some((ref) => ref.sourceId === result.source!.id)
                ? result.source
                : null,
            );
          closeSourceTask();
        }}
      />
    </>
  );
}
export { ResourcesPage } from "./Resources";

function CollectionDelete({
  collection,
  onClose,
  afterDelete,
}: {
  collection: Collection;
  onClose(): void;
  afterDelete(): void;
}) {
  const client = useQueryClient();
  const keep = useRef<HTMLButtonElement>(null);
  const deleted = useRef(false);
  const dependencies = useQuery({
    queryKey: ["collection-dependencies", collection.id],
    queryFn: () =>
      request<{
        collection: { id: string; name: string };
        profiles: { id: string; name: string }[];
        deletable: boolean;
      }>(`/me/collections/${encodeURIComponent(collection.id)}/dependencies`),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const remove = useMutation({
    mutationFn: () => deleteRecord("me/collections", collection.id),
    onSuccess: () => {
      deleted.current = true;
      client.invalidateQueries({ queryKey: ["collections"] });
      invalidateOutputInputs(client);
      onClose();
      toast.success("集合已删除");
    },
    onError: () => {
      void dependencies.refetch();
    },
  });
  const checked =
    dependencies.isSuccess &&
    !dependencies.isFetching &&
    !dependencies.isPaused &&
    dependencies.data.collection.id === collection.id;
  const name = checked ? dependencies.data.collection.name : collection.name;
  return (
    <TaskDialog
      open
      title={`删除集合「${name}」？`}
      initialFocus={() => keep.current}
      pending={remove.isPending}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      onCloseAutoFocus={(event) => {
        if (deleted.current) {
          event.preventDefault();
          afterDelete();
        }
      }}
      footer={
        <>
          <ActionButton
            ref={keep}
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            保留集合
          </ActionButton>
          <ActionButton
            variant="destructive"
            pending={remove.isPending}
            disabled={
              !checked ||
              !dependencies.data?.deletable ||
              dependencies.data.profiles.length > 0 ||
              remove.isPending
            }
            onClick={() => remove.mutate()}
          >
            删除集合
          </ActionButton>
        </>
      }
    >
      <p>
        只删除此集合及其处理步骤，不会删除订阅来源、配置或客户端订阅。此操作无法撤销。
      </p>
      <ErrorNotice error={remove.error} />
      <QueryState
        loading={dependencies.isPending || dependencies.isFetching} paused={dependencies.isPaused} loadingLayout="summary"
        error={dependencies.error}
        retry={() => dependencies.refetch()}
      >
        {dependencies.data?.profiles.length ? (
          <section aria-label="引用此集合的配置">
            <p>以下配置仍在引用此集合，无法删除。请先在这些配置中解除引用。</p>
            <ul>
              {dependencies.data.profiles.map((profile) => (
                <li key={profile.id}>
                  <span>{profile.name}</span>{" "}
                  <span className="text-sm text-muted-foreground">
                    （{profile.id}）
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : checked ? (
          <p>没有配置引用此集合。</p>
        ) : null}
      </QueryState>
    </TaskDialog>
  );
}
