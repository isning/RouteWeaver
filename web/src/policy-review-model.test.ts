import { expect, it } from "vitest";
import {
  policyDifferenceFields,
  policySource,
  type EffectivePolicy,
} from "./access-policy-model";
const policy: EffectivePolicy = {
  userId: "user",
  groupIds: [],
  routeIds: ["route"],
  quotaBytes: 100,
  onlineIpLimit: 2,
  connectionLimit: 3,
  entryRateBps: 0,
  status: "active",
  provenance: { quotaBytes: "group", routes: "direct" },
  entitlement: {
    userId: "user",
    startsAt: "2026-01-01T00:00:00Z",
    cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
  },
};
it("compares exact effective values rather than rounded display labels", () => {
  expect(
    policyDifferenceFields(policy, { ...policy, quotaBytes: 101 }),
  ).toEqual(["quotaBytes"]);
});
it("keeps inheritance changes visible even when the effective quota is unchanged", () => {
  expect(
    policyDifferenceFields(policy, {
      ...policy,
      provenance: { ...policy.provenance, quotaBytes: "individual" },
    }),
  ).toEqual(["quotaBytes"]);
});
it("retains status, validity, reset, and route changes in review", () => {
  expect(
    policyDifferenceFields(policy, {
      ...policy,
      status: "paused",
      routeIds: [],
      entitlement: {
        ...policy.entitlement,
        expiresAt: "2026-11-01T00:00:00Z",
        cycle: { ...policy.entitlement.cycle, mode: "monthly", day: 1 },
      },
    }),
  ).toEqual(["status", "routes", "validity", "cycle"]);
});
it("does not manufacture differences for an identical policy", () => {
  expect(policyDifferenceFields(policy, structuredClone(policy))).toEqual([]);
});

it.each([
  [
    "matching snapshot wins",
    "service:plan",
    [{ id: "plan", name: "Later catalog" }],
    { id: "plan", name: "Reviewed plan" },
    "方案：Reviewed plan",
  ],
  [
    "mismatched snapshot uses known reference",
    "service:plan",
    [{ id: "plan", name: "Known plan" }],
    { id: "other", name: "Wrong plan" },
    "方案：Known plan",
  ],
  [
    "unresolved reference keeps its ID",
    "service:plan",
    [],
    { id: "other", name: "Wrong plan" },
    "方案：plan",
  ],
  [
    "unnamed matching snapshot uses known reference",
    "service:plan",
    [{ id: "plan", name: "Known plan" }],
    { id: "plan", name: "" },
    "方案：Known plan",
  ],
  [
    "direct suffix stays explicit",
    "service:plan+direct",
    [],
    { id: "plan", name: "Reviewed plan" },
    "方案：Reviewed plan + 直接授权",
  ],
  [
    "individual source is not relabelled",
    "individual",
    [],
    { id: "plan", name: "Reviewed plan" },
    "个人覆盖",
  ],
  [
    "unknown source stays unknown",
    "future-source",
    [],
    { id: "plan", name: "Reviewed plan" },
    "future-source",
  ],
  [
    "missing source keeps existing fallback",
    undefined,
    [],
    undefined,
    "未单独设置",
  ],
] as const)(
  "preserves provenance when %s",
  (_case, source, services, embedded, expected) => {
    expect(policySource(source, [...services], embedded)).toBe(expected);
  },
);
