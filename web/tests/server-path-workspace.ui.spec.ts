import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { headers, read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Synthetic inventory through the real HTTP API, then actual path editing and
// persistence. No response mocks, live servers, enrollment or runtime application.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

async function choose(page: Page, control: Locator, query: string) {
  await control.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await expect(search).toBeFocused();
  await search.fill(query);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(query);
  await search.press("Enter");
  await expect(page.getByRole("listbox", { includeHidden: true })).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, editor: Locator, name: string, target?: Locator) {
  if (target) await target.scrollIntoViewIfNeeded();
  await settledTask(editor);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await editor.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left >= -1 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  if (target) {
    await expect(target).toBeInViewport({ ratio: 1 });
    expect(await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && element.contains(hit);
    }), "The decision or action is not hidden by the footer").toBe(true);
  }
  const path = info.outputPath(`${name}-${page.viewportSize()!.width}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`entry, intermediate and final exit remain explicit through editing at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const names = { entry: "入口服务器", middle: "中转服务器", exit: "出口服务器" };
    const endpoints = { entry: "入口监听", middle: "中转监听", exit: "出口监听" };
    const csrf = await headers(page.request);
    for (const [index, id] of ["entry", "middle", "exit"].entries()) {
      for (const [path, data] of [
        ["/hosts", { id, name: names[id as keyof typeof names], address: "127.0.0.1" }],
        ["/core-instances", { id: `${id}-core`, hostId: id, name: `${id} core`, adapterId: "routeweaver/xray", version: "26.10.31" }],
        ["/managed-endpoints", {
          id, instanceId: `${id}-core`, name: endpoints[id as keyof typeof endpoints],
          connection: { protocol: "socks", host: "127.0.0.1", port: 23080 + index, username: "fixture", password: "synthetic-only" },
        }],
      ] as const) {
        const response = await page.request.post(`/api${path}`, { headers: csrf, data });
        expect(response.status(), `Create synthetic ${path}`).toBe(200);
      }
    }
    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) mutations.push(`${request.method()} ${path}`);
    });
    await page.goto("/#routes");
    await page.locator(".page-heading").getByRole("button", { name: "新建转发路径", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新建转发路径", exact: true });
    for (const name of ["入口", "中转", "最终出口"])
      await expect(editor.getByRole("region", { name, exact: true })).toBeVisible();
    await expect(editor.getByText("选择入口后，默认从入口服务器直接访问目标。", { exact: true })).toBeVisible();
    await capture(page, info, editor, "path-empty-roles");

    await editor.getByLabel("转发路径名称", { exact: true }).fill("入口经中转到出口");
    await choose(page, editor.getByRole("combobox", { name: "入口服务器", exact: true }), names.entry);
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await choose(page, editor.getByRole("combobox", { name: "入口端点", exact: true }), endpoints.entry);
    const first = editor.getByRole("combobox", { name: "第 1 跳端点", exact: true });
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const exit = editor.getByRole("region", { name: "最终出口", exact: true });
    await expect(exit.getByText("从入口服务器直接访问目标", { exact: true })).toBeVisible();
    await capture(page, info, editor, "path-single-direct-exit", exit.getByText("从入口服务器直接访问目标", { exact: true }));

    await choose(page, editor.getByRole("combobox", { name: "下一跳服务器", exact: true }), names.exit);
    await choose(page, editor.getByRole("combobox", { name: "下一跳端点", exact: true }), endpoints.exit);
    await expect(exit.getByRole("combobox", { name: "第 2 跳端点", exact: true })).toBeFocused();
    const add = editor.getByRole("button", { name: "添加中转", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByRole("combobox", { name: "中转服务器", exact: true })).toBeFocused();
    await choose(page, editor.getByRole("combobox", { name: "中转服务器", exact: true }), names.middle);
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "取消添加中转", exact: true }).click();
    await expect(add).toBeFocused();
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeEnabled();
    await page.keyboard.press("Enter");
    await choose(page, editor.getByRole("combobox", { name: "中转服务器", exact: true }), names.middle);
    await choose(page, editor.getByRole("combobox", { name: "中转端点", exact: true }), endpoints.middle);
    await expect(editor.getByRole("combobox", { name: "第 2 跳端点", exact: true })).toBeFocused();
    await expect(exit.getByRole("combobox", { name: "第 3 跳端点", exact: true })).toContainText(endpoints.exit);
    const summary = editor.getByRole("region", { name: "路径摘要", exact: true });
    await expect(summary).toContainText("入口监听 → 中转监听 → 出口监听 → 目标");
    await capture(page, info, editor, "path-intermediate-preserves-exit", summary);

    // Inspection is optional; opening or closing it does not alter the path.
    const details = editor.getByRole("button", { name: "监听快照与转发详情", exact: true });
    await expect(editor.getByRole("button", { name: "检查监听更新 出口监听", exact: true })).toHaveCount(0);
    await details.click();
    await expect(editor.getByRole("button", { name: "检查监听更新 出口监听", exact: true })).toBeVisible();
    await details.click();
    await editor.getByRole("tab", { name: "图形编辑", exact: true }).click();
    await expect(summary).toContainText("入口监听 → 中转监听 → 出口监听 → 目标");
    await editor.getByRole("tab", { name: "顺序编辑", exact: true }).click();
    await expect(exit.getByRole("combobox", { name: "第 3 跳端点", exact: true })).toContainText(endpoints.exit);

    const consequence = editor.getByText("仅保存草稿，检查与应用需另行操作。", { exact: true });
    await capture(page, info, editor, "path-save-consequence", consequence);
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/server-deployments" && response.request().method() === "POST");
    await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(editor).toBeHidden();
    const deployments = await read(page.request, "/server-deployments");
    expect(deployments).toHaveLength(1);
    expect(deployments[0].ir.programs.map((program: { listener: { id: string } }) => program.listener.id)).toEqual(["entry", "middle", "exit"]);
    expect(deployments[0].ir.programs[0].egress[0]).toMatchObject({ host: "127.0.0.1", port: 23081 });
    expect(deployments[0].ir.programs[1].egress[0]).toMatchObject({ host: "127.0.0.1", port: 23082 });
    expect(deployments[0].ir.programs[2].egress || []).toEqual([]);
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(mutations).toEqual(["POST /api/server-deployments"]);
  });
}
