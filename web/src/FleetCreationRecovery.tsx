import type { Ref } from "react";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { fleetActionLabel, fleetStatus } from "./fleet-model";
import type { Infrastructure } from "./types";
import type { useFleetCreation } from "./useFleetCreation";

/** Creation acknowledgement only. Runtime progress belongs to the separate batch view. */
export function FleetCreationRecovery({
  creation, inventory, contextualDeploymentId, actionRef, beforeOperation, onContinue, onAbandon,
}: {
  creation: ReturnType<typeof useFleetCreation>;
  inventory: Infrastructure;
  contextualDeploymentId: string;
  actionRef: Ref<HTMLButtonElement>;
  beforeOperation: (mode: "create" | "lookup") => void;
  onContinue: () => void;
  onAbandon: () => void;
}) {
  const envelope = creation.envelope;
  if (!envelope) return null;
  const input = envelope.request;
  const path = inventory.deployments.find((item) => item.id === input.deploymentId);
  const sameContext = !contextualDeploymentId || contextualDeploymentId === input.deploymentId;
  return (
    <section aria-label="批次创建结果" className="space-y-4">
      <Notice tone={creation.result ? "info" : "warning"}
        title={creation.result ? "批次已创建" : "创建结果尚未确认"}>
        {creation.result
          ? `当前记录：${fleetStatus(creation.result.status)}。查看进度不会开始执行。`
          : creation.error || "批次可能已创建。请先查询该次结果，勿重新计划另一批次。"}
      </Notice>
      {creation.result && creation.error && <Notice tone="warning" title={creation.error} />}
      <div className="space-y-2 rounded-lg border p-4">
        <p className="font-medium">{path?.name || input.deploymentId}</p>
        <p>{fleetActionLabel[input.action]}</p>
        <p className="text-sm text-muted-foreground">
          {input.targetIds.length} 个实例，{input.stages.length} 个阶段
        </p>
        <details className="text-sm [&_summary]:cursor-pointer [&_summary]:font-medium">
          <summary>查看本次创建身份与执行范围</summary>
          <div className="mt-3 space-y-3 break-all">
            <p>批次：{envelope.batchId}</p>
            <p>转发路径：{input.deploymentId}</p>
            <p>计划执行策略有效秒数：{input.leaseSeconds}</p>
            <p>{input.continuousService ? "计划执行时授予持续运行权限" : "计划不授予持续运行权限"}</p>
            {input.sourceBatchId && <p>回退来源批次：{input.sourceBatchId}</p>}
            {input.targetReleaseId && <p>目标核心版本：{input.targetReleaseId}</p>}
            {input.stages.map((targets, index) => (
              <div key={index}>
                <p className="font-medium">第 {index + 1} 阶段</p>
                <ul className="mt-1 space-y-1">
                  {targets.map((id) => <li key={id}>
                    {inventory.instances.find((instance) => instance.id === id)?.name || id}
                    <span className="block text-muted-foreground">{id}</span>
                  </li>)}
                </ul>
              </div>
            ))}
          </div>
        </details>
      </div>
      {!creation.result ? (
        <div className="flex flex-wrap gap-2">
          <ActionButton ref={actionRef} variant="default" disabled={creation.busy || !creation.available}
            onClick={() => { beforeOperation("lookup"); void creation.lookup(); }}>
            查询该次结果
          </ActionButton>
          <ActionButton variant="outline" disabled={creation.busy || !creation.available}
            onClick={() => { beforeOperation("create"); void creation.retry(); }}>
            用同一计划重试创建
          </ActionButton>
        </div>
      ) : sameContext ? (
        <ActionButton ref={actionRef} variant="default" disabled={!creation.available} onClick={onContinue}>
          查看批次进度
        </ActionButton>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">这是另一条转发路径的批次。请在执行任务中查看。</p>
          <ActionButton ref={actionRef} variant="default" asChild><a href="#fleet">前往执行任务</a></ActionButton>
        </div>
      )}
      <div className="space-y-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          关闭此面板后，当前标签页仍保留恢复记录。再次打开计划变更可继续核对，不会删除服务器上的批次。
        </p>
        {!creation.result && <ActionButton variant="outline" disabled={creation.busy || !creation.available} onClick={onAbandon}>
          放弃本页恢复记录
        </ActionButton>}
      </div>
    </section>
  );
}
