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

async function focusRingContained(button: Locator, viewport: Locator) {
  await expect(button).toBeFocused();
  const focus = await button.evaluate((element) => ({
    visible: element.matches(":focus-visible"),
    shadow: getComputedStyle(element).boxShadow,
  }));
  expect(focus.visible).toBe(true);
  expect(focus.shadow).not.toBe("none");
  const box = (await button.boundingBox())!;
  const bounds = (await viewport.boundingBox())!;
  // The official Button uses ring-3 outside its border box. Test its painted
  // extent, not merely the click target. Half a pixel accommodates rasterization.
  expect(box.x - 3).toBeGreaterThanOrEqual(bounds.x - 0.5);
  expect(box.x + box.width + 3).toBeLessThanOrEqual(
    bounds.x + bounds.width + 0.5,
  );
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

async function expectSourceColumnRhythm(page: Page, width: 1440 | 2048) {
  const table = page.getByRole("table");
  const bounds = (await table.boundingBox())!;
  const columns = await Promise.all(
    ["来源", "节点", "状态", "最近更新", "操作"].map((name) =>
      table.getByRole("columnheader", { name, exact: true }).boundingBox(),
    ),
  );
  const [source, nodes, status, updated, actions] = columns.map(
    (column) => column!,
  );
  // Wider inventories distribute space across fields instead of leaving all
  // spare room before the first count. Compact tables keep their existing widths.
  if (width === 2048) {
    expect(source.width / bounds.width).toBeCloseTo(0.36, 2);
    expect(nodes.width / bounds.width).toBeCloseTo(0.08, 2);
    expect(status.width / bounds.width).toBeCloseTo(0.16, 2);
    expect(updated.width).toBeGreaterThanOrEqual(184);
  } else {
    expect(source.width / bounds.width).toBeGreaterThanOrEqual(0.39);
    expect(source.width / bounds.width).toBeLessThanOrEqual(0.44);
    expect(nodes.width).toBeCloseTo(80, 0);
    expect(status.width).toBeCloseTo(124, 0);
    expect(updated.width).toBeCloseTo(184, 0);
  }
  expect(actions.width).toBeCloseTo(280, 0);
  for (let index = 1; index < columns.length; index++)
    expect(columns[index]!.x).toBeCloseTo(
      columns[index - 1]!.x + columns[index - 1]!.width,
      0,
    );
  await expect(page.getByText("向左右滚动查看完整表格")).toHaveCount(0);
}

for (const width of [1440, 2048] as const) {
  test(`source columns preserve scanning rhythm and wrap complete long names at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { names, groups, unexpected } = await setup(page, true);
    await expectSourceColumnRhythm(page, width);
    const row = page.getByRole("row").filter({ has: groups[1] });
    const source = row.getByRole("button", {
      name: `${names[1]} 文本导入`,
      exact: true,
    });
    await expect(source).toBeVisible();
    await expect(source).toHaveAccessibleName(`${names[1]} 文本导入`);
    const text = await source.evaluate((element) => {
      const kind = element.querySelector("small")!;
      const label = kind.parentElement!;
      const cell = element.closest("td")!;
      const range = document.createRange();
      range.setStart(label, 0);
      range.setEndBefore(kind);
      const fragments = [...range.getClientRects()];
      const bounds = cell.getBoundingClientRect();
      return {
        lineCount: new Set(fragments.map((fragment) => Math.round(fragment.y)))
          .size,
        fragmentsFit: fragments.every(
          (fragment) =>
            fragment.x >= bounds.x && fragment.right <= bounds.right,
        ),
        width: cell.clientWidth,
        scrollWidth: cell.scrollWidth,
        textOverflow: getComputedStyle(label).textOverflow,
      };
    });
    expect(text.lineCount).toBeGreaterThan(1);
    expect(text.fragmentsFit).toBe(true);
    expect(text.scrollWidth).toBeLessThanOrEqual(text.width + 1);
    expect(text.textOverflow).not.toBe("ellipsis");
    await expect(row.getByText("有更新", { exact: true })).toBeVisible();
    const buttons = await groups[1].getByRole("button").all();
    expect(buttons).toHaveLength(3);
    const centers = await Promise.all(
      buttons.map(async (button) => {
        const bounds = (await button.boundingBox())!;
        return bounds.y + bounds.height / 2;
      }),
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await info.attach(`source-column-rhythm-${width}`, {
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
  const buttons = groups[1].getByRole("button");
  for (const [index, group] of groups.entries()) {
    const row = page.getByRole("row").filter({ has: group });
    await row.getByRole("button").first().focus();
    // Start at the left edge, so native keyboard focus must reveal the actions
    // and their entire focus rings rather than inheriting a favorable scroll.
    await viewport.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollLeft))
      .toBe(0);
    const rowButtons = group.getByRole("button");
    await expect(rowButtons).toHaveCount(index === 0 ? 1 : 3);
    const identity = group.getByText(names[index], { exact: true });
    for (const button of await rowButtons.all()) {
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await contained(button, viewport);
      await focusRingContained(button, viewport);
      await expect(identity).toBeVisible();
      await contained(identity, viewport);
    }
  }
  const menuTrigger = buttons.last();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: `刷新来源 ${names[1]}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: `编辑来源 ${names[1]}`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
  await contained(menuTrigger, viewport);
  await focusRingContained(menuTrigger, viewport);
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

test("source target identity does not keep overflow stuck after repeated narrow-to-wide resizing", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  const resizeErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (/ResizeObserver/i.test(message.text()))
      resizeErrors.push(message.text());
  });
  await page.addInitScript(() => {
    Object.assign(window, { __tableResizeErrors: [] as string[] });
    window.addEventListener("error", (event) => {
      if (/ResizeObserver/i.test(event.message))
        (
          window as unknown as { __tableResizeErrors: string[] }
        ).__tableResizeErrors.push(event.message);
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { names, groups, unexpected } = await setup(page, true);
  const viewport = page.locator('[data-slot="table-container"]').first();
  const tableRoot = viewport.locator(
    "xpath=ancestor::*[contains(@class, 'data-table')][1]",
  );
  const identity = groups[1].getByText(names[1], { exact: true });
  const action = groups[1].getByRole("button", {
    name: `更多操作 ${names[1]}`,
    exact: true,
  });
  // Establish real keyboard-visible focus once. Re-focusing on each resize
  // would hide regressions where a still-focused offscreen action is stranded.
  const row = page.getByRole("row").filter({ has: groups[1] });
  await row.getByRole("button").first().focus();
  const actionCount = await groups[1].getByRole("button").count();
  for (let index = 0; index < actionCount; index++)
    await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  // Resizing must neither remount nor replace the focused action owner.
  const originalAction = await action.elementHandle();
  const dimensions: Array<{
    width: number;
    clientWidth: number;
    scrollWidth: number;
  }> = [];
  for (const width of [1440, 390, 2048, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(tableRoot).toHaveAttribute(
      "data-overflow",
      width === 390 ? "true" : "false",
    );
    await expect
      .poll(() =>
        viewport.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1,
        ),
      )
      .toBe(width === 390);
    const settledOverflow = await viewport.evaluate(
      (element) =>
        new Promise<boolean[]>((resolve) => {
          const samples: boolean[] = [];
          const sample = () => {
            samples.push(element.scrollWidth > element.clientWidth + 1);
            if (samples.length === 4) resolve(samples);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    expect(settledOverflow).toEqual(Array(4).fill(width === 390));
    await info.attach(`source-list-resize-${dimensions.length}-${width}`, {
      body: JSON.stringify({
        width,
        viewport: await viewport.boundingBox(),
        identity: await identity.boundingBox(),
        action: await action.boundingBox(),
        scrollLeft: await viewport.evaluate((element) => element.scrollLeft),
        keyboardFocus: await action.evaluate((element) =>
          element.matches(":focus-visible"),
        ),
      }),
      contentType: "application/json",
    });
    await expect(action).toBeFocused();
    if (width === 390) {
      await expect(identity).toBeVisible();
      await expect(identity).toHaveText(longSourceName);
      await contained(identity, viewport);
      await contained(action, viewport);
      await focusRingContained(action, viewport);
      for (const group of groups) {
        const label = group.locator(".table-row-action-target");
        await expect(label).toBeVisible();
        const bounds = (await label.boundingBox())!;
        // Single-icon rows need a readable target measure too, not a 44px strip.
        expect(bounds.width).toBeGreaterThanOrEqual(160);
        await contained(label, viewport);
      }
      // Inline-size containment must preserve natural block layout, not crop or
      // ellipsize the identity to achieve the desired table width.
      const textBounds = await identity.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const bounds = element.getBoundingClientRect();
        return {
          width: element.clientWidth,
          height: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          fragmentsFit: [...range.getClientRects()].every(
            (fragment) =>
              fragment.x >= bounds.x - 1 &&
              fragment.right <= bounds.right + 1 &&
              fragment.y >= bounds.y - 1 &&
              fragment.bottom <= bounds.bottom + 1,
          ),
          textOverflow: getComputedStyle(element).textOverflow,
        };
      });
      expect(textBounds.width).toBeGreaterThan(0);
      expect(textBounds.height).toBeGreaterThan(0);
      expect(textBounds.scrollWidth).toBeLessThanOrEqual(textBounds.width + 1);
      expect(textBounds.scrollHeight).toBeLessThanOrEqual(
        textBounds.height + 1,
      );
      expect(textBounds.fragmentsFit).toBe(true);
      expect(textBounds.textOverflow).not.toBe("ellipsis");
    } else {
      await expect(identity).not.toBeVisible();
      await expect(page.getByText("向左右滚动查看完整表格")).toHaveCount(0);
      await expect(viewport).not.toHaveAttribute("tabindex", "0");
    }
    expect(
      await action.evaluate(
        (element, original) => element === original,
        originalAction,
      ),
    ).toBe(true);
    dimensions.push({
      width,
      ...(await viewport.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await expect(action).toBeFocused();
  await info.attach("source-list-repeated-resize", {
    body: JSON.stringify(dimensions),
    contentType: "application/json",
  });
  expect(pageErrors).toEqual([]);
  expect(resizeErrors).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __tableResizeErrors: string[] })
          .__tableResizeErrors,
    ),
  ).toEqual([]);
  expect(unexpected).toEqual([]);
});
