import { APIError, post, request } from "./api";
import type { Service, Entitlement } from "./types";
import type { PolicyChange, PolicyEditPrecondition, PolicyPreview, ServicePolicyEditContext, GroupPolicyEditContext, EntitlementPolicyEditContext, UserGroup } from "./access-policy-model";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalInteger = (value: unknown) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
function serviceRecord(value: unknown, id: string, complete = true): value is { service: Service } {
  if (!object(value) || !onlyKeys(value, ["service"]) || !object(value.service)) return false;
  const plan = value.service;
  const keys = ["id", "name", "quotaBytes", "routeIds", "cycle", "onlineIpLimit", "connectionLimit", "entryRateBps"];
  if (!onlyKeys(plan, keys) || (complete && !keys.every((key) => Object.hasOwn(plan, key))) ||
      plan.id !== id || typeof plan.name !== "string" || !Number.isSafeInteger(plan.quotaBytes) || (plan.quotaBytes as number) < 0 ||
      !(plan.routeIds === null || (Array.isArray(plan.routeIds) && plan.routeIds.every((route) => typeof route === "string"))) ||
      ![plan.onlineIpLimit, plan.connectionLimit, plan.entryRateBps].every(optionalInteger) || !object(plan.cycle)) return false;
  const cycle = plan.cycle;
  return onlyKeys(cycle, ["mode", "day", "days", "anchor", "timezone"]) &&
    (!complete || (Object.hasOwn(cycle, "anchor") && Object.hasOwn(cycle, "timezone"))) && typeof cycle.mode === "string" &&
    optionalInteger(cycle.day) && optionalInteger(cycle.days) &&
    (cycle.anchor === undefined || typeof cycle.anchor === "string") &&
    (cycle.timezone === undefined || typeof cycle.timezone === "string");
}
function groupRecord(value: unknown, id: string): value is { group: UserGroup } {
  if (!object(value) || !onlyKeys(value, ["group"]) || !object(value.group)) return false;
  const group = value.group, keys = ["id", "name", "serviceId", "priority", "memberIds"];
  return onlyKeys(group, keys) && keys.every((key) => Object.hasOwn(group, key)) && group.id === id &&
    typeof group.name === "string" && typeof group.serviceId === "string" && Number.isSafeInteger(group.priority) &&
    (group.memberIds === null || (Array.isArray(group.memberIds) && group.memberIds.every((member) => typeof member === "string")));
}
function entitlementRecord(value: unknown, id: string, complete = true): value is { entitlement: Entitlement } {
  if (!object(value) || !onlyKeys(value, ["entitlement"]) || !object(value.entitlement)) return false;
  const ent = value.entitlement;
  if (!onlyKeys(ent, ["userId", "serviceId", "startsAt", "expiresAt", "cycle", "quotaOverride", "paused", "routeIdsOverride", "onlineIpLimitOverride", "connectionLimitOverride", "entryRateBpsOverride"]) ||
      ent.userId !== id || typeof ent.startsAt !== "string" || !object(ent.cycle) ||
      (complete ? typeof ent.paused !== "boolean" : ent.paused !== undefined && typeof ent.paused !== "boolean") ||
      (ent.serviceId !== undefined && typeof ent.serviceId !== "string") ||
      (ent.expiresAt != null && typeof ent.expiresAt !== "string") ||
      ![ent.quotaOverride, ent.onlineIpLimitOverride, ent.connectionLimitOverride, ent.entryRateBpsOverride].every((v) => v === null || optionalInteger(v)) ||
      !(ent.routeIdsOverride == null || (Array.isArray(ent.routeIdsOverride) && ent.routeIdsOverride.every((v) => typeof v === "string")))) return false;
  const cycle = ent.cycle;
  return onlyKeys(cycle, ["mode", "day", "days", "anchor", "timezone"]) && typeof cycle.mode === "string" &&
    optionalInteger(cycle.day) && optionalInteger(cycle.days) &&
    (complete ? typeof cycle.anchor === "string" && typeof cycle.timezone === "string" :
      (cycle.anchor === undefined || typeof cycle.anchor === "string") && (cycle.timezone === undefined || typeof cycle.timezone === "string"));
}
// Optional labels are sparse per-side metadata. A present malformed collection
// is not an ID fallback: reject it through the existing retained-draft error path.
function groupReferences(value: unknown, group: UserGroup | null): boolean {
  if (!object(value) || !onlyKeys(value, ["users", "services"])) return false;
  const valid = (entries: unknown, allowed: Set<string>) => {
    if (!Array.isArray(entries)) return false;
    const seen = new Set<string>();
    return entries.every((entry) => {
      if (!object(entry) || !onlyKeys(entry, ["id", "name"]) || typeof entry.id !== "string" || typeof entry.name !== "string" ||
          !allowed.has(entry.id) || seen.has(entry.id)) return false;
      seen.add(entry.id); return true;
    });
  };
  return valid(value.users, new Set(group?.memberIds ?? [])) && valid(value.services, new Set(group ? [group.serviceId] : []));
}
function contextGroupReferences(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, "references")) return true;
  const record = value.record as { group: UserGroup } | null;
  return groupReferences(value.references, record?.group ?? null);
}
function resourceGroupReferences(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, "references")) return true;
  if (!object(value.references) || !onlyKeys(value.references, ["before", "after"])) return false;
  const before = value.before as { group: UserGroup } | null, after = value.after as { group: UserGroup };
  return groupReferences(value.references.before, before?.group ?? null) && groupReferences(value.references.after, after.group);
}
type GuardedKind = "service" | "group" | "entitlement";
type EditContext = ServicePolicyEditContext | GroupPolicyEditContext | EntitlementPolicyEditContext;
const recordMatches = (kind: GuardedKind, value: unknown, id: string, complete = true): value is PolicyChange =>
  kind === "service" ? serviceRecord(value, id, complete) : kind === "group" ? groupRecord(value, id) : entitlementRecord(value, id, complete);
