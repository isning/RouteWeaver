import { expect, test, type Page } from "@playwright/test";

// Read-only application fixtures measure plain-list and filtered task toolbars.
// They establish responsive layout and keyboard behavior, not backend behavior.
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "toolbar-review", name: "布局审查", role: "admin" },
    csrfToken: "local-read-only-fixture",
  },
  "/state": {
    nodes: [], users: [], routes: [], revisions: [], capabilities: [],
    deploymentAvailable: false,
  },
  "/services": [],
  "/published-routes": [],
  "/settings": {},
  "/rates": [],
  "/user-groups": [],
  "/hosts": [{
    id: "toolbar-host", name: "远程协作服务器", address: "inventory.example.test",
    group: "协作团队", tags: ["办公", "远程协作"],
  }],
  "/core-instances": [],
  "/managed-endpoints": [],
  "/links": [],
  "/server-deployments": [],
  "/admin/fleet-batches": [],
};

async function setup(page: Page, inventory: "empty" | "route" | "fleet" = "empty") {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Toolbar layout QA requires loopback");
  const origin = new URL(baseURL).origin;
  const instance = {
    id: "toolbar-core", hostId: "toolbar-host", name: "远程协作核心",
    adapterId: "routeweaver/xray", version: "26.3.27",
  };
  const pageFixtures: Record<string, unknown> = {
    ...fixtures,
    ...(inventory !== "empty" ? {
      "/server-deployments": [{
        id: "toolbar-route", name: "远程协作转发路径", status: "draft",
        diagnostics: [], updatedAt: "2026-11-04T08:00:00Z",
        ir: {
          schemaVersion: "1.0", id: "toolbar-route", topologyRevision: "1",
          programs: inventory === "fleet" ? [{ instance }] : [],
        },
      }],
    } : {}),
    ...(inventory === "fleet" ? { "/core-instances": [instance] } : {}),
  };
  const unexpected: string[] = [];
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    if (request.method() !== "GET" || !(path in pageFixtures)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 503, json: { detail: "Unsupported toolbar fixture request" } });
    }
    return route.fulfill({ json: pageFixtures[path] });
  });
  return unexpected;
}

