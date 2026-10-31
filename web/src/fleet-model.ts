export type FleetAction =
  "configure" | "start" | "stop" | "rollback" | "install" | "upgrade";
export interface FleetInput {
  action: FleetAction;
  deploymentId: string;
  targetIds: string[];
  stages: string[][];
  sourceBatchId?: string;
  targetReleaseId?: string;
}
export interface FleetTarget {
  instanceId: string;
  nodeId: string;
  name: string;
  adapterId: string;
  coreVersion: string;
  currentVersion?: string;
  configDiff?: { path: string; before: string; after: string }[];
  stage: number;
  affectedRouteIds: string[];
  affectedUsers: number;
  changes: string[];
  supported: boolean;
  diagnostics: string[];
  status: string;
  attempts: {
    number: number;
    requestId: string;
    status: string;
    code?: string;
    detail?: string;
    queuedAt: string;
    observedAt?: string;
    leaseExpiresAt: string;
  }[];
}
export interface FleetPlan extends FleetInput {
  fingerprint: string;
  targets: FleetTarget[];
  affectedUsers: number;
  supported: boolean;
  diagnostics: string[];
  disruption: string;
}
export interface FleetBatch extends FleetPlan {
  id: string;
  createdAt: string;
  leaseSeconds: number;
  status: string;
}
export const fleetActionLabel: Record<FleetAction, string> = {
  install: "准备核心版本",
  upgrade: "升级核心版本",
  configure: "应用配置",
  start: "启动核心",
  stop: "停止核心",
  rollback: "回退配置",
};
export const fleetStatus = (status: string) =>
  ({
    planned: "尚未执行",
    queued: "已提交，等待节点",
    pending: "等待节点确认",
    succeeded: "已确认完成",
    failed: "失败",
    partial_failure: "部分失败",
    awaiting_stage: "等待下一阶段",
    unknown: "结果未确认",
    unsupported: "不支持此操作",
    superseded: "已被后续变更替代",
  })[status] || status;
export function stagesFor(
  ids: string[],
  assignments: Record<string, number>,
): string[][] {
  if (!ids.length) throw new Error("请明确选择至少一个实例。");
  const lastStage = Math.max(...ids.map((id) => assignments[id] || 1));
  if (lastStage > 20)
    throw new Error("最多支持 20 个执行阶段，请减少实例或使用自定义分组。");
  const stages = Array.from({ length: lastStage }, () => [] as string[]);
  ids.forEach((id) => stages[(assignments[id] || 1) - 1].push(id));
  if (stages.some((stage) => !stage.length))
    throw new Error("阶段不能留空，请使用从 1 开始的连续阶段。");
  return stages;
}

export interface CoreRelease {
  id: string;
  adapterId: string;
  version: string;
  platform: string;
  url: string;
  archiveSHA256: string;
  executableSHA256: string;
  upstreamChecksumVerified: boolean;
}

export type FleetStrategy = "together" | "sequential" | "canary" | "custom";
/** Preserve explicit selection order, including which instance is the canary. */
export function strategyAssignments(
  ids: string[],
  strategy: Exclude<FleetStrategy, "custom">,
): Record<string, number> {
  return Object.fromEntries(
    ids.map((id, index) => [
      id,
      strategy === "sequential"
        ? index + 1
        : strategy === "canary" && index > 0
          ? 2
          : 1,
    ]),
  );
}

export function fleetStrategyIssue(
  strategy: FleetStrategy,
  targetCount: number,
): string | undefined {
  if (strategy === "sequential" && targetCount > 20)
    return "逐个执行最多支持 20 个实例（20 个阶段）。请将选择减少至 20 个以内，或改用自定义分组、先试一个。";
  return undefined;
}