const label = (kind: GuardedKind) => kind === "service" ? "方案" : kind === "group" ? "用户组" : "个人授权";
function validPrecondition(value: unknown): value is PolicyEditPrecondition {
  return object(value) && typeof value.exists === "boolean" && typeof value.revision === "string" && value.revision.length > 0;
}
function effectivePolicy(value: unknown) {
  if (!object(value) || typeof value.userId !== "string" || typeof value.status !== "string" ||
      ![value.quotaBytes, value.onlineIpLimit, value.connectionLimit, value.entryRateBps].every((field) => typeof field === "number" && Number.isSafeInteger(field)) ||
      ![value.groupIds, value.routeIds].every((field) => Array.isArray(field) && field.every((id) => typeof id === "string")) ||
      !object(value.provenance) || !Object.values(value.provenance).every((source) => typeof source === "string") ||
      !object(value.entitlement) || !object(value.entitlement.cycle) ||
      typeof value.entitlement.startsAt !== "string" || typeof value.entitlement.cycle.mode !== "string") return false;
  return value.service === undefined || serviceRecord({ service: value.service }, String(value.serviceId));
}
// Compare the server's documented Plan normalization, never rounded display
// values. Preserve sub-millisecond precision when timestamp offsets differ.
function timestamp(value: string | undefined) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value ?? "0001-01-01T00:00:00Z");
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match[1].split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`) / 1000;
  return Number.isFinite(seconds) ? [seconds, (match[2] || "").padEnd(9, "0")] : null;
}
function normalizedPlan(plan: Service) {
  const cycle = plan.cycle, mode = cycle.mode || "none", anchor = timestamp(cycle.anchor);
  if (!anchor || !["none", "monthly", "anniversary", "fixed-days"].includes(mode) ||
      !["", "UTC+8", "Asia/Shanghai"].includes(cycle.timezone || "")) return null;
  return JSON.stringify({ id: plan.id, name: plan.name, quotaBytes: plan.quotaBytes, routeIds: plan.routeIds ?? null,
    onlineIpLimit: plan.onlineIpLimit ?? 0, connectionLimit: plan.connectionLimit ?? 0, entryRateBps: plan.entryRateBps ?? 0,
    cycle: { mode, day: cycle.day ?? 0, days: cycle.days ?? 0, anchor, timezone: cycle.timezone ?? "" } });
}
// Group sorting/deduplication is the existing server normalization. It does not
// redefine the opening token's raw-content comparison or fabricate reference names.
function normalizedRecord(kind: GuardedKind, change: PolicyChange): string | null {
  if (kind === "service") return change.service ? normalizedPlan(change.service) : null;
  if (kind === "entitlement") {
    const ent = change.entitlement;
    if (!ent) return null;
    const startsAt = timestamp(ent.startsAt), expiresAt = ent.expiresAt == null ? null : timestamp(ent.expiresAt), anchor = timestamp(ent.cycle.anchor);
    if (!startsAt || !anchor || (ent.expiresAt != null && !expiresAt)) return null;
    return JSON.stringify({ userId: ent.userId, serviceId: ent.serviceId ?? "", startsAt, expiresAt,
      cycle: { mode: ent.cycle.mode, day: ent.cycle.day ?? 0, days: ent.cycle.days ?? 0, anchor, timezone: ent.cycle.timezone ?? "" },
      paused: ent.paused ?? false, routeIdsOverride: ent.routeIdsOverride ?? null,
      quotaOverride: ent.quotaOverride ?? null, onlineIpLimitOverride: ent.onlineIpLimitOverride ?? null,
      connectionLimitOverride: ent.connectionLimitOverride ?? null, entryRateBpsOverride: ent.entryRateBpsOverride ?? null });
  }
  const group = change.group;
  return group ? JSON.stringify({ id: group.id, name: group.name, serviceId: group.serviceId, priority: group.priority,
    memberIds: [...new Set(group.memberIds ?? [])].sort() }) : null;
}
async function loadPolicyEditContext(kind: GuardedKind, id: string, signal?: AbortSignal): Promise<EditContext> {
  const value = await request<unknown>(`/access-policy/edit-context/${kind}/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
  if (!object(value) || !object(value.target) || value.target.kind !== kind || value.target.id !== id ||
      !validPrecondition(value.precondition) ||
      (value.precondition.exists ? !recordMatches(kind, value.record, id) : value.record !== null) ||
      (kind === "group" && !contextGroupReferences(value)) ||
      (kind === "entitlement" && (!effectivePolicy(value.effective) || (value.effective as {userId: string}).userId !== id ||
        !entitlementRecord({ entitlement: (value.effective as {entitlement: unknown}).entitlement }, id))))
    throw new APIError(`服务未返回完整的${label(kind)}编辑数据。请重试；尚未打开可编辑草稿。`, 502);
  return structuredClone(value) as unknown as EditContext;
}
async function previewPolicyEdit(kind: GuardedKind, change: PolicyChange, precondition: PolicyEditPrecondition | undefined): Promise<PolicyPreview> {
  const record = change[kind];
  if (!record || Object.values(change).filter((entry) => entry != null).length !== 1 || !validPrecondition(precondition))
    throw new APIError(`缺少${label(kind)}的打开版本。请重新打开${label(kind)}后编辑，当前草稿尚未保存。`, 428);
  const submittedRecord = { [kind]: record };
  const id = kind === "entitlement" ? change.entitlement!.userId : (record as Service | UserGroup).id;
  if (!recordMatches(kind, submittedRecord, id, false))
    throw new APIError(`当前版本无法完整保存此${label(kind)}草稿。草稿已保留，请勿直接覆盖保存。`, 422);
  const value = await post<unknown>("/access-policy/preview", { change, precondition });
  if (!object(value) || value.guard !== "opened-record" || typeof value.revision !== "string" || !value.revision ||
      !Array.isArray(value.affected) || !value.affected.every((effect) => object(effect) && typeof effect.userId === "string" && effectivePolicy(effect.before) && effectivePolicy(effect.after)) ||
      !Array.isArray(value.blockers) || !value.blockers.every((item) => typeof item === "string") ||
      !object(value.resource) || !object(value.resource.target) || value.resource.target.kind !== kind || value.resource.target.id !== id ||
      !recordMatches(kind, value.resource.after, id) || !normalizedRecord(kind, change) ||
      normalizedRecord(kind, value.resource.after) !== normalizedRecord(kind, change) ||
      (precondition.exists ? !recordMatches(kind, value.resource.before, id) : value.resource.before !== null) ||
      (kind === "group" && !resourceGroupReferences(value.resource)))
    throw new APIError(`服务未返回完整的${label(kind)}变更核对结果。当前草稿已保留，请重试。`, 502);
  return structuredClone(value) as unknown as PolicyPreview;
}
export const loadServicePolicyEditContext = (id: string, signal?: AbortSignal) =>
  loadPolicyEditContext("service", id, signal) as Promise<ServicePolicyEditContext>;
export const loadGroupPolicyEditContext = (id: string, signal?: AbortSignal) =>
  loadPolicyEditContext("group", id, signal) as Promise<GroupPolicyEditContext>;
export const previewServicePolicyEdit = (change: PolicyChange, precondition: PolicyEditPrecondition | undefined) =>
  previewPolicyEdit("service", change, precondition);
export const previewGroupPolicyEdit = (change: PolicyChange, precondition: PolicyEditPrecondition | undefined) =>
  previewPolicyEdit("group", change, precondition);

export const loadEntitlementPolicyEditContext = (id: string, signal?: AbortSignal) =>
  loadPolicyEditContext("entitlement", id, signal) as Promise<EntitlementPolicyEditContext>;
export const previewEntitlementPolicyEdit = (change: PolicyChange, precondition: PolicyEditPrecondition | undefined) =>
  previewPolicyEdit("entitlement", change, precondition);
