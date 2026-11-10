import { test, expect, type Locator } from "@playwright/test";

// Read-only fixtures exercise actual layout and keyboard behavior, not persistence.
const target =
  "SharedLongUnbrokenTargetPrefixForRecognitionAcrossDuplicateNames";
const template = "长期维护的跨区域节点处理模板";
const targets = ["first-target", "second-target"];
async function contained(item: Locator, viewport: Locator) {
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  const bounds = await viewport.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width + 1,
  );
  expect(
    await item.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
}
for (const width of [390, 1440]) {
  test(`template binding actions preserve duplicate long-name context and keyboard focus at ${width}`, async ({
    page,
    baseURL,
  }, info) => {
    if (
      !baseURL ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    )
      throw new Error("Template layout checks require loopback");
    await page.setViewportSize({ width, height: 1000 });
    const unexpected: string[] = [];
    const fixtures: Record<string, unknown> = {
      "/auth/me": {
        user: { id: "owner", name: "Owner", role: "user" },
        csrfToken: "layout-only",
      },
      "/me/template-bindings": targets.map((id, i) => ({
        id: `collections_${id}`,
        targetId: id,
        targetKind: "collections",
        templateId: "preset",
        mode: i === 0 ? "follow" : "pinned",
        appliedVersion: 1,
        bindings: {},
      })),
      "/templates": [
        {
          id: "preset",
          name: template,
          kind: "processing-preset",
          version: 1,
          spec: { steps: [] },
        },
      ],
      "/me/collections": targets.map((id) => ({
        id,
        name: target,
        sources: [],
      })),
      "/me/profiles": [],
      "/me/sources": [],
      "/me/platform-entries": [],
    };
    const origin = new URL(baseURL).origin;
    await page.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) {
        if (request.method() === "GET") return route.continue();
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      const path = url.pathname.slice(4);
      if (request.method() !== "GET" || !(path in fixtures)) {
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({
          status: 503,
          json: { detail: "Unexpected layout request" },
        });
      }
      return route.fulfill({ json: fixtures[path] });
    });
    await page.goto("/#templates");
    const mine = page.getByRole("tab", { name: "我的引用", exact: true });
    await mine.click();
    const viewport = page.locator(
      '.template-bindings-table [data-slot="table-container"]',
    );
    const scrollRegion = page.getByRole("region", {
      name: "表格滚动区域",
      exact: true,
    });
    const expectOverflow = async (overflow: boolean) => {
      await expect
        .poll(() =>
          viewport.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        )
        .toBe(overflow);
      await expect(scrollRegion).toHaveCount(overflow ? 1 : 0);
    };
    await expect(viewport).toBeVisible();
    await expectOverflow(width === 390);
    await mine.focus();
    for (const [index, id] of targets.entries()) {
      const identity = `${target}（集合 ${id}） 使用 ${template}`;
      const group = page.getByRole("group", {
        name: `${identity} 的操作`,
        exact: true,
      });
      const label = group.getByText(identity, { exact: true });
      const action = group.getByRole("button", {
        name: `${index === 0 ? "检查更新" : "查看固定版本"} ${target}（集合 ${id}）`,
        exact: true,
      });
      // Reach each real row action with Tab, never activate a preview or mutation.
      for (
        let attempts = 0;
        attempts < 6 &&
        !(await action.evaluate((el) => el === document.activeElement));
        attempts++
      )
        await page.keyboard.press("Tab");
      await expect(action).toBeFocused();
      await contained(label, viewport);
      await contained(action, viewport);
      if (width === 390)
        expect(await viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(
          0,
        );
      await page.setViewportSize({
        width: width === 390 ? 360 : 390,
        height: 1000,
      });
      await expect(action).toBeFocused();
      await expectOverflow(true);
      await expect
        .poll(async () => {
          const box = await label.boundingBox();
          const bounds = await viewport.boundingBox();
          return (
            !!box &&
            !!bounds &&
            box.x >= bounds.x - 1 &&
            box.x + box.width <= bounds.x + bounds.width + 1
          );
        })
        .toBe(true);
      await contained(action, viewport);
      await page.setViewportSize({ width, height: 1000 });
      await expectOverflow(width === 390);
      await expect(async () => {
        await expect(action).toBeFocused();
        await contained(label, viewport);
        await contained(action, viewport);
      }).toPass();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`template-binding-context-${width}.png`),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
  });
}
