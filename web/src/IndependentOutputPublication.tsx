import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, post, APIError } from "./api";
import type { OutputCreation } from "./types";
import type { QueryClient } from "@tanstack/react-query";
import { ErrorNotice } from "./components";
import { ActionButton } from "./ui-patterns/actions";
import { useConfirm } from "./ui-patterns/confirmations";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";

export interface IndependentOutputIntent {
  id: string;
  name?: string;
  profileId?: string;
  state:
    | "reserved"
    | "provisioning"
    | "published"
    | "cancelling"
    | "recovery_required"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
  failureCode: string;
  coverage: "managed-platform-routes";
}
export const independentTasksKey = ["independent-output-tasks"];
type Creation = OutputCreation & { previewDigest: string };
const pendingKey = ["independent-output-pending-requests"];
function forgetPending(client: QueryClient, id: string) {
  client.setQueryData<Creation[]>(pendingKey, (values) =>
    (values || []).filter((value) => value.id !== id),
  );
}
async function reserve(client: QueryClient, payload: Creation) {
  // SessionBoundary clears the cache on account replacement. Never reinsert an
  // old account's pending name/payload after that boundary has been cleared.
  client.setQueryData<Creation[]>(pendingKey, (values) => values || []);
  const scope = client.getQueryCache().find({ queryKey: pendingKey });
  const ownsScope = () =>
    scope === client.getQueryCache().find({ queryKey: pendingKey });
  try {
    const result = await post<IndependentOutputIntent>(
      "/me/outputs/independent",
      payload,
    );
    if (ownsScope()) forgetPending(client, payload.id);
    return result;
  } catch (error) {
    if (
      !(error instanceof APIError) ||
      error.status === 0 ||
      error.status >= 500
    ) {
      if (ownsScope())
        client.setQueryData<Creation[]>(pendingKey, (values) => [
          ...(values || []).filter((value) => value.id !== payload.id),
          payload,
        ]);
      throw new Error("尚未确认创建结果。重试会核对同一份订阅，不会重复创建。");
    }
    throw error;
  } finally {
    if (ownsScope())
      void client.invalidateQueries({ queryKey: independentTasksKey });
  }
}
function PendingCreation({ creation }: { creation: Creation }) {
  const client = useQueryClient();
  const retry = useMutation({ mutationFn: () => reserve(client, creation) });
  return (
    <li className="space-y-2 border-b py-3">
      <p className="text-sm font-medium">{creation.name}</p>
      <p className="text-sm text-muted-foreground">
        创建结果待确认。核对进度或重试均使用同一份请求。
      </p>
      <ErrorNotice error={retry.error} />
      <ActionButton
        variant="outline"
        pending={retry.isPending}
        disabled={retry.isPending}
        onClick={() => retry.mutate()}
      >
        重试「{creation.name}」创建
      </ActionButton>
    </li>
  );
}

const isPending = (item: IndependentOutputIntent) =>
  !["published", "cancelled"].includes(item.state);
