import { test, expect } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Read-only real App task with synthetic loopback responses. No credential
// mutation or node traffic is allowed; the fixture has no authentication secret.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`authorized entry choices preserve route identity at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Entry identity requires loopback");
    const origin = new URL(baseURL).origin;
    const member = { id: "identity-user", name: "线路核对用户", enabled: true, quotaBytes: 0, usedBytes: 0 };
    const routes = [
      { id: "direct", name: "协作线路" }, { id: "group", name: "协作线路" },
      { id: "literal", name: "协作线路，线路标识：group" }, { id: "forbidden", name: "协作线路" },
    ].map(route => ({ ...route, engine: "sing-box", hops: [], userIds: [member.id] }));
    const entry = { id: "identity-entry", name: "待核对入口", routeId: "direct", credentialVersion: "synthetic-version", status: "configured",
      connection: { protocol: "socks", host: "endpoint.invalid", port: 1080 } };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "reviewer", name: "审查管理员", role: "admin" }, csrfToken: "synthetic-only" },
      "/api/state": { users: [member], nodes: [], routes, revisions: [], capabilities: [] },
      "/api/services": [], "/api/published-routes": [], "/api/user-groups": [], "/api/rates": [], "/api/audit": [],
      "/api/users/identity-user/entries": [entry], "/api/users/identity-user/entries/identity-entry/reveal": entry,
      "/api/users/identity-user/effective-policy": { userId: member.id, routeIds: ["direct", "group", "literal"], status: "active",
        provenance: { routes: "direct" }, entitlement: { cycle: { mode: "none" } } },
    };
    const blocked: string[] = [];
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (!url.search && request.method() === "GET" && url.pathname in fixtures)
        return route.fulfill({ json: fixtures[url.pathname] });
      blocked.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    const capture = async (phase: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await info.attach(`entry-route-${width}-${phase}`, { body: await page.screenshot(), contentType: "image/png" });
    };
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#users");
      await page.getByRole("row", { name: /线路核对用户/ }).getByRole("button", { name: "平台入口", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "线路核对用户 的平台入口", exact: true });
      await settledTask(sheet);
      await sheet.getByRole("listitem", { name: entry.name, exact: true }).getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("dialog", { name: `编辑 ${entry.name}`, exact: true });
      await settledTask(editor);
      const choice = editor.getByRole("combobox", { name: "授权线路", exact: true });
      await choice.click();
      await expect(page.getByRole("option")).toHaveCount(3);
      await expect(page.getByRole("option", { name: "协作线路，线路标识：direct", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: "协作线路，线路标识：group，线路标识：literal", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: /forbidden/ })).toHaveCount(0);
      await capture("distinct-options");
      await page.getByRole("combobox", { name: "搜索选项", exact: true }).fill("group");
      await page.getByRole("option", { name: "协作线路，线路标识：group", exact: true }).click();
      await expect(choice).toContainText("线路标识：group");
      await capture("selected-route");
      expect(blocked).toEqual([]);
    } finally {
      await info.attach("entry-route-ledger", { body: JSON.stringify({ width, blocked,
        scope: "Synthetic read-only choice identity; no save, credential delivery, runtime or full accessibility acceptance" }), contentType: "application/json" });
    }
  });
}
