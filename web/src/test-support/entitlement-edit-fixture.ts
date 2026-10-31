import type { EffectivePolicy, EntitlementPolicyEditContext, PolicyPreview } from "../access-policy-model";
import type { Entitlement } from "../types";

// Explicit fixture DTO completion, not production decoding/repair. Historical
// fixtures omit Go's non-omitempty paused field; keep dates/cycles unchanged.
function typedEntitlement(value: Entitlement): Entitlement {
  const result = { ...structuredClone(value), paused: value.paused === undefined ? false : value.paused };
  // Match Go's omitempty DTO, while preserving explicit zero and empty routes.
  if (result.serviceId === "") delete result.serviceId;
  for (const key of ["expiresAt", "quotaOverride", "routeIdsOverride", "onlineIpLimitOverride", "connectionLimitOverride", "entryRateBpsOverride"] as const)
    if (result[key] == null) delete result[key];
  return result;
}
function typedEffective(value: EffectivePolicy): EffectivePolicy {
  return { ...structuredClone(value), entitlement: typedEntitlement(value.entitlement) };
}
// Shape gate for these historical DTO fixtures, not a production validator.
// Missing paused is the one explicitly completed legacy fixture field above.
const record = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value: any) => Array.isArray(value) && value.every((item) => typeof item === "string");
const finite = (value: any) => typeof value === "number" && Number.isFinite(value);
function entitlementShape(value: any) {
  return record(value) && typeof value.userId === "string" && typeof value.startsAt === "string" &&
    (value.paused === undefined || typeof value.paused === "boolean") && record(value.cycle) &&
    ["mode", "anchor", "timezone"].every((key) => typeof value.cycle[key] === "string") &&
    ["day", "days"].every((key) => value.cycle[key] === undefined || finite(value.cycle[key])) &&
    Object.keys(value.cycle).every((key) => ["mode", "anchor", "timezone", "day", "days"].includes(key)) &&
    (value.serviceId === undefined || typeof value.serviceId === "string") && (value.expiresAt == null || typeof value.expiresAt === "string") &&
    ["quotaOverride", "onlineIpLimitOverride", "connectionLimitOverride", "entryRateBpsOverride"].every((key) => value[key] == null || finite(value[key])) &&
    (value.routeIdsOverride == null || stringList(value.routeIdsOverride)) &&
    Object.keys(value).every((key) => ["userId", "startsAt", "paused", "cycle", "serviceId", "expiresAt", "quotaOverride", "onlineIpLimitOverride", "connectionLimitOverride", "entryRateBpsOverride", "routeIdsOverride"].includes(key));
}
function effectiveShape(value: any) {
  return record(value) && typeof value.userId === "string" && typeof value.status === "string" &&
    ["quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps"].every((key) => finite(value[key])) &&
    stringList(value.groupIds) && stringList(value.routeIds) && record(value.provenance) &&
    Object.values(value.provenance).every((source) => typeof source === "string") && entitlementShape(value.entitlement) &&
    (value.serviceId === undefined || typeof value.serviceId === "string") &&
    Object.keys(value).every((key) => ["userId", "status", "quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps", "groupIds", "routeIds", "provenance", "entitlement", "serviceId", "service"].includes(key)) &&
    (value.service === undefined || (record(value.service) && typeof value.service.id === "string" && typeof value.service.name === "string" &&
      stringList(value.service.routeIds) && ["quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps"].every((key) => finite(value.service[key])) &&
      record(value.service.cycle) && ["mode", "anchor", "timezone"].every((key) => typeof value.service.cycle[key] === "string") &&
      ["day", "days"].every((key) => value.service.cycle[key] === undefined || finite(value.service.cycle[key])) &&
      Object.keys(value.service.cycle).every((key) => ["mode", "anchor", "timezone", "day", "days"].includes(key)) &&
      Object.keys(value.service).every((key) => ["id", "name", "quotaBytes", "routeIds", "onlineIpLimit", "connectionLimit", "entryRateBps", "cycle"].includes(key))));
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
// Preserve the existing test stubs' loose request argument types; envelope checks below are explicit.
type FixtureHandler = (url: any, init: any) => Promise<Response>;

// Capture the opened typed record/effective projection once. An explicit stored
// null is absence; the effective entitlement never infers it. No global registry.
export function entitlementEditFixture(
  effective: EffectivePolicy,
  options: { stored?: Entitlement | null; revision?: string } = {},
) {
  const openingEffective = typedEffective(effective);
  const stored = options.stored === null ? null : typedEntitlement(options.stored ?? effective.entitlement);
  const id = openingEffective.userId;
  if (openingEffective.entitlement.userId !== id || (stored && stored.userId !== id)) throw new Error("Mismatched entitlement fixture identity");
  const precondition = { exists: stored !== null, revision: options.revision ?? `opened-entitlement-${id}` };
  const context = (): EntitlementPolicyEditContext => ({
    target: { kind: "entitlement", id },
    record: stored ? { entitlement: structuredClone(stored) } : null,
    precondition: { ...precondition },
    effective: structuredClone(openingEffective),
  });
  const preview = (submitted: Entitlement, review: Pick<PolicyPreview, "revision" | "affected" | "blockers">) => {
    if (submitted.userId !== id || !review.revision || !Array.isArray(review.affected) || !Array.isArray(review.blockers))
      throw new Error("Invalid guarded entitlement-review fixture");
    return {
      ...review,
      affected: review.affected.map((effect) => ({ ...effect, before: typedEffective(effect.before), after: typedEffective(effect.after) })),
      guard: "opened-record" as const,
      resource: {
        target: { kind: "entitlement" as const, id },
        before: stored ? { entitlement: structuredClone(stored) } : null,
        after: { entitlement: typedEntitlement(submitted) },
      },
    };
  };
  // Old assertions inspect policy payload intent. The new dedicated editor
  // tracer asserts the real guarded envelope. This explicit per-fixture adapter
  // unwraps only that envelope for the old stub; other kinds/apply stay intact.
  const transport = (handler: FixtureHandler): FixtureHandler => async (url, init) => {
    const path = String(url);
    if (path === `/api/access-policy/edit-context/entitlement/${encodeURIComponent(id)}` && (!init?.method || init.method === "GET"))
      return json(context());
    if (path !== "/api/access-policy/preview" || !init?.body) return handler(url, init);
    const body = JSON.parse(String(init.body));
    if (body?.entitlement) throw new Error("Guarded entitlement fixture received a legacy preview body");
    if (!body?.change?.entitlement) return handler(url, init);
    if (Object.keys(body).sort().join() !== "change,precondition" ||
        Object.keys(body.change).join() !== "entitlement" ||
        body.precondition?.exists !== precondition.exists || body.precondition?.revision !== precondition.revision ||
        Object.keys(body.precondition).sort().join() !== "exists,revision" || body.change.entitlement.userId !== id)
      throw new Error("Invalid entitlement preview envelope in existing test");
    const response = await handler(url, { ...init, body: JSON.stringify(body.change) });
    if (!response.ok) return response;
    let review: any;
    try { review = await response.clone().json(); } catch { return response; }
    // Never supply a guard to an error or a malformed response. These migrated
    // fixtures explicitly return the old three-field preview success shape.
    if (!review || Object.keys(review).sort().join() !== "affected,blockers,revision" ||
        typeof review.revision !== "string" || !review.revision || !Array.isArray(review.affected) || !Array.isArray(review.blockers) ||
        !review.blockers.every((value: unknown) => typeof value === "string") ||
        !review.affected.every((effect: any) => record(effect) && Object.keys(effect).sort().join() === "after,before,userId" && typeof effect.userId === "string" && effectiveShape(effect.before) && effectiveShape(effect.after)))
      return response;
    return json(preview(body.change.entitlement, review), response.status);
  };
  return { context, preview, transport };
}