for (const width of [390, 900, 1280]) {
  test(`Fleet keeps search and filters usable as selected tags grow at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const unexpected = await setup(page, "fleet");
    await page.goto("/#fleet");
    await page.getByRole("button", { name: "计划变更", exact: true }).click();
    const plan = page.getByRole("dialog", { name: "计划批量变更", exact: true });
    const toolbar = plan.getByRole("search", { name: "筛选执行范围", exact: true });
    // Range controls belong to a selected, populated path. An empty inventory
    // deliberately has no instance filters, so establish that task prerequisite.
    await expect(plan.getByText("先选择已保存的转发路径。", { exact: true })).toBeVisible();
    await expect(toolbar).toHaveCount(0);
    await plan.getByRole("combobox", { name: "批量变更转发路径", exact: true }).click();
    await page.getByRole("option", { name: "远程协作转发路径", exact: true }).click();
    await expect(toolbar).toBeVisible();
    const search = toolbar.getByRole("textbox", { name: "筛选批量变更实例", exact: true });
    const group = toolbar.getByRole("combobox", { name: "筛选服务器分组", exact: true });
    const tags = toolbar.getByRole("combobox", { name: "筛选服务器标签", exact: true });
    await group.click();
    await page.getByRole("option", { name: "协作团队", exact: true }).click();

    for (const selected of [0, 1, 2]) {
      if (selected > 0) {
        await tags.click();
        await page.getByRole("option", { name: selected === 1 ? "办公" : "远程协作", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(tags).toBeFocused();
      }
      await toolbar.scrollIntoViewIfNeeded();
      const searchBox = (await search.boundingBox())!;
      const groupBox = (await group.boundingBox())!;
      const tagBox = (await tags.boundingBox())!;
      const fieldBox = (await toolbar.locator('[data-slot="input-group"]').boundingBox())!;
      const toolbarBox = (await toolbar.boundingBox())!;
      // Capture before assertions so a layout regression retains useful pixels.
      await info.attach(`fleet-toolbar-${width}-${selected}-tags`, {
        body: await page.screenshot(), contentType: "image/png",
      });
      for (const box of [searchBox, groupBox, tagBox]) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(toolbarBox.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1);
      }
      if (width >= 900) {
        expect(Math.abs(searchBox.y - groupBox.y)).toBeLessThanOrEqual(2);
        expect(Math.abs(searchBox.y - tagBox.y)).toBeLessThanOrEqual(2);
        expect(fieldBox.width).toBeGreaterThanOrEqual(256);
        expect(fieldBox.width).toBeLessThanOrEqual(320);
        expect(groupBox.width).toBeGreaterThanOrEqual(140);
        expect(tagBox.width).toBeGreaterThanOrEqual(140);
      } else {
        expect(Math.abs(fieldBox.width - toolbarBox.width)).toBeLessThanOrEqual(1);
        expect(groupBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
      }
      expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await toolbar.getByRole("button", { name: "移除 办公", exact: true }).click();
    await toolbar.getByRole("button", { name: "移除 远程协作", exact: true }).click();
    await expect(group).toHaveText("协作团队");
    await search.fill("远程");
    await search.press("Tab");
    const clear = toolbar.getByRole("button", { name: "清除搜索输入", exact: true });
    await expect(clear).toBeFocused();
    await clear.press("Enter");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    expect(unexpected).toEqual([]);
  });
}

for (const width of [320, 390, 900, 1440]) {
  for (const pageName of ["users", "routes"] as const) {
    test(`${pageName} keeps list search compact and usable at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const unexpected = await setup(page, pageName === "routes" ? "route" : "empty");
      await page.goto(`/#${pageName}`);
      const toolbar = page.getByRole("search", {
        name: pageName === "users" ? "查找用户" : "查找转发路径",
        exact: true,
      });
      const search = toolbar.getByLabel(pageName === "users" ? "搜索用户" : "搜索转发路径", { exact: true });
      await expect(search).toBeVisible();
      const bounds = (await toolbar.boundingBox())!;
      const searchBox = (await toolbar.locator('[data-slot="input-group"]').boundingBox())!;
      expect(searchBox.height).toBeGreaterThanOrEqual(44);
      expect(searchBox.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      if (width >= 640) {
        // A practical search measure, rather than a field stretched across the inventory.
        expect(searchBox.width).toBeGreaterThanOrEqual(280);
        expect(searchBox.width).toBeLessThanOrEqual(352);
      } else {
        expect(Math.abs(searchBox.width - bounds.width)).toBeLessThanOrEqual(1);
      }
      if (pageName === "routes") {
        const table = page.getByRole("table");
        await expect(table).toHaveAccessibleDescription("共 1 条转发路径");
        const summaryID = await table.getAttribute("aria-describedby");
        expect(summaryID).toBeTruthy();
        const count = page.locator(`[id="${summaryID}"]`);
        await expect(count).toBeVisible();
        await expect(count).toHaveText("共 1 条转发路径");
        await expect(toolbar.getByText("共 1 条转发路径", { exact: true })).toHaveCount(0);
        const countBox = (await count.boundingBox())!;
        const headingBox = (await table.getByRole("row").first().boundingBox())!;
        // The total belongs to the table's header strip, independent of search width.
        expect(countBox.x).toBeGreaterThanOrEqual(bounds.x - 1);
        expect(countBox.x + countBox.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        expect(countBox.y).toBeGreaterThanOrEqual(bounds.y + bounds.height - 1);
        expect(countBox.y + countBox.height).toBeLessThanOrEqual(headingBox.y + 1);
      }
      await search.fill("待查名称");
      if (pageName === "routes") {
        const table = page.getByRole("table");
        await expect(table).toHaveAccessibleDescription(/找到 0 条转发路径\s*共 1 条转发路径/);
        await expect(table.getByRole("button", { name: "远程协作转发路径", exact: true })).toHaveCount(0);
      }
      await search.press("Tab");
      const clear = toolbar.getByRole("button", { name: "清除搜索输入", exact: true });
      await expect(clear).toBeFocused();
      const clearBox = (await clear.boundingBox())!;
      expect(clearBox.width).toBeGreaterThanOrEqual(44);
      expect(clearBox.height).toBeGreaterThanOrEqual(44);
      await clear.press("Enter");
      await expect(search).toHaveValue("");
      await expect(search).toBeFocused();
      if (pageName === "routes") {
        const table = page.getByRole("table");
        await expect(table).toHaveAccessibleDescription("共 1 条转发路径");
        await expect(table.getByRole("button", { name: "远程协作转发路径", exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach(`${pageName}-toolbar-${width}`, {
        body: await page.screenshot(), contentType: "image/png",
      });
      expect(unexpected).toEqual([]);
    });
  }
}

test("an empty route inventory keeps its neutral state and search keyboard flow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const unexpected = await setup(page);
  await page.goto("/#routes");
  await expect(page.getByText("暂无服务器转发路径", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  const toolbar = page.getByRole("search", { name: "查找转发路径", exact: true });
  const search = toolbar.getByLabel("搜索转发路径", { exact: true });
  await search.fill("待查名称");
  await search.press("Tab");
  const clear = toolbar.getByRole("button", { name: "清除搜索输入", exact: true });
  await expect(clear).toBeFocused();
  await clear.press("Enter");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.getByText("暂无服务器转发路径", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(unexpected).toEqual([]);
});
