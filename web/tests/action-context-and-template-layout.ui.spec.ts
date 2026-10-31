import { test, expect, type Locator, type Page } from "@playwright/test";

// Actual application views with read-only API fixtures. These checks establish
// rendering/keyboard context, not backend persistence or deployment behavior.
test.use({ trace: "off", screenshot: "off", video: "off" });
const names = ["日常连接订阅", "备用连接 · 长期维护的欧洲与亚太跨区域订阅来源"];
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "review-admin", name: "审查管理员", role: "admin" },
    csrfToken: "local-ui-fixture",
  },
  "/state": {
    users: names.map((name, i) => ({
      id: `u${i}`,
      name,
      enabled: true,
      quotaBytes: 107374182400,
    })),
    nodes: [],
    routes: [],
    revisions: [],
    capabilities: [],
  },
  "/services": [],
  "/settings": {},
  "/published-routes": [],
  "/rates": [],
  "/user-groups": [],
  "/me/sources": names.map((name, i) => ({
    id: `s${i}`,
    name,
    kind: "text",
    enabled: true,
    revision: "accepted-1",
    snapshot: { endpoints: [] },
    nodeCount: 0,
    refreshStatus: "accepted",
    updatedAt: "2026-10-27T08:00:00Z",
  })),
  "/me/resources": [...names, undefined].map((name, i) => ({
    id: name ? `r${i}` : "unnamed-rule-resource",
    name,
    revision: "1",
    format: "mihomo-yaml",
    behavior: "domain",
    location: "inline",
    updatePolicy: "pinned",
    acceptedVersion: "accepted-1",
    sizeBytes: 2450,
    canRefresh: i === 1,
  })),
  "/templates": [
    {
      id: "short",
      name: "工作与浏览分流",
      kind: "client-profile",
      version: 2,
      publishedAt: "2026-10-27T08:00:00Z",
      spec: { groups: [], rules: [] },
    },
    {
      id: "long",
      name: "按地区整理并去除重复节点",
      kind: "processing-preset",
      version: 1,
      publishedAt: "2026-10-27T08:00:00Z",
      spec: { steps: [] },
    },
  ],
  "/me/template-bindings": [],
  "/me/profiles": [],
  "/me/collections": [],
};

