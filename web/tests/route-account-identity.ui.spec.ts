import { test, expect } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App identity review, intercepted loopback GETs only. Opening the entry
// form is not permission to submit; every API mutation is rejected.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`route account captions retain the selected identity at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Route account identity requires loopback");
    const origin = new URL(baseURL).origin;
    const users = [
      { id: "alice", name: "同名用户" }, { id: "bob", name: "同名用户" },
      { id: "caption-user", name: "同名用户，账号标识：bob" }, { id: "carol", name: "独立用户" },
    ].map(user => ({ ...user, enabled: true, quotaBytes: 0, usedBytes: 0 }));
    const instance = { id: "core", hostId: "host", name: "协作核心", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
    const listener = { id: "entry", name: "协作监听", instanceId: "core", connection: { protocol: "vless", host: "0.0.0.0", port: 443 } };
    const line = { id: "line", name: "账号核对线路", deploymentId: "path", endpointIds: ["entry"], publicHost: "entry.invalid", publicPort: 443, status: "draft", diagnostics: [] };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "reviewer", name: "审查管理员", role: "admin" }, csrfToken: "synthetic-only" },
      "/api/published-routes": [line], "/api/published-routes/line/resolve": line,
      "/api/hosts": [{ id: "host", name: "协作主机", address: "host.invalid" }], "/api/core-instances": [instance],
      "/api/managed-endpoints": [listener], "/api/links": [], "/api/services": [],
      "/api/server-deployments": [{ id: "path", name: "协作路径", status: "draft", diagnostics: [],
        ir: { schemaVersion: "1.0", id: "path", topologyRevision: "fixture", programs: [{ instance, listener, rules: [], resources: [], egress: [] }] } }],
      "/api/state": { users, routes: [], publishedRoutes: [line], nodes: [], revisions: [], capabilities: [] },
    };
    for (const user of users) {
      fixtures[`/api/users/${user.id}/entries`] = [];
      fixtures[`/api/users/${user.id}/effective-policy`] = { userId: user.id, status: "active", routeIds: [line.id], groupIds: [],
        quotaBytes: 0, onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, provenance: { routes: "direct" },
        entitlement: { userId: user.id, startsAt: "2026-10-01T00:00:00Z", paused: false, cycle: { mode: "none" }, routeIdsOverride: null } };
    }
    const reads: string[] = [], blocked: string[] = [];
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (!url.search && request.method() === "GET" && url.pathname in fixtures) {
        reads.push(url.pathname);
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      blocked.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    const capture = async (phase: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await info.attach(`route-account-${width}-${phase}`, { body: await page.screenshot(), contentType: "image/png" });
    };
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#published-routes");
      await page.getByRole("button", { name: line.name, exact: true }).click();
      const detail = page.getByRole("dialog", { name: line.name, exact: true });
      await settledTask(detail);
      const choice = detail.getByRole("combobox", { name: "线路使用用户", exact: true });
      await choice.click();
      await expect(page.getByRole("option", { name: "同名用户，账号标识：bob", exact: true })).toHaveCount(1);
      await expect(page.getByRole("option", { name: "独立用户", exact: true })).toBeVisible();
      const literalChoice = page.getByRole("option", { name: "同名用户，账号标识：bob，账号标识：caption-user", exact: true });
      await expect(literalChoice).toBeVisible();
      await capture("distinct-accounts");
      await page.getByRole("combobox", { name: "搜索选项", exact: true }).fill("caption-user");
      await literalChoice.click();
      await expect(page).toHaveURL(/user=caption-user/);
      await expect(choice).toContainText("caption-user");
      await expect.poll(() => reads.includes("/api/users/caption-user/effective-policy")).toBe(true);
      await detail.getByRole("button", { name: "准备独立入口", exact: true }).click();
      const principal = page.getByRole("dialog", { name: `配置「${line.name}」的用户入口`, exact: true });
      await settledTask(principal);
      const locked = principal.getByRole("combobox", { name: "用户", exact: true });
      await expect(locked).toBeDisabled();
      await expect(locked).toContainText("caption-user");
      await capture("locked-account");
      expect(blocked).toEqual([]);
    } finally {
      await info.attach("route-account-ledger", { body: JSON.stringify({ width, selectedAccountRead: reads.includes("/api/users/caption-user/effective-policy"), blocked,
        scope: "Synthetic read-only identity review; no principal creation, credential delivery or runtime acceptance" }), contentType: "application/json" });
    }
  });
}