function stateLabel(item: IndependentOutputIntent) {
  if (item.state === "published") return "已发布";
  if (item.state === "cancelled") return "已停止";
  if (item.state === "recovery_required") return "等待服务器恢复后清理";
  if (item.state === "cancelling") return "正在停止并清理";
  if (item.failureCode === "waiting_for_rate_limit") return "排队中，请稍候";
  if (item.failureCode === "waiting_for_confirmed_service")
    return "等待服务器应用配置";
  if (item.state === "reserved") return "等待创建";
  if (item.state === "provisioning") return "正在配置独立计量";
  return "状态待确认";
}
function IndependentTask({ item }: { item: IndependentOutputIntent }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const cancel = useMutation({
    mutationFn: () =>
      post<IndependentOutputIntent>(
        `/me/outputs/independent/${encodeURIComponent(item.id)}/cancel`,
        {},
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: independentTasksKey });
      void client.invalidateQueries({ queryKey: ["outputs"] });
    },
  });
  const stoppable = ["reserved", "provisioning", "published"].includes(
    item.state,
  );
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words text-sm font-medium">
          {item.name || `订阅 ${item.id.slice(-8)}`}
        </p>
        <Badge variant="secondary">{stateLabel(item)}</Badge>
        {item.state === "recovery_required" && (
          <p className="text-sm text-muted-foreground">
            链接已停用。服务器状态尚未确认，恢复后会继续清理；如持续未完成，请联系管理员。
          </p>
        )}
        {item.failureCode === "provisioning_timeout" && (
          <p className="text-sm text-muted-foreground">
            创建超时，正在撤回未完成的配置。
          </p>
        )}
        {item.failureCode === "authorization_changed" && (
          <p className="text-sm text-muted-foreground">
            创建权限已变化，正在撤回未完成的配置。
          </p>
        )}
        {item.state === "cancelling" && (
          <p className="text-sm text-muted-foreground">
            链接已停用，正在移除服务器上的独立凭据。
          </p>
        )}
        {item.state === "provisioning" && (
          <p className="text-sm text-muted-foreground">
            全部线路确认应用后才会提供订阅链接。
          </p>
        )}
        <ErrorNotice error={cancel.error} />
      </div>
      {stoppable && (
        <ActionButton
          variant="outline"
          pending={cancel.isPending}
          disabled={cancel.isPending}
          onClick={() =>
            confirm({
              title:
                item.state === "published" ? "停止独立订阅？" : "取消创建？",
              description: `「${item.name || "这份订阅"}」的链接将立即停用，服务器上的独立凭据会随后移除。已有连接可能中断，其他订阅保持不变。`,
              confirmLabel:
                item.state === "published" ? "停止订阅" : "取消创建",
              destructive: true,
              onConfirm: () => cancel.mutateAsync(),
            })
          }
        >
          {item.state === "published" ? "停止订阅" : "取消创建"}
        </ActionButton>
      )}
    </li>
  );
}
export function IndependentOutputTasks() {
  const client = useQueryClient();
  const [visibleCount, setVisibleCount] = useState(10);
  const pending = useQuery<Creation[]>({
    queryKey: pendingKey,
    queryFn: async () => [],
    initialData: [],
    enabled: false,
    gcTime: Infinity,
  });
  const tasks = useQuery({
    queryKey: independentTasksKey,
    queryFn: async () => {
      const value = await request<{ items: IndependentOutputIntent[] }>(
        "/me/outputs/independent",
      );
      if (!Array.isArray(value?.items)) throw new Error("无法读取创建进度");
      return value;
    },
    refetchInterval: (query) =>
      pending.data.length || query.state.data?.items.some(isPending)
        ? 3000
        : false,
  });
  useEffect(() => {
    for (const item of tasks.data?.items || []) {
      if (pending.data.some((value) => value.id === item.id))
        forgetPending(client, item.id);
    }
  }, [tasks.data, pending.data, client]);
  const orderedTasks = [...(tasks.data?.items || [])].sort(
    (a, b) =>
      Number(isPending(b)) - Number(isPending(a)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  const publishedIDs = tasks.data?.items
    .filter((item) => item.state === "published")
    .map((item) => item.id)
    .sort()
    .join("|");
  useEffect(() => {
    if (publishedIDs !== undefined)
      void client.invalidateQueries({ queryKey: ["outputs"] });
  }, [publishedIDs, client]);
  if (!tasks.isError && !tasks.data?.items.length && !pending.data.length)
    return null;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>独立计量订阅</CardTitle>
      </CardHeader>
      <CardContent>
        {!!pending.data.length && (
          <ul>
            {pending.data.map((creation) => (
              <PendingCreation key={creation.id} creation={creation} />
            ))}
          </ul>
        )}
        {tasks.isError ? (
          <div className="space-y-2">
            <p className="text-sm">
              暂时无法读取创建进度，已提交的任务不会因此取消。
            </p>
            <ActionButton variant="outline" onClick={() => tasks.refetch()}>
              重试进度
            </ActionButton>
          </div>
        ) : (
          <ul className="divide-y">
            {orderedTasks.slice(0, visibleCount).map((item) => (
              <IndependentTask key={item.id} item={item} />
            ))}
          </ul>
        )}
        {(tasks.data?.items.length || 0) > visibleCount && (
          <ActionButton
            variant="outline"
            onClick={() => setVisibleCount((value) => value + 10)}
          >
            查看更多任务
          </ActionButton>
        )}
      </CardContent>
    </Card>
  );
}

export function IndependentOutputCreate({
  creation,
  enabled,
  onAccepted,
  onLocked,
}: {
  creation: OutputCreation & { previewDigest: string };
  enabled: boolean;
  onAccepted: () => void;
  onLocked: (locked: boolean) => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const attempt = useRef<typeof creation | null>(null);
  const latest = useRef({ enabled, creation });
  latest.current = { enabled, creation };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!alive.current || !latest.current.enabled)
        throw new Error("请先核对分流配置，再继续创建。");
      const payload = attempt.current || latest.current.creation;
      attempt.current = payload;
      onLocked(true);
      try {
        return await reserve(client, payload);
      } catch (error) {
        if (
          !(error instanceof APIError) ||
          error.status === 0 ||
          error.status >= 500
        ) {
          if (alive.current) setUncertain(true);
          throw new Error(
            "尚未确认创建结果。重试会核对同一份订阅，不会重复创建。",
          );
        }
        if (!uncertain) {
          attempt.current = null;
          if (alive.current) onLocked(false);
        }
        throw error;
      }
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: independentTasksKey });
      if (alive.current) {
        onLocked(false);
        onAccepted();
      }
    },
  });
  return (
    <div className="w-full space-y-2">
      <ErrorNotice error={mutation.error} />
      <ActionButton
        className="min-h-11 w-full"
        disabled={!enabled || mutation.isPending}
        pending={mutation.isPending}
        onClick={() => {
          if (uncertain) {
            mutation.mutate();
            return;
          }
          const reviewed = JSON.stringify(creation);
          confirm({
            title: `为「${creation.name}」创建独立计量订阅？`,
            description:
              "仅支持平台受管线路。会生成新的连接凭据并重载相关服务器，现有连接可能短暂中断。原订阅不变；创建完成后需在客户端导入新订阅。",
            confirmLabel: "创建独立计量订阅",
            onConfirm: async () => {
              if (
                !alive.current ||
                !latest.current.enabled ||
                reviewed !== JSON.stringify(latest.current.creation)
              )
                throw new Error("发布选项已变化，请重新确认。");
              await mutation.mutateAsync();
            },
          });
        }}
      >
        {uncertain ? "重试同一份创建请求" : "创建独立计量订阅"}
      </ActionButton>
    </div>
  );
}
