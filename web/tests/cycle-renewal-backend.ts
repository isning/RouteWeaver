import { expect, type APIRequestContext } from "@playwright/test";
import { inviteSyntheticAccount } from "./account-security-backend";

export const cycleModes = [
  ["monthly", "每月固定日"],
  ["anniversary", "按周期起点日每月重置"],
  ["fixed-days", "固定天数周期"],
  ["none", "不自动重置"],
] as const;
export type CycleMode = (typeof cycleModes)[number][0];
export async function cycleFixture(
  admin: APIRequestContext,
  recipient: APIRequestContext,
  mode: CycleMode,
) {
  const account = await inviteSyntheticAccount(admin, recipient);
  const headers = {
    "X-CSRF-Token": (await (await admin.get("/api/auth/me")).json()).csrfToken,
  };
  const expires = new Date(Date.now() + 7 * 86400000);
  expires.setUTCHours(12, 0, 0, 0);
  const initial = {
    userId: account.id,
    startsAt: "2026-01-15T00:00:00+08:00",
    expiresAt: expires.toISOString(),
    quotaOverride: 1000,
    cycle: {
      mode: mode === "none" ? "monthly" : "none",
      day: 1,
      anchor: "2026-01-15T00:00:00+08:00",
      timezone: "UTC+8",
    },
  };
  expect(
    (
      await admin.put(`/api/users/${account.id}/entitlement`, {
        headers,
        data: initial,
      })
    ).status(),
  ).toBe(200);
  const overview = async () => {
    const r = await recipient.get("/api/me/overview");
    expect(r.status()).toBe(200);
    return r.json();
  };
  const meter = {
    userId: account.id,
    routeId: "cycle-synthetic-route",
    meterId: "cycle-synthetic-meter",
    epoch: "test",
    sequence: 1,
    rawBytes: 100,
    providerBytes: 120,
    observedAt: new Date().toISOString(),
  };
  expect(
    (
      await admin.post("/api/rates", {
        headers,
        data: {
          id: "cycle-rate",
          routeId: meter.routeId,
          micros: 1500000,
          effectiveAt: "2026-01-01T00:00:00Z",
        },
      })
    ).status(),
  ).toBe(201);
  const seedUsage = async () => {
    expect(
      (await admin.post("/api/usage", { headers, data: meter })).status(),
    ).toBe(200);
    expect((await overview()).usage).toMatchObject({
      rawBytes: 100,
      providerBytes: 120,
      weightedBytes: 150,
    });
  };
  const verifyReplayAndAudit = async () => {
    expect(
      (await admin.post("/api/usage", { headers, data: meter })).status(),
    ).toBe(200);
    expect(
      (
        await admin.post("/api/usage", {
          headers,
          data: { ...meter, rawBytes: 101 },
        })
      ).status(),
    ).toBe(400);
    expect((await overview()).usage.weightedBytes).toBe(0);
    const audit = await (await admin.get("/api/audit")).json();
    expect(
      audit.filter(
        (r: { action: string; targetId: string }) =>
          r.action === "usage.reset" && r.targetId === account.id,
      ),
    ).toHaveLength(1);
  };
  return {
    account,
    headers,
    overview,
    seedUsage,
    verifyReplayAndAudit,
    initial,
  };
}
export function assertCycleWindow(value: any, mode: CycleMode) {
  expect(value.entitlement.cycle.mode).toBe(mode);
  expect(value.entitlement.cycle.timezone).toBe("UTC+8");
  expect(value.cycle.timezone).toBe("UTC+8");
  if (mode === "none") {
    expect(value.cycle.nextReset ?? null).toBeNull();
    return;
  }
  expect(Date.parse(value.cycle.nextReset)).toBeGreaterThan(Date.now());
  const wall = new Date(Date.parse(value.cycle.nextReset) + 8 * 3600000);
  expect(wall.getUTCHours()).toBe(0);
  expect(wall.getUTCMinutes()).toBe(0);
  if (mode === "monthly") {
    expect(value.entitlement.cycle.day).toBe(31);
    const monthEnd = new Date(
      Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0),
    ).getUTCDate();
    expect(wall.getUTCDate()).toBe(monthEnd);
  }
  if (mode === "anniversary") expect(wall.getUTCDate()).toBe(15);
  if (mode === "fixed-days")
    expect(
      Date.parse(value.cycle.nextReset) - Date.parse(value.cycle.start),
    ).toBe(7 * 86400000);
}
