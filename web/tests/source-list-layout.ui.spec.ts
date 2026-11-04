import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Source } from "../src/types";

// Read-only fixtures isolate list hierarchy and geometry. These tests do not
// apply source updates, change credentials, or claim backend verification.
const sourceNames = ["日常连接来源", "备用连接来源"];
const longSourceName =
  "备用连接来源 · 长期维护的欧洲与亚太跨区域连接选项 · 完整名称需要在操作位置仍然可读";

async function setup(page: Page, longName = false) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Source list layout QA requires loopback");
  const names = [sourceNames[0], longName ? longSourceName : sourceNames[1]];
  const sources: Source[] = names.map((name, index) => ({
    id: `layout-source-${index}`,
    name,
    kind: "text",
    enabled: true,
    applyMode: "manual",
    revision: "accepted-1",
    snapshot: { endpoints: [] },
    refreshStatus: index === 0 ? "accepted" : "review-required",
    updatedAt: "2026-11-04T08:00:00Z",
    ...(index === 1
      ? {
          candidate: {
            id: "layout-candidate",
            createdAt: "2026-11-04T09:00:00Z",
            diff: {
              beforeCount: 0,
              afterCount: 1,
              added: [{ id: "layout-endpoint", name: "新增连接" }],
              removed: [],
              connectionChanged: [],
              renamed: [],
            },
            affected: [],
          },
        }
      : {}),
  }));
  const fixtures: Record<string, unknown> = {
    "/auth/me": {
      user: { id: "list-review-admin", name: "列表审查", role: "admin" },
      csrfToken: "local-read-only-fixture",
    },
    "/state": {
      users: [],
      nodes: [],
      routes: [],
      revisions: [],
      capabilities: [],
      deploymentAvailable: false,
    },
    "/services": [],
    "/settings": {},
    "/published-routes": [],
    "/rates": [],
    "/user-groups": [],
    "/me/sources": sources,
    "/me/profiles": [],
    "/me/collections": [],
  };
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
      return route.fulfill({
        status: 503,
        json: { detail: "Unsupported source list fixture request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#sources");
  const groups = names.map((name) =>
    page.getByRole("group", { name: `${name} 的操作`, exact: true }),
  );
  await expect(groups[1]).toBeVisible();
  return { names, groups, unexpected };
}

async function contained(target: Locator, viewport: Locator) {
  const box = (await target.boundingBox())!;
  const bounds = (await viewport.boundingBox())!;
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
}

for (const width of [1280, 1440, 2048]) {
  test(`source rows keep a single aligned action line at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { groups, unexpected } = await setup(page);
    const table = page.getByRole("table");
    await expect(table).toHaveAccessibleDescription("2 个私有来源");
    await expect(
      page.getByRole("columnheader", { name: "操作", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("向左右滚动查看完整表格")).toHaveCount(0);
    const rows = page
      .getByRole("row")
      .filter({ has: page.getByRole("group", { name: /的操作$/ }) });
    const first = (await rows.nth(0).boundingBox())!;
    const second = (await rows.nth(1).boundingBox())!;
    expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1);
    expect(first.height).toBeGreaterThanOrEqual(56);
    expect(first.height).toBeLessThanOrEqual(72);
    const actions = groups[1].getByRole("button");
    await expect(actions).toHaveCount(3);
    const boxes = await Promise.all(
      (await actions.all()).map((button) => button.boundingBox()),
    );
    const centers = boxes.map((box) => box!.y + box!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index]!.x).toBeGreaterThanOrEqual(
        boxes[index - 1]!.x + boxes[index - 1]!.width,
      );
    for (const group of groups)
      await expect(group.locator(".table-row-action-target")).not.toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await info.attach(`source-list-${width}`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
    expect(unexpected).toEqual([]);
  });
}

test("narrow source rows keep long target names and all actions reachable by keyboard", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { names, groups, unexpected } = await setup(page, true);
  const viewport = page.getByRole("region", {
    name: "表格滚动区域",
    exact: true,
  });
  await expect(viewport).toHaveAccessibleDescription("向左右滚动查看完整表格");
  await viewport.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const row = page.getByRole("row").filter({ has: groups[1] });
  await row.getByRole("button").first().focus();
  const buttons = groups[1].getByRole("button");
  await expect(buttons).toHaveCount(3);
  const identity = groups[1].getByText(names[1], { exact: true });
  for (const button of await buttons.all()) {
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await contained(button, viewport);
    await expect(identity).toBeVisible();
    await contained(identity, viewport);
  }
  const menuTrigger = buttons.last();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: `刷新 ${names[1]}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: `编辑 ${names[1]}`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
  await contained(menuTrigger, viewport);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await info.attach("source-list-390-keyboard", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  expect(unexpected).toEqual([]);
});
