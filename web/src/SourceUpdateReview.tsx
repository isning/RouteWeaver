import type { SourceApplyRecovery } from "./SourceApplyButton";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { ActionButton } from "@/ui-patterns/actions";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/ui-patterns/notice";
import {
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";
import { invalidateOutputInputs } from "./output-comparison";
import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { APIError, post, request } from "./api";
import { diagnosticText } from "./model";
import { useUnsavedChanges } from "./navigation";
import type { Source, SourceApplicationResult, SourceChange } from "./types";
import {
  sourceAcceptanceReceipt,
  sourceChangeFields,
  type SourceAcceptanceReceipt,
} from "./SourceUpdateContinuation";
const kinds: Record<string, string> = {
  collection: "集合",
  profile: "客户端配置",
  group: "分组",
  default: "默认流量",
  rule: "分流规则",
  subscription: "已发布订阅",
};
const extractionLimits = [
  {
    code: "connection-extraction",
    text: "已跳过分流、DNS、分组等其他配置。",
  },
  {
    code: "non-connection-outbound",
    text: "已跳过内置直连、拦截和策略分组，仅提取连接选项。",
  },
];
function ImportDiagnostics({
  diagnostics = [],
}: {
  diagnostics: Source["diagnostics"];
}) {
  const groups = extractionLimits
    .map((limit) => ({
      ...limit,
      items: diagnostics.filter(
        (item) => typeof item === "object" && item.code === limit.code,
      ),
    }))
    .filter((group) => group.items.length);
  const other = diagnostics.filter(
    (item) =>
      typeof item === "string" ||
      !extractionLimits.some((limit) => limit.code === item.code),
  );
  const indexOf = (item: (typeof diagnostics)[number]) =>
    typeof item === "object" &&
    "index" in item &&
    typeof item.index === "number" &&
    item.index > 0
      ? item.index
      : undefined;
  return (
    <>
      {groups.length > 0 && (
        <Notice tone="warning" title="仅导入连接选项">
          {
            <ul className="source-import-limits list-disc space-y-2 pl-5 text-sm">
              {groups.map((group) => {
                const indexes = group.items.flatMap(
                  (item) => indexOf(item) ?? [],
                );
                return (
                  <li key={group.code}>
                    <span>{group.text}</span>
                    {group.items.length > 1 && (
                      <span>（{group.items.length} 条提示）</span>
                    )}
                    {indexes.length > 0 && (
                      <div>原始条目：第 {indexes.join("、")} 项</div>
                    )}
                  </li>
                );
              })}
            </ul>
          }
        </Notice>
      )}
      {other.map((item, index) => (
        <Notice key={index} tone="warning" title="导入需注意">
          {
            <>
              {indexOf(item) ? `第 ${indexOf(item)} 项：` : ""}
              {diagnosticText(item)}
            </>
          }
        </Notice>
      ))}
    </>
  );
}
function Changes({ title, items }: { title: string; items: SourceChange[] }) {
  const [page, setPage] = useState(1);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 12)));
  if (!items.length) return null;
  return (
    <section className="source-change-section my-6 space-y-3 [&>h3]:text-sm [&>h3]:font-medium">
      <h3 className="flex flex-wrap items-baseline gap-2">
        <span>{title}</span>{" "}
        <span className="text-muted-foreground">{items.length}</span>
      </h3>
      <ul className="source-change-list divide-y overflow-hidden rounded-lg border [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere">
        {items.slice((currentPage - 1) * 12, currentPage * 12).map((item) => (
          <li key={item.id}>
            <span className="source-change-identity flex min-w-0 flex-col gap-1">
              <span>{item.name}</span>
              {item.beforeConnection && (
                <small className="muted text-sm text-muted-foreground">
                  {item.beforeConnection}
                </small>
              )}
              {item.afterConnection &&
                item.afterConnection !== item.beforeConnection && (
                  <small className="muted text-sm text-muted-foreground">
                    {item.beforeConnection ? "→ " : ""}
                    {item.afterConnection}
                  </small>
                )}
            </span>
            {item.fields?.length ? (
              <span className="source-change-fields flex flex-wrap gap-1">
                {item.fields.map((field) => (
                  <Badge key={field} variant="secondary">
                    {sourceChangeFields[field] || "连接设置"}
                  </Badge>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length > 12 && (
        <PageNavigation
          page={currentPage}
          pageSize={12}
          total={items.length}
          onPageChange={setPage}
        />
      )}
    </section>
  );
}
interface SourceUpdateReviewProps {
  source: Source | null;
  recovery?: SourceApplyRecovery;
  onClose: (source?: Source) => void;
  onAccepted?: (receipt: SourceAcceptanceReceipt, source: Source) => void;
  onRejected?: (source: Source) => void;
  /** Explicit use of a read-back accepted snapshot, never an acceptance receipt. */
  onUseCurrent?: (source: Source) => void;
}
export function SourceUpdateReview(props: SourceUpdateReviewProps) {
  return props.source ? (
    <SourceReviewSession
      key={`${props.source.id}/${props.source.revision}/${props.source.candidate?.id}`}
      {...props}
      source={props.source}
    />
  ) : null;
}
function SourceReviewSession({
  source: initial,
  recovery,
  onClose,
  onAccepted,
  onRejected,
  onUseCurrent,
}: Omit<SourceUpdateReviewProps, "source"> & {
  source: Source;
}) {
  const client = useQueryClient();
  const message = toast;
  const [source, setSource] = useState(initial);
  const [needsVerification, setNeedsVerification] = useState(
    !!recovery || !initial.candidate,
  );
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [operationError, setOperationError] = useState<Error | null>(
    recovery?.error ?? null,
  );
  const alive = useRef(true);
  const running = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const attempted = useRef<{
    id: string;
    revision?: string;
    conflict: boolean;
  } | null>(
    recovery
      ? {
          id: recovery.candidateId,
          revision: recovery.sourceRevision,
          conflict: recovery.conflict,
        }
      : null,
  );
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const invalidate = () => {
    for (const key of [
      "sources",
      "collections",
      "profiles",
      "outputs",
      "overview",
    ])
      client.invalidateQueries({ queryKey: [key] });
  };
  const validResult = <T extends Source>(value: T) => {
    if (!value || value.id !== initial.id || !value.revision)
      throw new Error("来源返回的状态不完整，请核对当前状态。");
    return value;
  };
  const decision = useMutation({
    onMutate: (action) => {
      if (action === "accept") invalidateOutputInputs(client);
    },
    mutationFn: async (action: "accept" | "reject") => {
      const reviewed = source;
      attempted.current = {
        id: reviewed.candidate!.id,
        revision: reviewed.revision,
        conflict: false,
      };
      const result = validResult(
        await post<SourceApplicationResult>(
          action === "accept"
            ? `/me/sources/${encodeURIComponent(reviewed.id)}/apply`
            : `/me/sources/${encodeURIComponent(reviewed.id)}/candidate/reject`,
          {
            candidateId: reviewed.candidate!.id,
            sourceRevision: reviewed.revision,
          },
        ),
      );
      if (
        result.candidate ||
        (action === "accept" && (!result.enabled || !result.snapshot))
      )
        throw new Error("来源的当前状态需要核对。");
      return {
        source: result,
        receipt:
          action === "accept"
            ? sourceAcceptanceReceipt(reviewed, result)
            : null,
      };
    },
    onSuccess: ({ source: result, receipt }, action) => {
      invalidate();
      if (!alive.current) return;
      if (action === "accept" && receipt && onAccepted)
        onAccepted(receipt, result);
      else if (action === "reject" && onRejected) onRejected(result);
      else {
        message.success(
          action === "accept"
            ? "来源已更新，已发布订阅未改变"
            : result.snapshot
              ? "已保留原有选项"
              : "未导入候选选项，来源输入仍已保存",
        );
        onClose(result);
      }
    },
    onError: (error) => {
      if (!alive.current) return;
      if (attempted.current)
        attempted.current.conflict =
          error instanceof APIError && error.status === 409;
      setNeedsVerification(true);
      setOperationError(error);
    },
    onSettled: (_data, _error, action) => {
      if (action === "accept") invalidateOutputInputs(client);
      running.current = false;
    },
  });
  const inspect = useMutation({
    onMutate: (action) => {
      if (action === "refresh") invalidateOutputInputs(client);
    },
    mutationFn: async (action: "verify" | "refresh") =>
      validResult(
        await (action === "verify"
          ? request<Source>(`/me/sources/${encodeURIComponent(source.id)}`)
          : post<Source>(
              `/me/sources/${encodeURIComponent(source.id)}/refresh`,
            )),
      ),
    onSuccess: (result, action) => {
      invalidate();
      if (!alive.current) return;
      setSource(result);
      setNeedsVerification(false);
      setOperationError(null);
      setNeedsRefresh(
        action === "verify" &&
          !!attempted.current?.conflict &&
          attempted.current.id === result.candidate?.id &&
          attempted.current.revision === result.revision,
      );
      decision.reset();
    },
    onError: (error, action) => {
      if (!alive.current) return;
      setOperationError(error);
      const retained =
        error instanceof APIError && error.status === 422
          ? (
              error.details as {
                source?: Source;
              }
            )?.source
          : undefined;
      if (retained?.id === source.id && retained.revision) {
        setSource(retained);
        setNeedsVerification(false);
        setNeedsRefresh(false);
      } else if (action === "refresh") setNeedsVerification(true);
    },
    onSettled: (_data, _error, action) => {
      if (action === "refresh") invalidateOutputInputs(client);
      running.current = false;
    },
  });
  const busy = decision.isPending || inspect.isPending;
  useUnsavedChanges(busy);
  const candidate = source.candidate;
  const firstImport = !source.snapshot;
  const canUseCurrent =
    source.enabled && !!source.snapshot && !candidate && !needsVerification;
  const focusSummary = () => summary.current?.focus();
  useLayoutEffect(() => {
    focusSummary();
    // A read-back can replace the pressed action within the same pointer
    // gesture. Restore the summary after that DOM transition settles.
    const owner = summary.current;
    const frame = requestAnimationFrame(() => {
      // Only recover focus lost when the pressed action disappeared. A user
      // may already have chosen Verify (or another live control) before this
      // frame; the previous transition must not take that newer focus away.
      if (owner !== summary.current || !owner?.isConnected) return;
      const focused = document.activeElement;
      if (focused === document.body || focused === document.documentElement)
        owner.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [source.revision, source.candidate?.id, needsVerification, needsRefresh]);
  const decide = (action: "accept" | "reject", detail: number) => {
    if (
      detail > 1 ||
      running.current ||
      !candidate ||
      needsVerification ||
      needsRefresh
    )
      return;
    running.current = true;
    setOperationError(null);
    decision.mutate(action);
  };
  const inspectSource = (action: "verify" | "refresh", detail: number) => {
    if (detail > 1 || running.current) return;
    running.current = true;
    setOperationError(null);
    inspect.mutate(action);
  };
  const stale = attempted.current?.conflict;
  return (
    <TaskSheet
      title={
        candidate ? (firstImport ? "查看导入变化" : "查看变化") : "核对来源状态"
      }
      open
      footer={
        <div
          className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2"
          onKeyDownCapture={(event) => {
            if (event.repeat && (event.key === "Enter" || event.key === " "))
              event.preventDefault();
          }}
        >
          {candidate ? (
            <>
              <ActionButton
                key="reject-candidate"
                aria-label={firstImport ? "忽略本次更新" : "忽略本次更新"}
                disabled={busy || needsVerification || needsRefresh}
                onClick={(event) => decide("reject", event.detail)}
                variant="outline"
              >
                {firstImport ? "忽略本次更新" : "忽略本次更新"}
              </ActionButton>
              <ActionButton
                key="accept-candidate"
                aria-label={firstImport ? "应用更新" : "应用更新"}
                aria-busy={
                  decision.isPending && decision.variables === "accept"
                }
                disabled={busy || needsVerification || needsRefresh}
                onClick={(event) => decide("accept", event.detail)}
                variant="default"
                pending={
                  !!(decision.isPending && decision.variables === "accept")
                }
              >
                {firstImport ? "应用更新" : "应用更新"}
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                key="return-current"
                disabled={busy}
                onClick={() => onClose(source)}
                variant="outline"
              >
                {onUseCurrent ? "返回草稿" : "返回来源"}
              </ActionButton>
              {onUseCurrent && canUseCurrent && (
                <ActionButton
                  key="use-current"
                  aria-label="使用当前节点"
                  disabled={busy}
                  onClick={(event) => {
                    if (event.detail <= 1 && !running.current)
                      onUseCurrent(source);
                  }}
                  variant="default"
                >
                  使用当前节点
                </ActionButton>
              )}
            </>
          )}
        </div>
      }
      onOpenChange={(nextOpen) => {
        if (!nextOpen)
          (() => {
            if (!running.current) onClose(source);
          })();
      }}
      onReady={() =>
        ((open) => {
          if (open) focusSummary();
        })(true)
      }
      onClosed={() =>
        ((open) => {
          if (open) focusSummary();
        })(false)
      }
      size="lg"
    >
      <div
        ref={summary}
        tabIndex={-1}
        aria-label="来源检查摘要"
        className="source-review-summary rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <p className="source-update-intro mb-6 flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-4 wrap-anywhere [&>span]:text-sm [&>span]:text-muted-foreground">
          <strong>{source.name}</strong>
          <span>
            {candidate
              ? firstImport
                ? `${candidate.diff.afterCount} 个待导入选项`
                : `${candidate.diff.beforeCount} 个选项 → ${candidate.diff.afterCount} 个选项`
              : source.snapshot
                ? `${source.snapshot.endpoints.length} 个当前节点`
                : "尚无可用节点"}
          </span>
        </p>
        {!candidate && <p role="status">当前没有待检查内容</p>}
      </div>
      {needsVerification && (
        <Notice
          tone="warning"
          title={
            stale
              ? "来源或相关选择已变化"
              : attempted.current
                ? "尚未确认这次选择的结果"
                : "先核对当前来源状态"
          }
          action={
            <ActionButton
              aria-label="核对当前状态"
              aria-busy={inspect.isPending}
              onClick={(event) => inspectSource("verify", event.detail)}
              variant="outline"
              pending={!!inspect.isPending}
            >
              核对当前状态
            </ActionButton>
          }
        >
          {"本次仅核对已保存的来源状态。获取最新订阅内容需另行刷新来源。"}
        </Notice>
      )}
      {needsRefresh && (
        <Notice
          tone="warning"
          title="待检查内容尚未更新"
          action={
            <ActionButton
              aria-label="重新获取来源"
              aria-busy={inspect.isPending}
              onClick={(event) => inspectSource("refresh", event.detail)}
              variant="outline"
              pending={!!inspect.isPending}
            >
              重新获取来源
            </ActionButton>
          }
        >
          {"相关选择已变化。重新获取来源后，请检查新的内容。"}
        </Notice>
      )}
      {operationError && (
        <Notice
          className="form-error my-3"
          tone="error"
          title={operationError.message}
        />
      )}
      {sourceIssueText(source) && !candidate && (
        <Notice
          tone="warning"
          title={
            sourceStatusUnknown(source)
              ? "来源状态待确认"
              : "最近一次导入未完成"
          }
        >
          {
            <>
              {sourceIssueText(source)}
              {source.snapshot && sourceHasFailure(source) && (
                <p>导入失败时保留之前的节点，可修正输入后重试。</p>
              )}
            </>
          }
        </Notice>
      )}
      {!source.enabled && (
        <Notice tone="warning" title="来源已暂停">
          {"启用来源后才能使用其中的连接选项。"}
        </Notice>
      )}
      {candidate && (
        <>
          {candidate.diff.afterCount === 0 && (
            <Notice tone="warning" title="此来源现在不含连接选项">
              {firstImport
                ? "没有可导入的连接选项。"
                : "应用后将移除这个来源的全部选项。依赖它们的选择需要重新调整。"}
            </Notice>
          )}
          <Changes title="移除" items={candidate.diff.removed} />
          <Changes title="连接变更" items={candidate.diff.connectionChanged} />
          <Changes title="新增" items={candidate.diff.added} />
          <Changes
            title="名称变更"
            items={candidate.diff.renamed.map((item) => ({
              ...item,
              fields: undefined,
            }))}
          />
          {candidate.diff.reordered && (
            <p className="muted text-sm text-muted-foreground">
              来源中的选项顺序发生了变化。
            </p>
          )}
          <ImportDiagnostics diagnostics={candidate.diagnostics} />
          {candidate.affected.length > 0 && (
            <section className="source-change-section my-6 space-y-3 [&>h3]:text-sm [&>h3]:font-medium">
              <h3>相关选择</h3>
              <ul className="source-change-list divide-y overflow-hidden rounded-lg border [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere">
                {candidate.affected.map((item, index) => (
                  <li key={`${item.kind}-${item.id}-${index}`}>
                    <span>
                      {item.name}
                      {item.profileName && (
                        <small className="muted block text-sm text-muted-foreground">
                          {item.profileName}
                        </small>
                      )}
                    </span>
                    <Badge variant="secondary">
                      {kinds[item.kind] || "相关配置"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="source-update-consequence mt-6 space-y-2 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
            <p>
              {firstImport
                ? "应用后，这些选项可用于配置和预览。"
                : "应用后，配置和预览将使用新选项。"}
            </p>
            <p>现有草稿保留当前选择，已发布订阅保留原版本。</p>
            {firstImport && (
              <p>忽略更新或稍后处理时，已保存的来源输入仍会保留。</p>
            )}
          </div>
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              disabled={busy}
              onClick={() => onClose(source)}
              variant="link"
            >
              稍后处理
            </ActionButton>
          </div>
        </>
      )}
    </TaskSheet>
  );
}
