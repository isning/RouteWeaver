export type DiagnosticKind = "connectivity" | "download" | "upload";
export interface DiagnosticTarget {
  id: string;
  name: string;
  nodeId: string;
  url: string;
  methods: DiagnosticKind[];
}
export interface ManagedDiagnosticPath {
  routeId: string;
  deploymentId: string;
  fingerprint: string;
  entryEndpointId: string;
  exitEndpointId: string;
  connectorId: string;
  hops: {
    endpointId: string;
    identity: {
      nodeId: string;
      instanceId: string;
      enrollmentEpoch: string;
      adapterId: string;
      coreVersion: string;
      generation: string;
      revisionId: string;
      operationId: string;
      digest: string;
    };
  }[];
}
export interface AvailableDiagnosticPath {
  publishedRouteId: string;
  name: string;
  instanceId: string;
  nodeId: string;
  managedPath: ManagedDiagnosticPath;
}
export interface DiagnosticJob {
  pathMode?: "node_direct" | "managed_route";
  publishedRouteId?: string;
  managedPath?: ManagedDiagnosticPath;
  id: string;
  targetId: string;
  instanceId: string;
  kind: DiagnosticKind;
  maxBytes: number;
  timeoutSeconds: number;
  scope: { nodeId: string; instanceId: string; enrollmentEpoch?: string };
  target: DiagnosticTarget;
  requestedAt: string;
  expiresAt: string;
  direction: string;
  estimatedMaxBytes: number;
  costBasis: string;
  status: string;
  result?: {
    status: string;
    phase: string;
    code: string;
    action: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    bytesSent: number;
    bytesReceived: number;
    costKnown: boolean;
    bytesPerSecond?: number;
    httpStatus?: number;
  };
}
export const diagnosticKindLabel: Record<DiagnosticKind, string> = {
  connectivity: "连通性",
  download: "下载测试",
  upload: "上传测试",
};
export const diagnosticStatus = (status: string) =>
  ({
    queued: "等待节点执行",
    running: "正在测试",
    cancel_requested: "已请求取消",
    succeeded: "测试完成",
    failed: "测试失败",
    not_run: "未执行",
    cancelled: "已取消",
    unknown: "结果未确认",
  })[status] || status;
export const diagnosticActive = (status: string) =>
  ["queued", "running", "cancel_requested"].includes(status);
