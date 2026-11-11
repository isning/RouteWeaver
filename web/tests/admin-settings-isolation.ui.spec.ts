import { test, expect } from "@playwright/test";

// Real App with synthetic loopback GETs only. No mutation, settings save,
// authentication secret, real account or external service is exercised.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`users and settings recover independently at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Settings isolation requires loopback");
    const origin = new URL(baseURL).origin;
    const inventoryPaths = ["/api/state", "/api/services", "/api/published-routes"];
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "reviewer", name: "审查管理员", role: "admin" }, csrfToken: "synthetic-only" },
      "/api/state": { users: [{ id: "reader", name: "协作测试用户", enabled: true, quotaBytes: 0, usedBytes: 0 }], nodes: [], routes: [], revisions: [], capabilities: [] },
      "/api/services": [], "/api/published-routes": [], "/api/user-groups": [], "/api/rates": [], "/api/audit": [],
      "/api/settings": { name: "测试控制平台", registration: "invite", timezone: "UTC+8" },
      "/api/admin/subscription-origin": { revision: 1, configuredRevision: 1, draftOrigin: "", effectiveRevision: 1,
        effectiveOrigin: "", defaultOrigin: "https://example.invalid", currentLinkExample: "https://example.invalid/feed/{existing-token}",
        proposedLinkExample: "https://example.invalid/feed/{existing-token}", verificationStatus: "not-required", tokensUnchanged: true },
    };
    let settingsUnavailable = true, inventoryUnavailable = false, settingsReads = 0, inventoryReads = 0;
    const blocked: string[] = [];
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (!url.search && request.method() === "GET" && url.pathname in fixtures) {
        if (inventoryPaths.includes(url.pathname)) {
          inventoryReads++;
          if (inventoryUnavailable) return route.fulfill({ status: 503, json: { error: "用户清单暂时不可用" } });
        }
        if (url.pathname === "/api/settings") {
          settingsReads++;
          if (settingsUnavailable) return route.fulfill({ status: 503, json: { error: "平台设置暂时不可用" } });
        }
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      blocked.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    const capture = async (phase: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await info.attach(`admin-settings-${width}-${phase}`, { body: await page.screenshot(), contentType: "image/png" });
    };
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#users");
      await expect(page.getByRole("button", { name: "协作测试用户", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "用户组", exact: true })).toBeVisible();
      await expect(page.getByText("暂无用户组", { exact: true })).toBeVisible();
      expect(settingsReads).toBe(0);
      await capture("users-without-settings");
      const inventoryBeforeSettings = inventoryReads;
      inventoryUnavailable = true;
      await page.goto("/#settings");
      await expect(page.getByText("平台设置暂时不可用", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toHaveCount(0);
      expect(inventoryReads).toBe(inventoryBeforeSettings);
      await capture("settings-unavailable");
      settingsUnavailable = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByText("测试控制平台", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toBeEnabled();
      expect(inventoryReads).toBe(inventoryBeforeSettings);
      await capture("settings-recovered");
      expect(blocked).toEqual([]);
    } finally {
      await info.attach("admin-settings-ledger", { body: JSON.stringify({ width, settingsReads, inventoryReads, blocked,
        scope: "Synthetic read-only independent loading and recovery; no write or full accessibility acceptance" }), contentType: "application/json" });
    }
  });
}
