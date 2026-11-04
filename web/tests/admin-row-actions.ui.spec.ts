import { expect, test } from "@playwright/test";

// Read-only fixtures exercise menu disclosure, exact deletion review and safe
// cancellation. They never authorize a destructive backend request.
for (const width of [1440, 390]) {
  test(`legacy route actions stay quiet, named and keyboard reachable at ${width}px`, async ({ page }, info) => {
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Admin row action QA requires loopback");
    const name = "日常连接链路";
    const fixtures: Record<string, unknown> = {
      "/auth/me": {
        user: { id: "row-review-admin", name: "行操作审查", role: "admin" },
        csrfToken: "local-read-only-fixture",
      },
      "/state": {
        nodes: [{ id: "endpoint", name: "伦敦端点", host: "synthetic.example", port: 1080, protocol: "socks" }],
        users: [],
        routes: [{ id: "route", name, engine: "sing-box", hops: ["endpoint"], userIds: [] }],
        revisions: [], capabilities: [], deploymentAvailable: false,
      },
      "/services": [], "/settings": {}, "/published-routes": [],
      "/rates": [], "/user-groups": [],
    };
    const origin = new URL(baseURL).origin;
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const path = url.pathname.slice(4);
      if (request.method() !== "GET" || !(path in fixtures)) {
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 503, json: { detail: "Unsupported admin row fixture request" } });
      }
      return route.fulfill({ json: fixtures[path] });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#legacy-routes");
    const actions = page.getByRole("group", { name: `${name} 的操作`, exact: true });
    await expect(actions).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "操作", exact: true })).toBeVisible();
    await expect(actions.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
    await expect(actions.getByRole("button", { name: `校验 ${name}`, exact: true })).toBeVisible();
    await expect(actions.getByRole("button", { name: /删除/ })).toHaveCount(0);
    const opener = actions.getByRole("button", { name: `更多操作 ${name}`, exact: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await opener.focus();
      await page.keyboard.press("Enter");
      const remove = page.getByRole("menuitem", { name: `删除链路配置 ${name}`, exact: true });
      await expect(remove).toBeFocused();
      await expect(remove).toHaveText("删除链路配置");
      await page.keyboard.press("Enter");
      const confirmation = page.getByRole("alertdialog", { name: `删除链路配置「${name}」？`, exact: true });
      await expect(confirmation).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(confirmation.getByText("已分配用户将不能从此链路配置获取新配置。", { exact: true })).toBeVisible();
      await expect(confirmation.getByRole("button", { name: "保留", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(confirmation).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(opener).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await info.attach(`legacy-route-actions-${width}`, {
      body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
    });
  });
}
