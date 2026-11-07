import { SettingsGroup, SettingsRow } from "@/ui-patterns/settings-group";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useUnsavedChanges } from "./navigation";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, post, put, request } from "./api";
import { dateLabel } from "./model";
import { KeyValue, QueryState } from "./components";
type OriginTask = "save" | "verify" | "activate";
const originErrorMessages: Record<
  string,
  { title: string; repair: string; field?: boolean }
> = {
  "400:subscription origin must be HTTPS without credentials, path, query or fragment":
    {
      title: "订阅地址格式不正确",
      repair:
        "请使用 HTTPS 域名，可带端口；移除用户名、密码、路径、查询参数和片段。",
      field: true,
    },
  "400:subscription origin must use a public HTTPS address": {
    title: "订阅地址不能使用私有网络",
    repair: "请填写公开可访问的 HTTPS 域名，不要使用本机或私有网络地址。",
    field: true,
  },
  "400:subscription origin is too long": {
    title: "订阅地址过长",
    repair: "地址过长，请缩短域名或移除多余内容后重试。",
    field: true,
  },
  "409:settings changed; reload before saving": {
    title: "域名设置已被更新",
    repair: "当前输入已保留。请核对重新读取的设置后再保存。",
  },
  "409:settings changed or no draft exists; reload before continuing": {
    title: "已保存草稿发生变化",
    repair: "请核对重新读取的草稿，再继续验证或启用。",
  },
  "409:verify the saved draft again before activating; verification expires after five minutes":
    {
      title: "需要重新验证草稿",
      repair:
        "验证结果仅在通过后的 5 分钟内有效。请重新验证 HTTPS 与实例后再启用。",
    },
  "422:Could not verify this instance. Check public DNS, the HTTPS certificate and /feed routing, then verify again.":
    {
      title: "无法确认此地址指向当前实例",
      repair: "请检查公开 DNS、HTTPS 证书和 /feed 路由，然后重新验证。",
    },
};
function originErrorCopy(error: Error) {
  return error instanceof APIError
    ? originErrorMessages[`${error.status}:${error.message}`]
    : undefined;
}
function OriginError({ error, task }: { error: Error; task: OriginTask }) {
  const copy = originErrorCopy(error);
  return (
    <Notice
      tone="error"
      title={
        copy?.title ||
        {
          save: "保存域名草稿失败",
          verify: "验证域名失败",
          activate: "启用域名失败",
        }[task]
      }
    >
      {copy ? (
        <>
          <p>{copy.repair}</p>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer">技术详情</summary>
            <p className="mt-2 break-words">{error.message}</p>
          </details>
        </>
      ) : (
        <p>{error.message}</p>
      )}
    </Notice>
  );
}
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
// Validate transport data before it can authorize a revision-fenced write.
function validatedOriginState(value: unknown): OriginState {
  const v = value as OriginState | null;
  if (
    !v || typeof v !== "object" ||
    ![v.revision, v.configuredRevision, v.effectiveRevision].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    v.configuredRevision > v.revision || v.effectiveRevision > v.configuredRevision ||
    ![v.draftOrigin, v.effectiveOrigin, v.defaultOrigin,
      v.currentLinkExample, v.proposedLinkExample].every((s) => typeof s === "string") ||
    !["unverified", "verified", "expired", "failed", "not-required"].includes(v.verificationStatus) ||
    v.tokensUnchanged !== true ||
    v.currentLinkExample !== `${v.effectiveOrigin || v.defaultOrigin}/feed/{existing-token}` ||
    v.proposedLinkExample !== `${v.draftOrigin || v.defaultOrigin}/feed/{existing-token}` ||
    [v.verifiedAt, v.verificationExpiresAt, v.activatedAt].some(
      (s) => s !== undefined && (typeof s !== "string" || !Number.isFinite(Date.parse(s))),
    ) || (v.lastFailure !== undefined && typeof v.lastFailure !== "string")
  ) throw new Error("域名设置响应不完整，请重新读取设置。");
  return v;
}
const path = "/admin/subscription-origin",
  key = ["subscription-origin"];