async function setup(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Controlled layout QA requires loopback");
  const origin = new URL(baseURL).origin,
    unexpected: string[] = [];
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    if (request.method() !== "GET" || !(path in fixtures)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 503,
        json: { detail: "Unexpected controlled layout request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}

async function horizontallyContained(target: Locator, viewport: Locator) {
  const box = await target.boundingBox(),
    bounds = await viewport.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width + 1,
  );
}

for (const width of [320, 390, 900, 1440])
  for (const route of ["sources", "users", "resources"]) {
    test(`${route} actions retain full target context at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      const unexpected = await setup(page);
      await page.goto(`/#${route}`);
      const viewport = page.locator('[data-slot="table-container"]').first();
      const targetNames =
        route === "resources" ? [...names, "unnamed-rule-resource"] : names;
      const rows = targetNames.map((name) =>
        page.getByRole("row").filter({
          has: page.getByRole("group", {
            name: `${name} 的操作`,
            exact: true,
          }),
        }),
      );
      await expect(rows[1]).toBeVisible();
      const overflowing = await viewport.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      if (width === 1440) expect(overflowing).toBe(false);
      else expect(overflowing).toBe(true);
      await viewport.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      for (const [index, row] of rows.entries()) {
        const group = row.getByRole("group", {
          name: `${targetNames[index]} 的操作`,
          exact: true,
        });
        const label = group.getByText(targetNames[index], { exact: true });
        if (overflowing) {
          await expect(label).toBeVisible();
          await horizontallyContained(label, viewport);
          const buttons = group.getByRole("button");
          await row.getByRole("button").first().focus();
          for (let i = 0; i < (await buttons.count()); i++) {
            await page.keyboard.press("Tab");
            await expect(buttons.nth(i)).toBeFocused();
            await horizontallyContained(label, viewport);
            await horizontallyContained(buttons.nth(i), viewport);
          }
        } else {
          await expect(label).not.toBeVisible();
          await expect(row.getByRole("button").first()).toBeVisible();
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`${route}-target-context-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      expect(unexpected).toEqual([]);
    });
  }

for (const width of [1440, 390])
  test(`template library preserves full titles and consistent action placement at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const unexpected = await setup(page);
    await page.goto("/#templates");
    const short = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "工作与浏览分流", exact: true }),
    });
    const long = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "按地区整理并去除重复节点",
        exact: true,
      }),
    });
    await expect(long).toBeVisible();
    const a = await short
      .getByRole("button", { name: "查看并使用" })
      .boundingBox();
    const b = await long
      .getByRole("button", { name: "查看并使用" })
      .boundingBox();
    if (width === 1440) expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
    else expect(b!.y).toBeGreaterThan(a!.y + a!.height);
    for (const card of [short, long]) {
      const title = card.getByRole("heading");
      expect(
        await title.evaluate(
          (el) =>
            el.scrollHeight <= el.clientHeight + 1 &&
            el.scrollWidth <= el.clientWidth + 1,
        ),
      ).toBe(true);
      await card
        .getByRole("button", { name: "查看并使用" })
        .scrollIntoViewIfNeeded();
      await expect(
        card.getByRole("button", { name: "查看并使用" }),
      ).toBeInViewport();
    }
    await page.screenshot({
      path: info.outputPath(`template-library-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    expect(unexpected).toEqual([]);
  });

for (const route of ["users", "services"])
  test(`${route} search toolbar contains task controls without filler copy`, async ({
    page,
  }) => {
    const unexpected = await setup(page);
    await page.goto(`/#${route}`);
    await expect(
      page.getByRole("textbox", {
        name: route === "users" ? "搜索用户" : "搜索服务方案",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("集中管理，按需展开", { exact: true }),
    ).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });

test("resource popup focus does not scroll its underlying row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpected = await setup(page);
  await page.goto("/#resources");
  const viewport = page.locator('[data-slot="table-container"]').first();
  const group = page.getByRole("group", {
    name: `${names[1]} 的操作`,
    exact: true,
  });
  await group.getByRole("button", { name: "刷新文件", exact: true }).click();
  const cancel = page.getByRole("button", { name: "取消", exact: true });
  const confirm = page.getByRole("button", { name: "读取并接纳", exact: true });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  // A horizontal scroll does not transfer focus away from the open popup.
  await viewport.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect(cancel).toBeFocused();
  const before = await viewport.evaluate((el) => el.scrollLeft);
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  expect(await viewport.evaluate((el) => el.scrollLeft)).toBe(before);
  // Cancel only dismisses the read/accept decision; no write is approved.
  await cancel.click();
  expect(unexpected).toEqual([]);
});

test("overflow identity settles across the Users table width boundary", async ({
  page,
}) => {
  const unexpected = await setup(page);
  await page.goto("/#users");
  await expect(
    page.getByRole("group", { name: `${names[0]} 的操作`, exact: true }),
  ).toBeVisible();
  const states = new Set<boolean>();
  const measurements = [];
  for (const width of [
    390, 768, 980, 1020, 1060, 1280, 1440, 1920, 1440, 1280, 1060, 980, 390,
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    const samples = await page
      .locator(".data-table")
      .first()
      .evaluate(async (root) => {
        const viewport = root.querySelector<HTMLElement>(
          '[data-slot="table-container"]',
        )!;
        const frame = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        await frame();
        await frame();
        const observed = [];
        for (let i = 0; i < 8; i++) {
          await frame();
          observed.push({
            marked: root.getAttribute("data-overflow") === "true",
            actual: viewport.scrollWidth > viewport.clientWidth + 1,
            clientWidth: viewport.clientWidth,
            scrollWidth: viewport.scrollWidth,
            actionWidth: root
              .querySelector(".table-row-actions")!
              .getBoundingClientRect().width,
          });
        }
        return observed;
      });
    expect(new Set(samples.map((s) => s.marked)).size).toBe(1);
    expect(new Set(samples.map((s) => s.clientWidth)).size).toBe(1);
    expect(new Set(samples.map((s) => s.scrollWidth)).size).toBe(1);
    expect(new Set(samples.map((s) => s.actionWidth)).size).toBe(1);
    for (const sample of samples) expect(sample.marked).toBe(sample.actual);
    states.add(samples[0].actual);
    measurements.push({ width, samples });
  }
  await test.info().attach("overflow-boundary-measurements", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
  expect([...states].sort()).toEqual([false, true]);
  expect(unexpected).toEqual([]);
});
