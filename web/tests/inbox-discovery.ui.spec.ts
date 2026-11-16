import { test, expect } from "@playwright/test";
for (const width of [1440, 390]) {
  test(`find messages and return from reading an unread item at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Inbox discovery requires loopback");
    await page.setViewportSize({ width, height: 900 });
    const origin = new URL(baseURL!).origin;
    let read = false;
    const unexpected: string[] = [];
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push("off-origin"); return route.abort(); }
      if (!url.pathname.startsWith("/api/") && request.method() === "GET") return route.continue();
      if (request.method() === "GET" && url.pathname === "/api/auth/me") return route.fulfill({ json: { user: { id: "reader", name: "Reader", role: "user" }, csrfToken: "synthetic" } });
      if (request.method() === "GET" && url.pathname === "/api/me/notifications") return route.fulfill({ json: [
        { eventId: "old", title: "维护安排", body: "周末维护", createdAt: "2026-11-15T10:00:00Z", readAt: "2026-11-15T11:00:00Z" },
        { eventId: "quota", title: "额度提醒", body: "流量已使用 80%", createdAt: "2026-11-16T10:00:00Z", ...(read ? { readAt: "2026-11-16T11:00:00Z" } : {}) },
      ] });
      if (request.method() === "POST" && url.pathname === "/api/me/notifications/quota/read") { read = true; return route.fulfill({ json: {} }); }
      unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
    });
    await page.goto("/#inbox");
    const main = page.getByRole("main"), toolbar = main.getByRole("search", { name: "筛选消息" });
    const search = toolbar.getByRole("searchbox", { name: "搜索消息" });
    await expect(search).toBeVisible();
    await toolbar.getByRole("button", { name: "未读 1", exact: true }).click();
    await search.fill("80%");
    await expect(main.getByRole("button", { name: /维护安排/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`inbox-filter-${width}.png`), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await main.getByRole("button", { name: /额度提醒/ }).click();
    const dialog = page.getByRole("dialog", { name: "额度提醒", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => read).toBe(true);
    await expect(dialog.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(search).toBeFocused();
    await expect(main.getByRole("heading", { name: "没有匹配的消息" })).toBeVisible();
    await main.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(main.getByRole("button", { name: /维护安排/ })).toBeVisible();
    await expect(search).toBeFocused();
    expect(unexpected).toEqual([]);
  });
}
