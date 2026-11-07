import type { FleetBatch, FleetInput } from "./fleet-model";

export type FleetCreationRequest = FleetInput & {
  expectedFingerprint: string;
  leaseSeconds: number;
};
export type FleetCreationEnvelope = {
  version: 1;
  actorId: string;
  batchId: string;
  request: FleetCreationRequest;
};
export const fleetCreationStorageKey = (actorId: string) =>
  `routeweaver.fleet-creation.v1:${actorId}`;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const optional = (value: Record<string, unknown>, key: string, valid: (item: unknown) => boolean) =>
  !Object.hasOwn(value, key) || valid(value[key]);
function validAttempt(value: unknown): boolean {
  return record(value) && count(value.number) && value.number > 0 && id(value.requestId) &&
    nonempty(value.status) && date(value.queuedAt) && date(value.leaseExpiresAt) &&
    optional(value, "code", text) && optional(value, "detail", text) && optional(value, "observedAt", date);
}
function validTarget(value: unknown): boolean {
  return record(value) && id(value.instanceId) && id(value.nodeId) && text(value.name) &&
    nonempty(value.adapterId) && nonempty(value.coreVersion) && optional(value, "currentVersion", text) &&
    count(value.stage) && value.stage < 20 && texts(value.affectedRouteIds) && count(value.affectedUsers) &&
    texts(value.changes) && typeof value.supported === "boolean" && texts(value.diagnostics) &&
    nonempty(value.status) && Array.isArray(value.attempts) && value.attempts.every(validAttempt) &&
    optional(value, "configDiff", (diff) => Array.isArray(diff) && diff.every((item) =>
      record(item) && text(item.path) && text(item.before) && text(item.after)));
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function validRequest(value: unknown): value is FleetCreationRequest {
  if (!record(value) || !keys(value,
    ["action", "deploymentId", "targetIds", "stages", "expectedFingerprint", "leaseSeconds"],
    ["continuousService", "sourceBatchId", "targetReleaseId"])) return false;
  if (!id(value.deploymentId) || typeof value.action !== "string" ||
    !["configure", "start", "stop", "rollback", "install", "upgrade"].includes(String(value.action)) ||
    typeof value.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedFingerprint) ||
    !Number.isInteger(value.leaseSeconds) || (value.leaseSeconds as number) < 30 || (value.leaseSeconds as number) > 3600 ||
    !Array.isArray(value.targetIds) || value.targetIds.length < 1 || value.targetIds.length > 100 ||
    !value.targetIds.every(id) || new Set(value.targetIds).size !== value.targetIds.length ||
    !Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > 20 ||
    !value.stages.every((stage) => Array.isArray(stage) && stage.length > 0 && stage.every(id))) return false;
  const staged = value.stages.flat();
  if (staged.length !== value.targetIds.length || new Set(staged).size !== staged.length ||
    staged.some((target) => !(value.targetIds as string[]).includes(target))) return false;
  if (Object.hasOwn(value, "continuousService") && typeof value.continuousService !== "boolean") return false;
  if (value.continuousService === true && value.action !== "configure" && value.action !== "start") return false;
  if (value.action === "rollback" ? !id(value.sourceBatchId) : Object.hasOwn(value, "sourceBatchId")) return false;
  if (["install", "upgrade"].includes(String(value.action)) ? !id(value.targetReleaseId) : Object.hasOwn(value, "targetReleaseId")) return false;
  return true;
}

/** Only bounded, nonsecret reviewed creation intent may survive a remount. */
export function parseFleetCreation(raw: string): FleetCreationEnvelope | null {
  if (raw.length > 32768 || new TextEncoder().encode(raw).length > 32768) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !keys(value, ["version", "actorId", "batchId", "request"]) ||
      value.version !== 1 || !id(value.actorId) || !id(value.batchId) || !validRequest(value.request)) return null;
    const envelope = value as FleetCreationEnvelope;
    envelope.request.stages.forEach(Object.freeze);
    Object.freeze(envelope.request.stages);
    Object.freeze(envelope.request.targetIds);
    Object.freeze(envelope.request);
    return Object.freeze(envelope);
  } catch {
    return null;
  }
}

/** Match immutable creation identity. Progress may legitimately change after creation. */
export function matchFleetCreation(value: unknown, envelope: FleetCreationEnvelope): FleetBatch | null {
  if (!record(value)) return null;
  const input = envelope.request;
  if (value.id !== envelope.batchId || value.actorId !== envelope.actorId ||
    value.action !== input.action || value.deploymentId !== input.deploymentId ||
    value.fingerprint !== input.expectedFingerprint || value.leaseSeconds !== input.leaseSeconds ||
    !optional(value, "continuousService", (item) => typeof item === "boolean") ||
    !optional(value, "sourceBatchId", text) || !optional(value, "targetReleaseId", text) ||
    (value.continuousService === undefined ? false : value.continuousService) !== (input.continuousService ?? false) ||
    (value.sourceBatchId === undefined ? "" : value.sourceBatchId) !== (input.sourceBatchId ?? "") ||
    (value.targetReleaseId === undefined ? "" : value.targetReleaseId) !== (input.targetReleaseId ?? "") ||
    JSON.stringify(value.targetIds) !== JSON.stringify(input.targetIds) ||
    JSON.stringify(value.stages) !== JSON.stringify(input.stages) ||
    !date(value.createdAt) || !nonempty(value.status) || !count(value.affectedUsers) ||
    typeof value.supported !== "boolean" || !texts(value.diagnostics) || !text(value.disruption) ||
    !Array.isArray(value.targets) || value.targets.length !== input.targetIds.length ||
    !value.targets.every((target, index) => validTarget(target) &&
      target.instanceId === input.targetIds[index] &&
      target.stage === input.stages.findIndex((stage) => stage.includes(input.targetIds[index])))) return null;
  return value as unknown as FleetBatch;
}
