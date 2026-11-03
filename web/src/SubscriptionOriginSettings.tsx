import { TaskDialog } from "@/ui-patterns/task-overlays";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useUnsavedChanges } from "./navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, post, put, request } from "./api";
import { dateLabel } from "./model";
import { ErrorNotice, KeyValue, QueryState, Section } from "./components";
interface OriginState {
  revision: number;
  configuredRevision: number;
  draftOrigin: string;
  effectiveRevision: number;
  effectiveOrigin: string;
  defaultOrigin: string;
  verificationStatus:
    "unverified" | "verified" | "expired" | "failed" | "not-required";
  verifiedAt?: string;
  verificationExpiresAt?: string;
  activatedAt?: string;
  lastFailure?: string;
  currentLinkExample: string;
  proposedLinkExample: string;
  tokensUnchanged: boolean;
}
const path = "/admin/subscription-origin",
  key = ["subscription-origin"];
export function SubscriptionOriginSettings() {
  const query = useQuery({
    queryKey: key,
    queryFn: () => request<OriginState>(path),
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  return (
    <Section
      title="订阅域名"
      description="单独设置用户复制订阅链接时使用的地址，不改变控制台登录地址。"
    >
      {query.data && query.error && (
        <Notice
          tone="error"
          title={query.error.message}
          action={
            <ActionButton onClick={() => query.refetch()} variant="outline">
              重新读取设置
            </ActionButton>
          }
        />
      )}
      <QueryState
        loading={query.isPending} paused={query.isPaused} loadingLayout="form"
        error={query.data ? null : query.error}
        retry={() => query.refetch()}
      >
        {query.data && (
          <OriginForm state={query.data} refresh={() => query.refetch()} />
        )}
      </QueryState>
    </Section>
  );
}
function OriginForm({
  state,
  refresh,
}: {
  state: OriginState;
  refresh: () => unknown;
}) {
  const [origin, setOrigin] = useState(state.draftOrigin),
    [review, setReview] = useState<OriginState | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const reviewPresentation = useRef<OriginState | null>(null);
  useLayoutEffect(() => {
    if (review) reviewPresentation.current = review;
  }, [review]);
  const displayedReview = review || reviewPresentation.current;
  const client = useQueryClient(),
    message = toast;
  const accept = (next: OriginState) => {
    client.setQueryData(key, next);
    setError(null);
  };
  const onError = (error: Error) => {
    setError(error);
    if (
      error instanceof APIError &&
      (error.status === 409 || error.status === 422)
    ) {
      setReview(null);
      setConfirmed(false);
      refresh();
    }
  };
  const save = useMutation({
    mutationFn: () =>
      put<OriginState>(path, {
        origin: origin.trim(),
        expectedRevision: state.revision,
      }),
    onSuccess: (next) => {
      accept(next);
      setOrigin(next.draftOrigin);
      message.success("域名草稿已保存，当前订阅地址未改变");
    },
    onError,
  });
  const verify = useMutation({
    mutationFn: () =>
      post<OriginState>(`${path}/verify`, { expectedRevision: state.revision }),
    onSuccess: (next) => {
      accept(next);
      message.success("已验证 HTTPS 地址属于当前实例");
    },
    onError,
  });
  const activate = useMutation({
    mutationFn: () =>
      post<OriginState>(`${path}/activate`, {
        expectedRevision: review!.revision,
      }),
    onSuccess: (next) => {
      accept(next);
      setReview(null);
      client.invalidateQueries({ queryKey: ["outputs"] });
      message.success("新复制的订阅链接将使用所选地址");
    },
    onError,
  });
  const busy = save.isPending || verify.isPending || activate.isPending,
    dirty = origin.trim() !== state.draftOrigin,
    pending = state.configuredRevision !== state.effectiveRevision;
  useUnsavedChanges(dirty || busy);
  const ready =
    state.verificationStatus === "not-required" ||
    state.verificationStatus === "verified";
  const proofLabel = {
    unverified: "尚未验证草稿",
    verified: "草稿已验证",
    expired: "再次启用前需要重新验证",
    failed: "草稿验证未通过",
    "not-required": "默认地址无需验证",
  }[state.verificationStatus];
  return (
    <>
      <ErrorNotice error={error} />
      <div className="space-y-3 border-b pb-5">
        <dl className="subscription-origin-summary max-w-3xl space-y-3 text-sm">
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
            <dt className="text-muted-foreground">当前订阅地址</dt>
            <dd className="min-w-0 wrap-anywhere">
              <strong>
                {state.effectiveOrigin || state.defaultOrigin || "跟随当前访问地址"}
              </strong>
              {state.activatedAt && (
                <small className="block text-sm text-muted-foreground">
                  启用于 {dateLabel(state.activatedAt)}
                </small>
              )}
            </dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
            <dt className="text-muted-foreground">当前链接示例</dt>
            <dd className="min-w-0 font-mono text-xs leading-relaxed wrap-anywhere">
              {state.currentLinkExample}
            </dd>
          </div>
        </dl>
      </div>
      <div className="space-y-3">
        <label className="grid max-w-2xl gap-2 text-sm font-medium">
          订阅域名草稿
          <Input
            aria-label="订阅域名草稿"
            value={origin}
            disabled={busy}
            placeholder="https://subscribe.example.com"
            onChange={(e) => {
              setOrigin(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          只填写公开 HTTPS 域名与可选端口，不含路径。留空并启用后使用默认地址：
          {state.defaultOrigin || "当前访问地址"}。
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          请先由运维配置 DNS、有效 HTTPS
          证书与反向代理。这里仅保存并验证链接地址，不修改 DNS 或证书。
        </p>
        <div className={"flex flex-wrap items-center gap-2"}>
          <ActionButton
            pending={save.isPending}
            disabled={busy && !save.isPending}
            onClick={() => save.mutate()}
            variant="outline"
          >
            保存域名草稿
          </ActionButton>
          {dirty && <Badge variant="secondary">尚未保存</Badge>}
        </div>
      </div>
      {state.configuredRevision > 0 && (
        <div className="space-y-4 border-t pt-5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            已保存的草稿 {pending && <Badge variant="secondary">待启用</Badge>}
          </h3>
          <KeyValue label="拟用链接">
            <span className="font-mono text-xs leading-relaxed wrap-anywhere">{state.proposedLinkExample}</span>
          </KeyValue>
          <p>
            {proofLabel}
            {state.verifiedAt && (
              <small className="block text-sm text-muted-foreground">
                上次验证 {dateLabel(state.verifiedAt)}
                ；验证仅用于这次启用，不代表持续可用性。
              </small>
            )}
          </p>
          {state.verificationStatus === "failed" &&
            state.lastFailure &&
            !error && (
              <Notice
                tone="error"
                title="检查域名解析、HTTPS 证书与 /feed 路由后重试"
              >
                {state.lastFailure}
              </Notice>
            )}
          {state.draftOrigin && <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">验证结果有效 5 分钟；过期后需重新验证再启用。</p>}
          <div className={"flex flex-wrap items-center gap-2"}>
            {state.draftOrigin && (
              <ActionButton
                disabled={dirty || busy}
                pending={verify.isPending}
                onClick={() => verify.mutate()}
                variant="outline"
              >
                验证 HTTPS 与实例
              </ActionButton>
            )}
            <ActionButton
              disabled={dirty || busy || !ready || !pending}
              onClick={() => {
                setReview(structuredClone(state));
                setConfirmed(false);
              }}
              variant="default"
            >
              启用已保存草稿
            </ActionButton>
            <ActionButton
              disabled={busy}
              onClick={() => refresh()}
              variant="ghost"
            >
              刷新状态
            </ActionButton>
          </div>
        </div>
      )}
      <TaskDialog
        title="启用订阅地址"
        bodyProps={{ className: "space-y-5 text-sm leading-relaxed [overflow-wrap:anywhere]" }}
        open={!!review}
        contentProps={{ inert: !review }}
        onClosed={() => { if (!review) reviewPresentation.current = null; }}
        footer={
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              disabled={activate.isPending}
              onClick={() => setReview(null)}
              variant="outline"
            >
              取消
            </ActionButton>
            <ActionButton
              disabled={!confirmed}
              pending={activate.isPending}
              onClick={() => activate.mutate()}
              variant="default"
            >
              确认启用
            </ActionButton>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) (() => !activate.isPending && setReview(null))();
        }}
      >
        {displayedReview && (
          <>
            <KeyValue label="当前链接">{displayedReview.currentLinkExample}</KeyValue>
            <KeyValue label="新复制的链接">
              {displayedReview.proposedLinkExample}
            </KeyValue>
            <p>
              订阅令牌不会更换。旧链接只有在旧域名的 DNS
              与代理仍指向此实例时才继续可用，不会自动跳转。若需撤销旧令牌，请另外轮换对应订阅。
            </p>
            <Label className="inline-flex items-start gap-2 text-sm leading-relaxed">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) =>
                  ((e) => setConfirmed(e.target.checked))({
                    target: { checked: checked === true },
                  })
                }
              />
              我已确认域名配置与旧链接的访问安排
            </Label>
          </>
        )}
      </TaskDialog>
    </>
  );
}
