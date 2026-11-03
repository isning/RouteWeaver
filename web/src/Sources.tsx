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
  Trash2,
  Pencil,
  FileText,
  Link,
  Plus,
  RotateCw,
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
import { deleteRecord, list, post, request, saveRecord } from "./api";
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
import { SourceImportTask, canResumeSourceReview } from "./SourceImportTask";
import {
  SourceSelectionIssues,
  sourceSelectionIssue,
  sourceSelectionLabel,
} from "./SourceSelectionIssues";
export { SourceEditorDialog } from "./SourceEditorDialog";
export type { SourceEditorDialogProps } from "./SourceEditorDialog";
const sourceApplicationNoticeID = (sourceID: string) =>
  `source-application:${sourceID}`;

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
        description="导入外部订阅或节点文本，供分流配置与节点集合使用。"
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
        loading={query.isPending} paused={query.isPaused} loadingLayout="table"
        error={query.error}
        retry={() => query.refetch()}
      >
        <Section variant="plain">
          <ResourceToolbar label="查找订阅来源" search={
            <SearchField ref={searchInput} value={search} onValueChange={setSearch}
              placeholder="搜索来源" aria-label="搜索来源" />
          } summary={<span>{query.data?.length || 0} 个私有来源</span>} />
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
              rowKey="id"
              rows={filtered}
              columns={[
                {
                  title: "来源",
                  accessor: "name",
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
                  render: (_, s) =>
                    s.snapshot?.endpoints?.length ??
                    s.endpoints?.length ??
                    s.nodeCount ??
                    "—",
                },
                {
                  title: "状态",
                  render: (_, s) => (
                    <Badge variant="secondary">
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
                  render: (_, s) => (
                    <span className="muted text-sm text-muted-foreground">
                      {dateLabel(s.updatedAt)}
                    </span>
                  ),
                },
                {
                  title: "",
                  width: 180,
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
                      <ActionButton
                        disabled={
                          !s.enabled || application.pending || otherWritePending
                        }
                        leadingIcon={<RotateCw aria-hidden="true" />}
                        aria-label={`刷新 ${s.name}`}
                        onClick={() => {
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
                        variant="ghost"
                        pending={
                          !!(refresh.isPending && refresh.variables === s.id)
                        }
                      />
                      <ActionButton
                        leadingIcon={<Pencil aria-hidden="true" />}
                        aria-label={`编辑 ${s.name}`}
                        disabled={application.pending || otherWritePending}
                        onClick={() => edit(s)}
                        variant="ghost"
                      />
                      <SourceActionMenu
                        sourceName={s.name}
                        loading={
                          application.pending ||
                          deleteReview === s.id ||
                          (remove.isPending && remove.variables === s.id)
                        }
                        deleteDisabled={
                          application.pending ||
                          !!deleteReview ||
                          remove.isPending
                        }
                        onDelete={() => reviewDelete(s)}
                      />
                    </TableRowActions>
                  ),
                },
              ]}
              pageSize={10}
              minWidth={{ x: 680 }.x}
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
          if (result.candidate) message.info("来源已保存，有更新可手动应用");
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
              最近更新 {dateLabel(detail.updatedAt)} ·{" "}
              {(detail.snapshot?.endpoints || detail.endpoints || []).length}{" "}
              个节点
            </p>
            <DataTable
              rowKey="id"
              rows={detail.snapshot?.endpoints || detail.endpoints || []}
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
                        {dateLabel(event.appliedAt)} ·{" "}
                        {event.mode === "manual" ? "手动应用" : "自动应用"}
                      </p>
                      <p className="text-muted-foreground">
                        {event.beforeCount} → {event.afterCount} 个节点 · 新增{" "}
                        {event.added} · 移除 {event.removed} · 连接变化{" "}
                        {event.connectionChanged} · 改名 {event.renamed}
                        {event.reordered ? " · 顺序已调整" : ""}
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
}: {
  summary: ReactNode;
  actions: ReactNode;
  children: ReactNode;
  disclosure: { expanded: boolean; hasOpened: boolean };
}) {
  const [expanded, setExpanded] = useState(disclosure.expanded);
  const [hasOpened, setHasOpened] = useState(disclosure.hasOpened);
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
          <span
            className="collection-source-chevron order-last ml-auto size-4 shrink-0"
            aria-hidden="true"
          >
            ›
          </span>
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
export function CollectionsPage() {
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const query = useQuery({
    queryKey: ["collections"],
    queryFn: () => list<Collection>("/me/collections"),
  });
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<Collection | null>(null);
  // Disclosure belongs to the collection task, not the temporarily hidden sheet.
  const stageDisclosures = useRef(
    new Map<string, { expanded: boolean; hasOpened: boolean }>(),
  );
  const [baseline, setBaseline] = useState("");
  const changed = !!draft && JSON.stringify(draft) !== baseline;
  useUnsavedChanges(changed);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const collectionSession = useRef(0);
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
    setDraft(value);
    setPreview(null);
  };
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => invalidateOutputInputs(client),
    mutationFn: (value: Collection) =>
      saveRecord("me/collections", value, isNew),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["collections"] });
      changeDraft(null);
      message.success("集合已保存");
    },
    onError: setError,
  });
  const inspect = useMutation({
    mutationFn: ({ value }: { value: Collection; version: number }) =>
      post<Preview>("/me/collections/preview", value),
    onSuccess: (result, { version }) => {
      if (version === revision.current) setPreview(result);
    },
    onError: (error, { version }) => {
      if (version === revision.current) setError(error);
    },
  });
  const edit = (item?: Collection) => {
    if (sourceOwner.current || save.isPending) return;
    collectionSession.current++;
    const value = item
      ? structuredClone(item)
      : { id: newID("collection"), name: "", sources: [], steps: [] };
    setBaseline(JSON.stringify(value));
    changeDraft(value);
    setIsNew(!item);
    setError(null);
    setPreview(null);
    setSourceNotice(null);
    setSavedSourceNames(new Map());
  };
  const close = () => {
    if (sourceOwner.current || save.isPending) return;
    if (!changed) return changeDraft(null);
    confirm({
      title: "放弃尚未保存的集合修改？",
      description:
        "集合名称、来源选择、顺序和处理步骤尚未保存。已保存的来源会保留。",
      confirmLabel: "放弃修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: () => changeDraft(null),
    });
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
    if (sourceOwner.current || save.isPending) return;
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
              <article key={item.id} className="flex min-w-0 flex-col gap-2">
                <ActionButton
                  variant="outline"
                  className="collection-card surface h-auto min-w-0 flex-col items-start justify-start gap-4 rounded-xl p-5 text-left whitespace-normal"
                  onClick={() => edit(item)}
                >
                  <span className="flex w-full min-w-0 items-start gap-3">
                    <span className="tile-icon flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Link className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 space-y-1">
                      <span className="block text-base font-semibold tracking-tight wrap-anywhere">
                        {item.name}
                      </span>
                      <span className="block text-sm font-normal leading-relaxed text-muted-foreground">
                        {item.sources.length} 个来源 · {item.steps.length}{" "}
                        个聚合步骤
                      </span>
                    </span>
                  </span>
                  <span className="card-action mt-auto flex w-full items-center justify-between border-t pt-3 text-sm font-medium">
                    编辑集合 <span aria-hidden="true">→</span>
                  </span>
                </ActionButton>
                <ActionButton
                  variant="ghost"
                  aria-label={`删除集合 ${item.name}`}
                  onClick={() => setDeleting(item)}
                >
                  删除集合
                </ActionButton>
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
            onClick={() => !sourceOwner.current && draft && save.mutate(draft)}
            disabled={
              !draft?.name.trim() ||
              !!sourceTask ||
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
          <div className="space-y-6" inert={save.isPending || !!sourceTask}>
            <ErrorNotice error={error} />
            <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
              集合名称
              <Input
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
                if (sourceOwner.current || save.isPending) return;
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
                      if (sourceOwner.current || save.isPending) return;
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
                    key={source.sourceId}
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
                          来源处理
                          {source.steps.length > 0
                            ? ` · 已配置 ${source.steps.length} 步`
                            : ""}
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
                setError(null);
                if (draft)
                  inspect.mutate({ value: draft, version: revision.current });
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
          </div>
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
