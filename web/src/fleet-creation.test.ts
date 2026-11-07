import { expect, it } from "vitest";
import { matchFleetCreation, parseFleetCreation, type FleetCreationEnvelope } from "./fleet-creation";

const envelope: FleetCreationEnvelope = {
  version: 1, actorId: "admin-a", batchId: "batch_a",
  request: { action: "configure", deploymentId: "path", targetIds: ["core-a", "core-b"],
    stages: [["core-b"], ["core-a"]], continuousService: true,
    expectedFingerprint: "a".repeat(64), leaseSeconds: 300 },
};
const batch = () => ({
  ...envelope.request, id: "batch_a", actorId: "admin-a",
  fingerprint: "a".repeat(64), createdAt: "2026-11-07T12:00:00Z", status: "planned",
  affectedUsers: 0, supported: true, diagnostics: [], disruption: "May restart",
  targets: [
    { instanceId: "core-a", stage: 1 }, { instanceId: "core-b", stage: 0 },
  ].map((target) => ({ ...target, nodeId: "node", name: "Core", adapterId: "routeweaver/xray",
    coreVersion: "26.10.31", status: "planned", attempts: [], configDiff: [],
    affectedRouteIds: [], affectedUsers: 0, supported: true, diagnostics: [], changes: [] })),
});
const attempt = () => ({ number: 1, requestId: "request-a", status: "queued",
  queuedAt: "2026-11-07T12:00:01Z", leaseExpiresAt: "2026-11-07T12:05:01Z" });
it("accepts only bounded nonsecret creation intent and deeply freezes it", () => {
  const parsed = parseFleetCreation(JSON.stringify(envelope));
  expect(parsed).toEqual(envelope);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed!.request)).toBe(true);
  expect(Object.isFrozen(parsed!.request.targetIds)).toBe(true);
  expect(Object.isFrozen(parsed!.request.stages[0])).toBe(true);
  for (const extra of ["credentials", "csrfToken", "config", "generatedConfig", "actorId", "id"]) {
    expect(parseFleetCreation(JSON.stringify({ ...envelope, request: { ...envelope.request, [extra]: "secret" } }))).toBeNull();
  }
  expect(parseFleetCreation(JSON.stringify({ ...envelope, csrfToken: "secret" }))).toBeNull();
  expect(parseFleetCreation(" ".repeat(32769))).toBeNull();
});
it.for([
  { action: ["configure"] }, { targetIds: ["core-a", "core-a"] },
  { stages: [["core-a"], ["core-a"]] }, { stages: [["missing"]] },
  { stages: [[], ["core-a", "core-b"]] }, { targetIds: [] },
  { leaseSeconds: 29 }, { leaseSeconds: 300.5 }, { leaseSeconds: "300" },
  { expectedFingerprint: "short" }, { continuousService: "true" },
  { sourceBatchId: "old" }, { targetReleaseId: "release" },
  { deploymentId: "../path" }, { action: "stop", continuousService: true },
])("rejects malformed reviewed intent %j", (patch) => {
  expect(parseFleetCreation(JSON.stringify({ ...envelope, request: { ...envelope.request, ...patch } }))).toBeNull();
});
it("keeps explicit rollback and release identities only on their matching actions", () => {
  for (const request of [
    { ...envelope.request, action: "rollback", continuousService: false, sourceBatchId: "old" },
    { ...envelope.request, action: "install", continuousService: false, targetReleaseId: "release" },
  ]) expect(parseFleetCreation(JSON.stringify({ ...envelope, request }))).not.toBeNull();
});
it("matches every immutable creation field separately from mutable progress", () => {
  expect(matchFleetCreation(batch(), envelope)).not.toBeNull();
  expect(matchFleetCreation({ ...batch(), status: "pending", targets: batch().targets.map((t) => ({ ...t, status: "queued", attempts: [attempt()] })) }, envelope)).not.toBeNull();
  for (const patch of [
    { id: "another" }, { actorId: "admin-b" }, { deploymentId: "another" },
    { action: "start" }, { continuousService: false }, { sourceBatchId: "old" },
    { targetReleaseId: "release" }, { fingerprint: "b".repeat(64) }, { leaseSeconds: 600 },
    { targetIds: ["core-b", "core-a"] }, { stages: [["core-a"], ["core-b"]] },
    { createdAt: "invalid" }, { status: null }, { targets: [] },
  ]) expect(matchFleetCreation({ ...batch(), ...patch }, envelope)).toBeNull();
});
it("does not accept malformed success, swapped targets or changed stage attribution", () => {
  for (const value of [null, {}, [], { id: "batch_a" },
    { ...batch(), targets: [...batch().targets].reverse() },
    { ...batch(), targets: batch().targets.map((target) => ({ ...target, stage: 0 })) },
  ]) expect(matchFleetCreation(value, envelope)).toBeNull();
});
it("rejects incomplete batch shapes and malformed progress rather than casting them to usable batches", () => {
  for (const field of ["affectedUsers", "supported", "diagnostics", "disruption"]) {
    const value: Record<string, unknown> = batch();
    delete value[field];
    expect(matchFleetCreation(value, envelope)).toBeNull();
  }
  for (const patch of [
    { nodeId: null }, { name: null }, { affectedUsers: "0" }, { diagnostics: [null] },
    { attempts: null }, { attempts: [null] }, { attempts: [{}] },
    { attempts: [{ ...attempt(), queuedAt: null }] },
    { attempts: [{ ...attempt(), code: {} }] }, { attempts: [{ ...attempt(), observedAt: "invalid" }] },
    { configDiff: [{}] }, { configDiff: [null] },
  ]) expect(matchFleetCreation({ ...batch(), targets: batch().targets.map((target) => ({ ...target, ...patch })) }, envelope)).toBeNull();
  expect(matchFleetCreation({ ...batch(), targets: [
    { instanceId: "core-a", stage: 1, status: "planned", attempts: [] },
    { instanceId: "core-b", stage: 0, status: "planned", attempts: [] },
  ] }, envelope)).toBeNull();
});
it("normalizes only omitted optional defaults and rejects explicit nulls", () => {
  const defaults = { ...envelope, request: { ...envelope.request, continuousService: false } };
  const omitted: Record<string, unknown> = batch();
  delete omitted.continuousService;
  expect(matchFleetCreation(omitted, defaults)).not.toBeNull();
  for (const field of ["continuousService", "sourceBatchId", "targetReleaseId"])
    expect(matchFleetCreation({ ...omitted, [field]: null }, defaults)).toBeNull();
});
