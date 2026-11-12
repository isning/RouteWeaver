import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActionButton } from "@/ui-patterns/actions";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { Notice } from "@/ui-patterns/notice";
import { request } from "./api";
import { UserEntries } from "./UserEntries";
import type { PlatformEntry, ServerProgram, State } from "./types";

type PrincipalIdentity = Pick<NonNullable<ServerProgram["principals"]>[number],
  "accountId" | "subjectId" | "routeId" | "credentialVersion">;
interface SourceEntry extends PlatformEntry {
  userId?: string;
  subjectId?: string;
  deploymentId?: string;
  publishedRouteId?: string;
  revoked?: boolean;
}

export interface PolicyUserEntryTaskProps {
  deploymentId: string;
  listenerId: string;
  principal: PrincipalIdentity;
  onClose: () => void;
  /** Before returning true, the parent must fence saves/checks of the captured
   * deployment revision. Source management can rotate credentials or change
   * accounting without changing this draft. Keep the draft, but require explicit
   * conflict recovery before any later write; invalidating preview alone is not
   * sufficient. Return false while pending or if the fence cannot be installed. */
  onBeforeManage: () => boolean;
}

/** Resolves provenance before offering the existing, authorized source task.
 * No credentials, IR mutation, automatic reveal, or guessed source navigation. */
export function PolicyUserEntryTask(props: PolicyUserEntryTaskProps) {
  const { deploymentId, listenerId, principal } = props;
  const identity = JSON.stringify([deploymentId, listenerId, principal.accountId,
    principal.subjectId, principal.routeId, principal.credentialVersion]);
  // Remount the source task on any identity change, including credential version.
  return <SourceTask key={identity} {...props} />;
}

function SourceTask({ deploymentId, listenerId, principal, onClose, onBeforeManage }: PolicyUserEntryTaskProps) {
  const [managing, setManaging] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const source = useQuery({
    queryKey: ["policy-entry-source", deploymentId, listenerId, principal.accountId,
      principal.subjectId, principal.routeId, principal.credentialVersion],
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const state = await request<State>("/state", { signal });
      const user = state.users?.find(item => item.id === principal.accountId);
      if (!user) throw new Error("找不到此入口对应的账号。请重新读取路径后核对。");
      const entries = await request<SourceEntry[]>(
        `/users/${encodeURIComponent(user.id)}/entries`, { signal });
      const matches = entries.filter(entry =>
        // entrySummary omits userId; ownership is the authorized per-user
        // collection scope. If a future DTO supplies an owner, reject mismatch.
        (entry.userId === undefined || entry.userId === user.id) && entry.subjectId === principal.subjectId &&
        entry.routeId === principal.routeId && entry.publishedRouteId === principal.routeId &&
        entry.deploymentId === deploymentId &&
        entry.credentialVersion === principal.credentialVersion && !entry.revoked);
      if (matches.length !== 1)
        throw new Error("此草稿未匹配到唯一的公开线路用户入口。请重新读取路径后核对；原配置仍保留。");
      // /state contains legacy routes only. Resolve the published route itself;
      // never infer its existence or ownership from an optional UI-enriched field.
      const route = await request<{ id: string; name: string; deploymentId: string; path?: { entry: string } }>(
        `/published-routes/${encodeURIComponent(principal.routeId)}/resolve`, { signal });
      if (route.id !== principal.routeId || route.deploymentId !== deploymentId || route.path?.entry !== listenerId)
        throw new Error("此用户入口不属于当前监听。请重新读取路径后核对；原配置仍保留。");
      return { state, user, entry: matches[0], route };
    },
    enabled: !managing,
  });
  // Keep the verified source snapshot while its own management UI performs
  // updates. Rotation must not make this task disappear mid-confirmation.
  const [verified, setVerified] = useState<typeof source.data>();
  if (managing && verified) return <UserEntries
    user={verified.user}
    services={verified.state.services || []}
    routes={verified.state.routes || []}
    publishedRoutes={[verified.route]}
    allocationHref={`#published-routes?line=${encodeURIComponent(principal.routeId)}&user=${encodeURIComponent(principal.accountId)}`}
    onClose={onClose}
  />;
  return <TaskSheet title="核对用户入口" open onOpenChange={open => { if (!open) onClose(); }}
    footer={source.data && !source.isError ? <div className="w-full space-y-3">
      <p className="text-sm text-muted-foreground">当前路径草稿会保留；返回后需重新核对路径版本才能保存。</p>
      <div className="flex justify-end"><ActionButton className="w-full sm:w-auto" disabled={source.isFetching || source.isPaused} onClick={() => {
        if (managing || source.isFetching || source.isPaused || source.isError || !source.data) return;
        if (!onBeforeManage()) { setBlocked(true); return; }
        setVerified(source.data);
        setManaging(true);
      }}>管理此账号的入口</ActionButton></div>
    </div> : undefined}>
    <div className="space-y-4">
      <dl className="divide-y text-sm [overflow-wrap:anywhere] [&>div]:grid [&>div]:gap-1 [&>div]:py-3 [&>div:first-child]:pt-0 [&_dt]:text-muted-foreground [&_dd]:font-medium">
        <div><dt>账号</dt><dd>{source.data?.user.name || principal.accountId}</dd></div>
        <div><dt>线路</dt><dd>{source.data?.route.name || principal.routeId}</dd></div>
        {source.data && !source.isError && <div><dt>用户入口</dt><dd>{source.data.entry.name || source.data.entry.id}</dd></div>}
      </dl>
      {source.isFetching && <p role="status">正在核对入口来源…</p>}
      {source.isPaused && <Notice tone="warning" title="入口来源读取已暂停">恢复连接后重试。<ActionButton variant="outline" onClick={() => void source.refetch()}>重新核对</ActionButton></Notice>}
      {source.isError && <Notice tone="error" title="无法确认入口来源">
        <p>{source.error.message}</p>
        <ActionButton variant="outline" onClick={() => void source.refetch()}>重新核对</ActionButton>
      </Notice>}
      {blocked && <Notice tone="warning" title="请先完成当前路径操作">当前入口来源仍保留，请稍后重试。</Notice>}
    </div>
  </TaskSheet>;
}

