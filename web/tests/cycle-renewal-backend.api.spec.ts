import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import {
  assertCycleWindow,
  cycleFixture,
  cycleModes,
} from "./cycle-renewal-backend";

for (const [mode] of cycleModes)
  test(`isolated ${mode} cycle renewal and reset preserve meter identity and boundary`, async ({
    request,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    const recipient = await playwright.request.newContext({ baseURL });
    try {
      const f = await cycleFixture(request, recipient, mode);
      const apply = async (entitlement: unknown) => {
        const preview = await request.post("/api/access-policy/preview", {
          headers: f.headers,
          data: { entitlement },
        });
        expect(preview.status(), await preview.text()).toBe(200);
        const body = await preview.json();
        expect(body.blockers).toEqual([]);
        const result = await request.post("/api/access-policy/apply", {
          headers: f.headers,
          data: { change: { entitlement }, revision: body.revision },
        });
        expect(result.status(), await result.text()).toBe(200);
      };
      const before = await f.overview();
      await apply({
        ...before.entitlement,
        cycle: {
          ...before.entitlement.cycle,
          mode,
          day: mode === "monthly" ? 31 : 1,
          days: mode === "fixed-days" ? 7 : 0,
        },
      });
      const selected = await f.overview();
      assertCycleWindow(selected, mode);
      await f.seedUsage();
      await apply({
        ...selected.entitlement,
        expiresAt: new Date(
          Date.parse(selected.entitlement.expiresAt) + 3600000,
        ).toISOString(),
      });
      const renewed = await f.overview();
      expect(renewed.usage.weightedBytes).toBe(150);
      expect(renewed.entitlement.cycle.anchor).toBe(
        selected.entitlement.cycle.anchor,
      );
      expect(renewed.cycle.nextReset).toBe(selected.cycle.nextReset);
      expect(
        (
          await request.post(`/api/users/${f.account.id}/reset`, {
            headers: f.headers,
            data: { reason: "Synthetic cycle acceptance" },
          })
        ).status(),
      ).toBe(200);
      const reset = await f.overview();
      expect(reset.usage.weightedBytes).toBe(0);
      expect(reset.entitlement.cycle.anchor).toBe(
        selected.entitlement.cycle.anchor,
      );
      expect(reset.cycle.nextReset).toBe(selected.cycle.nextReset);
      await f.verifyReplayAndAudit();
      const personal = await recipient.get("/api/me/overview");
      expect(personal.status()).toBe(200);
      expect((await personal.json()).usage.weightedBytes).toBe(0);
    } finally {
      await recipient.dispose();
    }
  });
