import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Service, State } from "../src/types";

// Read-only synthetic API records exercise actual table pixels and native focus.
// They do not establish backend persistence, runtime health or deployment.
const services: Service[] = [
  {
    id: "office",
    name: "日常办公方案",
    quotaBytes: 107374182400,
    routeIds: [],
    cycle: { mode: "monthly", day: 1 },
  },
  {
    id: "travel",
    name: "跨区域出差 · 欧洲与亚太长期协作的远程办公方案",
    quotaBytes: 214748364800,
    routeIds: [],
    cycle: { mode: "monthly", day: 1 },
  },
];
const announcements = [
  {
    id: "notice-a",
    title: "线路维护通知",
    body: "维护安排",
    audience: "all",
    userIds: [],
    startsAt: "2026-10-01T08:00:00Z",
    expiresAt: "2027-01-01T08:00:00Z",
    enabled: true,
  },
  {
    id: "notice-b",
    title: "跨区域线路维护安排 · 欧洲与亚太团队需要提前了解的服务调整",
    body: "维护安排",
    audience: "all",
    userIds: [],
    startsAt: "2026-10-01T08:00:00Z",
    expiresAt: "2027-01-01T08:00:00Z",
    enabled: true,
  },
];
const state: State = {
  nodes: [],
  users: [],
  routes: [],
  revisions: [],
  capabilities: [],
  deploymentAvailable: false,
};
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "reviewer", name: "审查管理员", role: "admin" },
    csrfToken: "local-read-only-fixture",
  },
  "/state": state,
  "/services": services,
  "/published-routes": [],
  "/settings": {},
  "/rates": [],
  "/user-groups": [],
  "/admin/announcements": announcements,
};
async function setup(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Target-context QA requires loopback");
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
        json: { detail: "Unsupported read-only fixture request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}
async function contained(target: Locator, viewport: Locator) {
  const box = await target.boundingBox(),
    bounds = await viewport.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width + 1,
  );
}
for (const width of [320, 390, 1440])
  for (const route of ["services", "notifications"] as const) {
    test(`${route} edit preserves visible target context at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      const unexpected = await setup(page);
      await page.goto(`/#${route}`);
      const names =
        route === "services"
          ? services.map((s) => s.name)
          : announcements.map((a) => a.title);
      const viewport = page.locator('[data-slot="table-container"]').first();
      const rows = names.map((name) =>
        page
          .getByRole("row")
          .filter({ has: page.getByText(name, { exact: true }) }),
      );
      await expect(rows[1]).toBeVisible();
      if (route === "notifications") {
        // Readability is independent of overflow and reachable edit actions.
        for (const [index, row] of rows.entries()) {
          const cell = row.getByRole("cell").first();
          const geometry = await cell.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              width: element.getBoundingClientRect().width,
              height: element.getBoundingClientRect().height,
              lineHeight: parseFloat(style.lineHeight),
              verticalPadding:
                parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
            };
          });
          expect(geometry.width).toBeGreaterThanOrEqual(192);
          expect(
            geometry.height - geometry.verticalPadding,
          ).toBeLessThanOrEqual(
            geometry.lineHeight * (index === 0 ? 2 : 5) + 1,
          );
        }
        await page.screenshot({
          path: info.outputPath(`announcements-${width}-readable-titles.png`),
        });
      }
      const overflowing = await viewport.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(overflowing).toBe(width < 700);
      await viewport.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await page.screenshot({
        path: info.outputPath(`${route}-${width}-action-edge.png`),
      });
      for (const [index, name] of names.entries()) {
        const row = rows[index];
        const group = row.getByRole("group", {
          name: `${name} 的操作`,
          exact: true,
        });
        await expect(group).toBeVisible();
        const label = group.getByText(name, { exact: true });
        const edit = group.getByRole("button", {
          name: /编\s*辑/,
          exact: true,
        });
        if (overflowing) {
          await expect(label).toBeVisible();
          await contained(label, viewport);
          await contained(edit, viewport);
          expect(
            await label.evaluate(
              (el) => el.scrollHeight <= el.clientHeight + 1,
            ),
          ).toBe(true);
          // Start at the left edge, then native Tab must reveal target and control.
          await viewport.evaluate((el) => {
            el.scrollLeft = 0;
          });
          await edit.evaluate((el) => {
            el.focus({ preventScroll: true });
          });
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          await expect(edit).toBeFocused();
          await contained(label, viewport);
          await contained(edit, viewport);
        } else {
          await expect(label).toBeHidden();
          await expect(
            row.getByText(name, { exact: true }).first(),
          ).toBeVisible();
        }
      }
      await page.screenshot({
        path: info.outputPath(`${route}-${width}-keyboard-context.png`),
      });
      expect(unexpected).toEqual([]);
    });
  }

for (const viewportSize of [
  { width: 320, height: 360 },
  { width: 640, height: 400 },
]) {
  test(`announcement keyboard editing in short/reflow viewport ${viewportSize.width}x${viewportSize.height}`, async ({
    page,
  }, info) => {
    // 640x400 is the CSS layout viewport of 1280x800 at 200% browser zoom.
    // This proves reflow/keyboard geometry, not OS/browser zoom controls.
    await page.setViewportSize(viewportSize);
    const unexpected = await setup(page);
    await page.goto("/#notifications");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(announcements[1].title, { exact: true }) });
    const group = row.getByRole("group", {
      name: `${announcements[1].title} 的操作`,
      exact: true,
    });
    const edit = group.getByRole("button", { name: "编辑", exact: true });
    await expect(edit).toBeVisible();
    await edit.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await contained(
      group.getByText(announcements[1].title, { exact: true }),
      page.locator('[data-slot="table-container"]').first(),
    );
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "编辑公告", exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "公告标题", exact: true }),
    ).toHaveValue(announcements[1].title);
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    await cancel.focus();
    await expect(cancel).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(
        `announcement-short-reflow-${viewportSize.width}.png`,
      ),
    });
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(edit).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(unexpected).toEqual([]);
  });
}
