import type { Entitlement, Service } from "./types";
export interface UserGroup {
  id: string;
  name: string;
  serviceId: string;
  priority: number;
  memberIds: string[] | null;
}
export interface EffectivePolicy {
  userId: string;
  serviceId?: string;
  groupIds: string[];
  routeIds: string[];
  quotaBytes: number;
  onlineIpLimit: number;
  connectionLimit: number;
  entryRateBps: number;
  status: string;
  provenance: Record<string, string>;
  entitlement: Entitlement;
  service?: Service;
}
export interface PolicyChange {
  service?: Service;
  group?: UserGroup;
  entitlement?: Entitlement;
}
export interface PolicyPreview {
  revision: string;
  affected: {
    userId: string;
    before: EffectivePolicy;
    after: EffectivePolicy;
  }[];
  blockers: string[];
  guard?: "opened-record";
  resource?: ServicePolicyResource | GroupPolicyResource | EntitlementPolicyResource;
}
// Edit transport metadata is kept outside the persisted policy records.
export interface PolicyEditPrecondition {
  exists: boolean;
  revision: string;
}
export interface ServicePolicyEditContext {
  target: { kind: "service"; id: string };
  record: { service: Service } | null;
  precondition: PolicyEditPrecondition;
}
export interface ServicePolicyResource {
  target: { kind: "service"; id: string };
  before: { service: Service } | null;
  after: { service: Service };
}
// Optional read-time display metadata. Never part of a persisted group/change.
export interface GroupReferenceLabels {
  users: NamedRecord[];
  services: NamedRecord[];
}
export interface GroupPolicyEditContext {
  target: { kind: "group"; id: string };
  record: { group: UserGroup } | null;
  precondition: PolicyEditPrecondition;
  references?: GroupReferenceLabels;
}
export interface GroupPolicyResource {
  target: { kind: "group"; id: string };
  before: { group: UserGroup } | null;
  after: { group: UserGroup };
  references?: { before: GroupReferenceLabels; after: GroupReferenceLabels };
}
export interface NamedRecord {
  id: string;
  name: string;
}
export const policyStatus: Record<string, string> = {
  active: "平台授权有效",
  paused: "平台服务已暂停",
  disabled: "账号已停用",
  expired: "已到期",
  "not-started": "尚未开通",
  ambiguous: "用户组方案冲突",
  "service-missing": "服务方案已缺失",
};
export function policySource(
  source: string | undefined,
  services: NamedRecord[],
  reviewedService?: NamedRecord,
) {
  if (!source) return "未单独设置";
  const direct = source.endsWith("+direct");
  const value = direct ? source.slice(0, -7) : source;
  const serviceId = value.startsWith("service:") ? value.slice(8) : undefined;
  const serviceName = serviceId
    ? (reviewedService?.id === serviceId ? reviewedService.name : undefined) ||
      services.find((service) => service.id === serviceId)?.name ||
      serviceId
    : undefined;
  return (
    (value.startsWith("service:")
      ? `方案：${serviceName || value.slice(8)}`
      : {
          individual: "个人覆盖",
          group: "用户组继承",
          account: "账号设置",
          direct: "直接授权",
          none: "无方案",
          ambiguous: "用户组冲突",
        }[value] || value) + (direct ? " + 直接授权" : "")
  );
}

export type PolicySummaryField =
  | "status"
  | "service"
  | "quotaBytes"
  | "onlineIpLimit"
  | "connectionLimit"
  | "entryRateBps"
  | "routes"
  | "validity"
  | "cycle";
/** Compare authoritative effective-policy values and their inheritance sources. */
export function policyDifferenceFields(
  before: EffectivePolicy,
  after: EffectivePolicy,
): PolicySummaryField[] {
  const projection = (
    policy: EffectivePolicy,
  ): Record<PolicySummaryField, unknown> => ({
    status: policy.status,
    service: [
      policy.serviceId,
      policy.service?.name,
      policy.provenance.service,
    ],
    quotaBytes: [policy.quotaBytes, policy.provenance.quotaBytes],
    onlineIpLimit: [policy.onlineIpLimit, policy.provenance.onlineIpLimit],
    connectionLimit: [
      policy.connectionLimit,
      policy.provenance.connectionLimit,
    ],
    entryRateBps: [policy.entryRateBps, policy.provenance.entryRateBps],
    routes: [policy.routeIds, policy.provenance.routes],
    validity: [policy.entitlement.startsAt, policy.entitlement.expiresAt],
    cycle: policy.entitlement.cycle,
  });
  const previous = projection(before),
    next = projection(after);
  return (Object.keys(previous) as PolicySummaryField[]).filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
}

export interface EntitlementPolicyEditContext {
  target: { kind: "entitlement"; id: string };
  record: { entitlement: Entitlement } | null;
  precondition: PolicyEditPrecondition;
  effective: EffectivePolicy;
}
export interface EntitlementPolicyResource {
  target: { kind: "entitlement"; id: string };
  before: { entitlement: Entitlement } | null;
  after: { entitlement: Entitlement };
}
