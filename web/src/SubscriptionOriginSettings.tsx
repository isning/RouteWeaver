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
    <SettingsGroup
      title="订阅域名"
      description="单独设置用户复制订阅链接时使用的地址，不改变控制台登录地址。"
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
            <OriginForm state={query.data} refresh={() => query.refetch()} />
          )}
        </QueryState>
      </div>
    </SettingsGroup>
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
  const [errorTask, setErrorTask] = useState<OriginTask>("save");
  const inputErrorID = useId();
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
  const onError = (error: Error, task: OriginTask) => {
    setError(error);
    setErrorTask(task);
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
    onError: (error) => onError(error, "save"),
  });
  const verify = useMutation({
    mutationFn: () =>
      post<OriginState>(`${path}/verify`, { expectedRevision: state.revision }),
    onSuccess: (next) => {
      accept(next);
      message.success("已验证 HTTPS 地址属于当前实例");
    },
    onError: (error) => onError(error, "verify"),
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
    onError: (error) => onError(error, "activate"),
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
          {error && errorTask !== "save" && (
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
            <KeyValue label="当前链接">
              {displayedReview.currentLinkExample}
            </KeyValue>
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
