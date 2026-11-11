import { test, expect } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Actual App; all API reads are loopback-only synthetic fixtures. No mutations,
// live route operations, credentials, databases, automatic traces or video.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`route browsing survives unrelated inventory failure at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Route inventory recovery requires loopback");
    const origin = new URL(baseURL).origin;
    const route = { id: "review-line", name: "协作测试线路", deploymentId: "review-path", endpointIds: [],
      publicHost: "entry.invalid", publicPort: 443, status: "draft", diagnostics: [], pendingChanges: true,
      savedPath: { hops: [] } };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "reviewer", name: "审查管理员", role: "admin" }, csrfToken: "synthetic-only" },
      "/api/published-routes": [route], "/api/published-routes/review-line/resolve": route,
      "/api/hosts": [], "/api/core-instances": [], "/api/managed-endpoints": [], "/api/links": [],
      "/api/server-deployments": [{ id: "review-path", name: "协作转发路径", status: "draft", ir: { id: "review-path", programs: [] } }],
      "/api/state": { users: [], routes: [], services: [], publishedRoutes: [route] },
    };
    let inventoryUnavailable = true;
    const blocked: string[] = [];
    await page.route("**/*", async requestRoute => {
      const request = requestRoute.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return requestRoute.abort(); }
      if (!url.pathname.startsWith("/api/")) return requestRoute.continue();
      if (!url.search && request.method() === "GET" && url.pathname in fixtures) {
        if (url.pathname === "/api/hosts" && inventoryUnavailable)
          return requestRoute.fulfill({ status: 503, json: { error: "服务器清单暂时不可用" } });
        return requestRoute.fulfill({ json: fixtures[url.pathname] });
      }
      blocked.push(`${request.method()} ${url.pathname}`);
      return requestRoute.abort();
    });
    const capture = async (phase: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await info.attach(`route-inventory-${width}-${phase}`, { body: await page.screenshot(), contentType: "image/png" });
    };
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#published-routes");
      await expect(page.getByRole("button", { name: "重试读取转发路径", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: route.name, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "配置公开线路", exact: true })).toBeDisabled();
      await capture("list-unavailable");
      await page.getByRole("button", { name: route.name, exact: true }).click();
      const detail = page.getByRole("dialog", { name: route.name, exact: true });
      await settledTask(detail);
      await expect(detail.getByRole("button", { name: "编辑线路", exact: true })).toBeDisabled();
      await expect(detail.getByRole("button", { name: "更换出口", exact: true })).toBeDisabled();
      await capture("detail-unavailable");
      inventoryUnavailable = false;
      await detail.getByRole("button", { name: "重试读取转发路径", exact: true }).click();
      await expect(detail.getByRole("button", { name: "编辑线路", exact: true })).toBeEnabled();
      await expect(detail.getByRole("button", { name: "更换出口", exact: true })).toBeEnabled();
      await expect(detail.getByText("协作转发路径", { exact: true })).toBeVisible();
      await capture("detail-recovered");
      expect(blocked).toEqual([]);
    } finally {
      await info.attach("route-inventory-ledger", { body: JSON.stringify({ width, blocked, inventoryUnavailable,
        scope: "Synthetic read-only recovery; no write, runtime or full accessibility acceptance" }), contentType: "application/json" });
    }
  });
}
