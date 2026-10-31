/** Public publication receipt contract. Never serialize private deployment records. */
export const publicationStorageKey = "routeweaver.publication-request.v1";
export type PublicationRequest = {
  leaseSeconds: number;
  accessAllowed: boolean;
  quotaCertain: boolean;
  expectedFingerprint: string;
};
export type PublicationEnvelope = {
  version: 1;
  actorId: string;
  deploymentId: string;
  operationId: string;
  request: PublicationRequest;
};
export type PublicationResult =
  | {
      operationId: string;
      deploymentId: string;
      status: "publication-accepted";
      nativeChecked: false;
      instances: {
        instanceId: string;
        generation: string;
        operationId: string;
        revisionId: string;
      }[];
    }
  | {
      operationId: string;
      deploymentId: string;
      status: "definitively-rejected";
      nativeChecked: false;
      code: "SERVER_DRAFT_CHANGED" | "PUBLICATION_REJECTED";
      detail: string;
    };
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const shape = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export function validPublicationRequest(v: unknown): v is PublicationRequest {
  return (
    shape(v, [
      "leaseSeconds",
      "accessAllowed",
      "quotaCertain",
      "expectedFingerprint",
    ]) &&
    Number.isInteger(v.leaseSeconds) &&
    (v.leaseSeconds as number) >= 30 &&
    (v.leaseSeconds as number) <= 3600 &&
    typeof v.accessAllowed === "boolean" &&
    typeof v.quotaCertain === "boolean" &&
    typeof v.expectedFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(v.expectedFingerprint)
  );
}
export function parsePublicationEnvelope(
  raw: string,
): PublicationEnvelope | null {
  if (raw.length > 2048 || new TextEncoder().encode(raw).length > 2048)
    return null;
  try {
    const v: unknown = JSON.parse(raw);
    return shape(v, [
      "version",
      "actorId",
      "deploymentId",
      "operationId",
      "request",
    ]) &&
      v.version === 1 &&
      id(v.actorId) &&
      id(v.deploymentId) &&
      id(v.operationId) &&
      validPublicationRequest(v.request)
      ? (v as PublicationEnvelope)
      : null;
  } catch {
    return null;
  }
}
function generation(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[1-9][0-9]*$/.test(v) &&
    (v.length < 19 || (v.length === 19 && v <= "9223372036854775807"))
  );
}
export function validatePublicationResult(
  v: unknown,
  envelope: PublicationEnvelope,
): PublicationResult | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (
    r.operationId !== envelope.operationId ||
    r.deploymentId !== envelope.deploymentId
  )
    return null;
  if (r.status === "definitively-rejected") {
    return shape(r, [
      "operationId",
      "deploymentId",
      "status",
      "nativeChecked",
      "code",
      "detail",
    ]) &&
      r.nativeChecked === false &&
      (r.code === "SERVER_DRAFT_CHANGED" ||
        r.code === "PUBLICATION_REJECTED") &&
      typeof r.detail === "string" &&
      !!r.detail.trim()
      ? (r as PublicationResult)
      : null;
  }
  if (
    !shape(r, [
      "operationId",
      "deploymentId",
      "status",
      "nativeChecked",
      "instances",
    ]) ||
    r.status !== "publication-accepted" ||
    r.nativeChecked !== false ||
    !Array.isArray(r.instances) ||
    !r.instances.length
  )
    return null;
  const seen = new Set<string>();
  for (const instance of r.instances) {
    if (
      !shape(instance, [
        "instanceId",
        "generation",
        "operationId",
        "revisionId",
      ]) ||
      !id(instance.instanceId) ||
      !id(instance.operationId) ||
      !id(instance.revisionId) ||
      !generation(instance.generation) ||
      seen.has(instance.instanceId)
    )
      return null;
    seen.add(instance.instanceId);
  }
  return r as PublicationResult;
}
export function validatePublicationLookup(
  v: unknown,
  envelope: PublicationEnvelope,
): PublicationResult | null {
  if (!shape(v, ["request", "result"]) || !validPublicationRequest(v.request))
    return null;
  const a = v.request,
    b = envelope.request;
  if (
    a.leaseSeconds !== b.leaseSeconds ||
    a.accessAllowed !== b.accessAllowed ||
    a.quotaCertain !== b.quotaCertain ||
    a.expectedFingerprint !== b.expectedFingerprint
  )
    return null;
  return validatePublicationResult(v.result, envelope);
}

/** Only fixed public refusal categories are localized; private error text is never inferred. */
export function publicationRejectionMessage(detail: string): string {
  const messages: Record<string, string> = {
    "The saved deployment no longer exists; select a current deployment and review again.":
      "该转发路径已不存在，请选择现有转发路径并重新检查。",
    "The saved forwarding path changed; reload the path and check it again before submitting.":
      "转发路径已变化，请重新载入并检查后再提交。",
    "The instance or listener inventory changed; reload and review the current deployment.":
      "实例或监听端点已变化，请重新载入并核对当前转发路径。",
    "The deployment cannot be rendered; correct its configuration and review again.":
      "当前配置无法生成，请修正转发路径并重新检查。",
    "TLS certificate and private key PEM are required; add server TLS material and review again.":
      "缺少 TLS 证书和私钥 PEM，请补充服务端 TLS 材料并重新检查。",
    "TLS certificate and private key package is invalid; correct server TLS material and review again.":
      "TLS 证书与私钥不匹配或无效，请修正服务端 TLS 材料。",
    "TLS certificate chain is invalid; replace server TLS material and review again.":
      "TLS 证书链无效，请更换服务端 TLS 材料并重新检查。",
    "TLS certificate chain is not yet valid; correct server TLS material and review again.":
      "TLS 证书链尚未生效，请修正服务端 TLS 材料并重新检查。",
    "TLS certificate chain has expired; replace server TLS material and review again.":
      "TLS 证书链已过期，请更换服务端 TLS 材料并重新检查。",
    "TLS certificate does not cover an intended server name; correct the certificate or endpoint and review again.":
      "TLS 证书不涵盖目标服务名，请修正证书或端点并重新检查。",
    "A target enrollment is missing, revoked or expired; restore scoped enrollment and review again.":
      "目标实例的注册授权缺失、已撤销或过期，请恢复对应授权后重新检查。",
    "A target is owned by another deployment or has a conflicting operation; review target ownership before submitting.":
      "目标实例由其他转发路径占用或存在冲突任务，请先核对实例归属。",
    "The artifact package is invalid; correct the deployment and review again.":
      "生成的配置包无效，请修正转发路径并重新检查。",
    "A published route no longer matches the deployment; review the route and forwarding path.":
      "公开线路已与转发路径不一致，请核对线路和转发路径。",
    "Publication inputs or target ownership changed; reload and review before submitting again.":
      "提交内容或实例归属已变化，请重新载入并检查后再提交。",
    "A published path endpoint is absent; correct the route and review again.":
      "公开线路中的端点缺失，请修正线路并重新检查。",
    "A published principal differs from its route; correct the route and review again.":
      "用户转发策略与公开线路不一致，请修正线路并重新检查。",
    "The target is absent from the deployment; reload and review again.":
      "目标实例已不在此转发路径中，请重新载入并检查。",
  };
  return messages[detail] || "该次提交被拒绝，请重新载入并核对检查结果。";
}
