import { expect, test, type Page } from "@playwright/test";

// Read-only application fixtures measure the shared toolbar in two consumers.
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
  "/hosts": [],
  "/core-instances": [],
  "/managed-endpoints": [],
  "/links": [],
  "/server-deployments": [],
};

async function setup(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Toolbar layout QA requires loopback");
  const origin = new URL(baseURL).origin;
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
    if (request.method() !== "GET" || !(path in fixtures)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 503, json: { detail: "Unsupported toolbar fixture request" } });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}

for (const width of [320, 390, 900, 1440]) {
  for (const pageName of ["users", "routes"] as const) {
    test(`${pageName} keeps list search compact and usable at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const unexpected = await setup(page);
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
        const count = toolbar.getByText("共 0 条", { exact: true });
        await expect(count).toBeVisible();
        const countBox = (await count.boundingBox())!;
        if (width >= 640) {
          expect(countBox.x - (searchBox.x + searchBox.width)).toBeGreaterThanOrEqual(8);
          expect(countBox.x - (searchBox.x + searchBox.width)).toBeLessThanOrEqual(24);
        } else {
          expect(countBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
        }
      }
      await search.fill("待查名称");
      await search.press("Tab");
      const clear = toolbar.getByRole("button", { name: "清除搜索输入", exact: true });
      await expect(clear).toBeFocused();
      const clearBox = (await clear.boundingBox())!;
      expect(clearBox.width).toBeGreaterThanOrEqual(44);
      expect(clearBox.height).toBeGreaterThanOrEqual(44);
      await clear.press("Enter");
      await expect(search).toHaveValue("");
      await expect(search).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach(`${pageName}-toolbar-${width}`, {
        body: await page.screenshot(), contentType: "image/png",
      });
      expect(unexpected).toEqual([]);
    });
  }
}
