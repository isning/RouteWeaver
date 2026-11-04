import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { useEffect, useRef, useState } from "react";
import { ServerForwarding } from "./ServerForwarding";
import { APIError, list, request } from "./api";
import {
  planListenerRefresh,
  sameSnapshot,
  type ListenerRefreshPlan,
} from "./server-listener-refresh";
import type {
  CoreInstance,
  HostRecord,
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
} from "./types";
export function ListenerRefreshReview({
  draft,
  inventory,
  endpointId,
  getRevision,
  onApply,
  onClose,
}: {
  draft: ServerDeployment;
  inventory: Infrastructure;
  endpointId: string;
  getRevision: () => number;
  onApply: (next: ServerDeployment, revision: number) => boolean;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<ListenerRefreshPlan>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [changedAgain, setChangedAgain] = useState(false);
  const operation = useRef(0);
  const reviewedRevision = useRef(getRevision());
  const name =
    draft.ir.programs.find((p) => p.listener.id === endpointId)?.listener
      .name || "监听端点";
  const read = async () => {
    const [endpoint, instances, hosts, endpoints] = await Promise.all([
      request<ManagedEndpoint>(`/managed-endpoints/${endpointId}/reveal`),
      list<CoreInstance>("/core-instances"),
      list<HostRecord>("/hosts"),
      list<ManagedEndpoint>("/managed-endpoints"),
    ]);
    return planListenerRefresh(
      draft,
      { ...inventory, instances, hosts, endpoints },
      endpointId,
      endpoint,
    );
  };
  const failure = (cause: unknown) =>
    cause instanceof APIError && cause.status === 404
      ? "该监听端点已不存在。草稿中的设置已保留。"
      : cause instanceof APIError && [401, 403].includes(cause.status)
        ? "没有权限读取此监听的完整设置。草稿中的设置已保留。"
        : "未能读取当前监听设置。请重试，草稿中的设置已保留。";
  const compare = async () => {
    const token = ++operation.current;
    reviewedRevision.current = getRevision();
    setLoading(true);
    setError(undefined);
    setPlan(undefined);
    setChangedAgain(false);
    try {
      const next = await read();
      if (token === operation.current) setPlan(next);
    } catch (cause) {
      if (token === operation.current) setError(failure(cause));
    } finally {
      if (token === operation.current) setLoading(false);
    }
  };
  useEffect(() => {
    void compare();
    return () => {
      operation.current++;
    };
  }, [endpointId, draft]);
  const close = () => {
    operation.current++;
    onClose();
  };
  const confirm = async () => {
    if (loading || plan?.status !== "ready") return;
    const token = ++operation.current;
    setLoading(true);
    setError(undefined);
    try {
      const fresh = await read();
      if (token !== operation.current) return;
      if (reviewedRevision.current !== getRevision()) {
        setError("草稿已变化，请重新查看监听更新。");
        setPlan(undefined);
        return;
      }
      if (!sameSnapshot(fresh, plan)) {
        setPlan(fresh);
        setChangedAgain(true);
        return;
      }
      if (fresh.next && !onApply(fresh.next, reviewedRevision.current)) {
        setError("草稿已变化，请重新查看监听更新。");
        setPlan(undefined);
      }
    } catch (cause) {
      if (token === operation.current) setError(failure(cause));
    } finally {
      if (token === operation.current) setLoading(false);
    }
  };
  return (
    <TaskDialog
      bodyProps={{ className: "space-y-5" }}
      open
      title={`更新 ${name} 的监听设置`}
      footer={[
        <ActionButton key="keep" onClick={close} variant="outline">
          保留草稿
        </ActionButton>,
        error ? (
          <ActionButton
            key="retry"
            onClick={() => void compare()}
            pending={loading}
            variant="outline"
          >
            重新读取
          </ActionButton>
        ) : null,
        <ActionButton
          key="update"
          aria-label="更新到草稿"
          pending={loading}
          disabled={loading || plan?.status !== "ready" || !!error}
          onClick={() => void confirm()}
          variant="default"
        >
          更新到草稿
        </ActionButton>,
      ]}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="lg"
    >
      <div className="listener-refresh-review space-y-4 [&_dl]:grid [&_dl]:gap-4 [&_dt]:mb-1 [&_dt]:text-sm [&_dt]:font-medium [&_dd]:flex [&_dd]:flex-wrap [&_dd]:gap-2 [&_dd]:break-words [&_dd]:rounded-md [&_dd]:bg-muted/40 [&_dd]:p-3 [&_h4]:mb-2 [&_p]:break-words [&_section]:border-t [&_section]:pt-4">
        {loading && !plan && <p role="status">正在读取当前监听设置…</p>}
        {error && (
          <Notice tone="error" title="尚未更新草稿">
            {error}
          </Notice>
        )}
        {changedAgain && (
          <Notice tone="warning" title="监听设置又有变化，请重新确认。" />
        )}
        {plan?.status === "unchanged" && <p>当前监听设置与草稿一致。</p>}
        {plan?.status === "blocked" && (
          <Notice tone="warning" title="无法仅更新此监听">
            {plan.reason}
          </Notice>
        )}
        {plan?.status === "ready" && (
          <>
            <dl>
              {plan.changes.map((change) => (
                <div key={change.label}>
                  <dt>{change.label}</dt>
                  {change.before !== undefined && (
                    <dd>
                      <span>{change.before}</span>
                      <span aria-label="变更为">→</span>
                      <strong>{change.after}</strong>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
            {plan.incoming && (
              <section>
                <h4 className="text-sm font-medium">
                  同时更新 {plan.incoming.name} 到此监听的连接
                </h4>
                <p>
                  {plan.incoming.before} → {plan.incoming.after}
                </p>
              </section>
            )}
            {plan.independent && (
              <section>
                <h4 className="text-sm font-medium">保留转发去向</h4>
                <ServerForwarding
                  programs={draft.ir.programs}
                  inventory={inventory}
                  compact
                />
              </section>
            )}
            <p className="muted text-sm text-muted-foreground">
              本次更新草稿中的监听设置，之后需保存、检查并单独应用到服务器。
            </p>
          </>
        )}
      </div>
    </TaskDialog>
  );
}
