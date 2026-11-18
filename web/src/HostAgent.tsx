import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { ErrorNotice, Section } from "./components";
import { Notice } from "@/ui-patterns/notice";
import { post, request } from "./api";
import { dateLabel } from "./model";
import type { AgentState, CoreInstance, HostRecord } from "./types";

interface HostAgentState {
  nodeId: string;
  phase:
    | "unregistered"
    | "awaiting-agent"
    | "online"
    | "offline"
    | "expired"
    | "revoked";
  expiresAt?: string;
  lastSeen?: string;
}
const phases: Record<HostAgentState["phase"], string> = {
  unregistered: "未接入",
  "awaiting-agent": "等待连接",
  online: "已连接",
  offline: "连接已中断",
  expired: "凭据已到期",
  revoked: "已撤销",
};
function useHostAgentState(id: string) {
  return useQuery({
    queryKey: ["host-agent", id],
    queryFn: async () => {
      const value = await request<HostAgentState>(
        `/agent/hosts/${encodeURIComponent(id)}/state`,
      );
      if (
        value.nodeId !== id ||
        !Object.prototype.hasOwnProperty.call(phases, value.phase)
      )
        throw new Error("无法确认服务器 Agent 状态，请重试");
      return value;
    },
    refetchInterval: 10000,
  });
}
export function HostAgentPanel({
  host,
  onConnect,
  disabled = false,
}: {
  host: HostRecord;
  onConnect: () => void;
  disabled?: boolean;
}) {
  const query = useHostAgentState(host.id);
  return (
    <Section
      title="服务器 Agent"
      extra={
        <ActionButton
          onClick={onConnect}
          disabled={disabled || query.isPending || query.isError}
          variant="outline"
        >
          {query.data && query.data.phase !== "unregistered"
            ? "重新接入 Agent"
            : "接入 Agent"}
        </ActionButton>
      }
    >
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取 Agent 状态
        </p>
      ) : query.isError ? (
        <>
          <ErrorNotice error={query.error} />
          <ActionButton onClick={() => query.refetch()} variant="outline">
            重试
          </ActionButton>
        </>
      ) : (
        query.data && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                variant={
                  query.data.phase === "online" ? "default" : "secondary"
                }
              >
                {phases[query.data.phase]}
              </Badge>
              {query.data.lastSeen && (
                <span className="text-sm text-muted-foreground">
                  上次连接 {dateLabel(query.data.lastSeen)}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              一台服务器接入一次，由 Agent 安装和管理这台服务器上的核心
            </p>
          </div>
        )
      )}
    </Section>
  );
}
interface CoreRelease {
  id: string;
  adapterId: string;
  version: string;
  platform: string;
}
export function HostCoreInstallation({ instance }: { instance: CoreInstance }) {
  const client = useQueryClient();
  const host = useHostAgentState(instance.hostId);
  const releases = useQuery({
    queryKey: ["core-releases"],
    queryFn: () => request<CoreRelease[]>("/admin/core-releases"),
  });
  const state = useQuery({
    queryKey: ["instance-state", instance.id],
    queryFn: () =>
      request<AgentState>(
        `/agent/instances/${encodeURIComponent(instance.id)}/state`,
      ),
    refetchInterval: 5000,
  });
  const release = Array.isArray(releases.data)
    ? releases.data.find(
        (r) =>
          r.adapterId === instance.adapterId && r.version === instance.version,
      )
    : undefined;
  const generation = state.data?.desired?.generation || "0";
  const mutation = useMutation({
    mutationFn: async () => {
      if (
        !release ||
        !state.isSuccess ||
        !host.isSuccess ||
        host.data.phase !== "online"
      )
        throw new Error("请先接入服务器 Agent，并刷新核心状态");
      return post(
        `/admin/hosts/${encodeURIComponent(instance.hostId)}/cores/${encodeURIComponent(instance.id)}/install`,
        { releaseId: release.id, expectedGeneration: String(generation) },
      );
    },
    retry: false,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["instance-state", instance.id] }),
  });
  const installed =
    !!release && state.data?.state?.installation?.releaseId === release.id;
  return (
    <div
      className="min-w-0 space-y-3 rounded-lg border bg-muted/30 p-3"
      aria-label="远程安装核心"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {installed ? "核心已安装" : "安装核心"}
          </p>
          <p className="text-sm text-muted-foreground">
            {release
              ? release.platform
              : "此版本不在远程安装目录中"}
          </p>
        </div>
        {!installed && (
          <ActionButton
            pending={mutation.isPending}
            onClick={() => mutation.mutate()}
            disabled={
              !release ||
              !state.isSuccess ||
              !host.isSuccess ||
              host.data.phase !== "online"
            }
            variant="outline"
          >
            通过 Agent 安装
          </ActionButton>
        )}
      </div>
      {host.isSuccess && host.data.phase !== "online" && (
        <p className="text-sm text-muted-foreground">
          先在服务器概览中接入 Agent
        </p>
      )}
      <ErrorNotice
        error={mutation.error || releases.error || state.error || host.error}
      />
      {mutation.isSuccess && !installed && !state.data?.state?.code && (
        <Notice tone="info">安装任务已下发，等待服务器返回安装结果</Notice>
      )}
    </div>
  );
}