export function SubscriptionOriginSettings() {
  const query = useQuery({
    queryKey: key,
    queryFn: async () => validatedOriginState(await request<unknown>(path)),
    select: validatedOriginState,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  return (
    <SettingsGroup
      title="订阅域名"
      description="设置用户复制订阅链接时使用的地址，保留控制台登录地址。"
    >
      {query.data && query.error && (
        <div className="px-4 pt-4 sm:px-5">
          <Notice
            tone="error"
            title={query.error.message}
            action={
              <ActionButton onClick={() => query.refetch()} variant="outline">
                重新读取设置
              </ActionButton>
            }
          />
        </div>
      )}
      <div className={!query.data ? "p-4 sm:p-5" : undefined}>
        <QueryState
          loading={query.isPending}
          paused={query.isPaused}
          loadingLayout="field"
          error={query.data ? null : query.error}
          retry={() => query.refetch()}
        >
          {query.data && (
            <OriginForm state={query.data} readBlocked={!!query.error} refresh={() => query.refetch()} />
          )}
        </QueryState>
      </div>
    </SettingsGroup>
  );
}
function OriginForm({
  state,
  readBlocked,
  refresh,
}: {
  state: OriginState;
  readBlocked: boolean;
  refresh: () => Promise<{ data?: OriginState; error: Error | null }>;
}) {
  const [origin, setOrigin] = useState(state.draftOrigin),
    [review, setReview] = useState<OriginState | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [errorTask, setErrorTask] = useState<OriginTask>("save");
  const [uncertain, setUncertain] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryError, setRecoveryError] = useState<Error | null>(null);
  const writeLock = useRef(false);
  const uncertainLock = useRef(false);
  const recoveryRevision = useRef(state.revision);
  const readLock = useRef(false);
  const runWrite = (write: () => void) => {
    if (writeLock.current || uncertainLock.current || readLock.current || readBlocked) return;
    writeLock.current = true;
    write();
  };
  const reconcile = async () => {
    if (readLock.current || writeLock.current) return;
    readLock.current = true;
    setReconciling(true);
    setRecoveryError(null);
    try {
      const result = await refresh();
      if (result.error) throw result.error;
      const next = validatedOriginState(result.data);
      if (next.revision < recoveryRevision.current)
        throw new Error("读取的域名设置已过时，请重新读取设置。");
      // A read reports current state, not whether this particular request committed.
      // Never replay activation or retain consent to the previous review.
      setReview(null);
      setConfirmed(false);
      setError(null);
      setUncertain(false);
      uncertainLock.current = false;
      client.invalidateQueries({ queryKey: ["outputs"] });
    } catch (error) {
      setRecoveryError(error instanceof Error ? error : new Error("无法读取域名设置。"));
    } finally {
      readLock.current = false;
      setReconciling(false);
    }
  };
  const inputErrorID = useId();
  const reviewPresentation = useRef<OriginState | null>(null);
  useLayoutEffect(() => {
    if (review) reviewPresentation.current = review;
  }, [review]);
  const displayedReview = review || reviewPresentation.current;
  const currentSource = useRef<{ review: OriginState | null; state: OriginState } | null>(null);
  useLayoutEffect(() => {
    currentSource.current = { review, state };
    return () => { currentSource.current = null; };
  }, [review, state]);
  const client = useQueryClient(),
    message = toast;
  const accept = (next: OriginState) => {
    client.setQueryData(key, next);
    setError(null);
  };
  const onError = (error: Error, task: OriginTask, reviewed?: OriginState) => {
    setError(error);
    setErrorTask(task);
    if (task === "activate" && (!(error instanceof APIError) ||
        error.status === 0 || error.status >= 500 ||
        (error.status >= 200 && error.status < 300))) {
      uncertainLock.current = true;
      recoveryRevision.current = Math.max(state.revision, reviewed?.revision || 0);
      setUncertain(true);
      setConfirmed(false);
      return;
    }
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
    mutationFn: async () =>
      validatedOriginState(await put<unknown>(path, {
        origin: origin.trim(),
        expectedRevision: state.revision,
      })),
    onSuccess: (next) => {
      accept(next);
      setOrigin(next.draftOrigin);
      message.success("域名草稿已保存，当前订阅地址未改变");
    },
    onError: (error) => onError(error, "save"),
    onSettled: () => { writeLock.current = false; },
  });
  const verify = useMutation({
    mutationFn: async () =>
      validatedOriginState(await post<unknown>(`${path}/verify`, { expectedRevision: state.revision })),
    onSuccess: (next) => {
      accept(next);
      message.success("已验证 HTTPS 地址属于当前实例");
    },
    onError: (error) => onError(error, "verify"),
    onSettled: () => { writeLock.current = false; },
  });
  const activate = useMutation({
    retry: false,
    mutationFn: async ({ reviewed, owner }: { reviewed: Readonly<OriginState>; owner: OriginState }) => {
      const source = currentSource.current;
      // A paused mutation can resume before React renders a newer cache value.
      // Check the authoritative snapshot as well as the mounted review owner.
      let currentRevision: number | undefined;
      try {
        currentRevision = validatedOriginState(client.getQueryData(key)).revision;
      } catch {
        // Missing or malformed state cannot authorize a write; none was sent.
      }
      if (!source || source.review !== owner || source.state.revision !== reviewed.revision ||
          currentRevision !== reviewed.revision)
        throw new APIError("settings changed or no draft exists; reload before continuing", 409);
      const next = validatedOriginState(await post<unknown>(`${path}/activate`, {
        expectedRevision: reviewed.revision,
      }));
      if (next.revision !== reviewed.revision + 1 ||
          next.configuredRevision !== reviewed.configuredRevision ||
          next.draftOrigin !== reviewed.draftOrigin ||
          next.effectiveRevision !== reviewed.configuredRevision ||
          next.effectiveOrigin !== reviewed.draftOrigin || !next.activatedAt)
        throw new Error("无法确认域名启用结果，请重新读取设置。");
      return next;
    },
    onSuccess: (next, { owner }) => {
      if (currentSource.current?.review !== owner) return;
      accept(next);
      setReview(null);
      client.invalidateQueries({ queryKey: ["outputs"] });
      message.success("新复制的订阅链接将使用所选地址");
    },
    onError: (error, { reviewed, owner }) => {
      if (currentSource.current?.review !== owner) return;
      onError(error, "activate", reviewed);
    },
    onSettled: () => { writeLock.current = false; },
  });
  const busy = save.isPending || verify.isPending || activate.isPending || uncertain || reconciling || readBlocked,
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
  const recoveryNotice = () => (
    <Notice tone="error" title="域名启用结果尚未确认" action={
      <ActionButton pending={reconciling} onClick={() => void reconcile()} variant="outline">
        重新读取设置
      </ActionButton>
    }>
      <p>请先读取当前设置，再核对是否仍需启用。读取不会重复提交。</p>
      {error && <p>启用请求：{error.message}</p>}
      {recoveryError && <p>重新读取失败：{recoveryError.message}</p>}
    </Notice>
  );
  return (
    <>
      {uncertain && !review && recoveryNotice()}
      <dl className="subscription-origin-summary divide-y">
        <SettingsRow
          label="当前订阅地址"
          description={
            state.activatedAt
              ? `启用于 ${dateLabel(state.activatedAt)}`
              : undefined
          }
        >
          <span className="font-medium">
            {state.effectiveOrigin || state.defaultOrigin || "跟随当前访问地址"}
          </span>
        </SettingsRow>
        <SettingsRow label="当前链接示例">
          <span className="font-mono text-xs leading-relaxed">
            {state.currentLinkExample}
          </span>
        </SettingsRow>
      </dl>
      <div className="space-y-3 border-t px-4 py-5 sm:px-5">
        <label className="grid max-w-2xl gap-2 text-sm font-medium">
          订阅域名草稿
          <Input
            aria-label="订阅域名草稿"
            aria-invalid={
              (errorTask === "save" &&
                !!error &&
                !!originErrorCopy(error)?.field) ||
              undefined
            }
            aria-describedby={
              errorTask === "save" && error ? inputErrorID : undefined
            }
            value={origin}
            disabled={busy}
            placeholder="https://subscribe.example.com"
            onChange={(e) => {
              setOrigin(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error && errorTask === "save" && (
          <div id={inputErrorID}>
            <OriginError error={error} task="save" />
          </div>
        )}
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          只填写公开 HTTPS 域名与可选端口，不含路径。留空并启用后使用默认地址：
          {state.defaultOrigin || "当前访问地址"}。
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          请先由运维配置 DNS、有效 HTTPS
          证书与反向代理。这里仅保存并验证链接地址，DNS 与证书由运维管理。
        </p>
        <div className={"flex flex-wrap items-center gap-2"}>
          <ActionButton
            pending={save.isPending}
            disabled={busy && !save.isPending}
            onClick={() => runWrite(() => save.mutate())}
            variant="outline"
          >
            保存域名草稿
          </ActionButton>
          {dirty && <Badge variant="secondary">尚未保存</Badge>}
        </div>
      </div>
      {state.configuredRevision > 0 && (
        <div className="space-y-4 border-t px-4 py-5 sm:px-5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            已保存的草稿 {pending && <Badge variant="secondary">待启用</Badge>}
          </h3>
          <dl className="-mx-4 divide-y border-y sm:-mx-5">
            <SettingsRow label="拟用链接">
              <span className="font-mono text-xs leading-relaxed wrap-anywhere">
                {state.proposedLinkExample}
              </span>
            </SettingsRow>
            <SettingsRow
              label="验证状态"
              description={
                state.verificationStatus === "verified"
                  ? state.verificationExpiresAt
                    ? `本次验证有效至 ${dateLabel(state.verificationExpiresAt)}；过期后需重新验证再启用。`
                    : "本次验证通过后 5 分钟内有效；过期后需重新验证再启用。"
                  : state.verificationStatus === "expired"
                    ? state.verificationExpiresAt
                      ? `验证已于 ${dateLabel(state.verificationExpiresAt)} 过期，请重新验证后再启用。`
                      : "验证已超过 5 分钟有效期，请重新验证后再启用。"
                    : state.verificationStatus === "unverified"
                      ? "验证 HTTPS 与实例后才能启用；验证结果在通过后的 5 分钟内有效。"
                      : undefined
              }
            >
              {proofLabel}
            </SettingsRow>
          </dl>
          {error && errorTask !== "save" && !review && !uncertain && (
            <OriginError error={error} task={errorTask} />
          )}
          {state.verificationStatus === "failed" &&
            state.lastFailure &&
            (!error || errorTask === "save") &&
            (originErrorCopy(new APIError(state.lastFailure, 422)) ? (
              <OriginError
                error={new APIError(state.lastFailure, 422)}
                task="verify"
              />
            ) : (
              <Notice
                tone="error"
                title="检查域名解析、HTTPS 证书与 /feed 路由后重试"
              >
                {state.lastFailure}
              </Notice>
            ))}
          <div className={"flex flex-wrap items-center gap-2"}>
            {state.draftOrigin && (
              <ActionButton
                disabled={dirty || busy}
                pending={verify.isPending}
                onClick={() => runWrite(() => verify.mutate())}
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
              disabled={save.isPending || verify.isPending || activate.isPending || uncertain || reconciling}
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
        bodyProps={{
          className:
            "space-y-5 text-sm leading-relaxed [overflow-wrap:anywhere]",
        }}
        open={!!review}
        contentProps={{ inert: !review }}
        onClosed={() => {
          if (!review) reviewPresentation.current = null;
        }}
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
              disabled={!confirmed || uncertain || reconciling || readBlocked}
              pending={activate.isPending}
              onClick={() => {
                if (!confirmed || !review) return;
                const reviewed = Object.freeze(structuredClone(review));
                runWrite(() => activate.mutate({ reviewed, owner: review }));
              }}
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
        {uncertain ? recoveryNotice() : error && errorTask === "activate" && (
          <OriginError error={error} task="activate" />
        )}
        {displayedReview && (
          <>
            <KeyValue label="当前链接">
              {displayedReview.currentLinkExample}
            </KeyValue>
            <KeyValue label="新复制的链接">
              {displayedReview.proposedLinkExample}
            </KeyValue>
            <p>
              保留当前订阅令牌。旧链接只有在旧域名的 DNS
              与代理仍指向此实例时才继续可用，不会自动跳转。若需撤销旧令牌，请另外轮换对应订阅。
            </p>
            <Label className="inline-flex items-start gap-2 text-sm leading-relaxed">
              <Checkbox
                disabled={uncertain || activate.isPending || reconciling}
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
