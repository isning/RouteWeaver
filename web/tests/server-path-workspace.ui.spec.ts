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

async function hopAction(editor: Locator, hop: number, label: string) {
  await editor.getByRole("button", { name: `第 ${hop} 跳更多操作`, exact: true }).click();
  await editor.getByRole("menuitem", { name: label, exact: true }).click();
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
  test(`ordered proxy chain appends, reorders and removes hops at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const names = { entry: "香港服务器", relay: "东京服务器", exit: "洛杉矶服务器", fourth: "新加坡服务器" };
    const endpoints = { entry: "香港监听", relay: "东京监听", exit: "洛杉矶监听", fourth: "新加坡监听" };
    const csrf = await headers(page.request);
    for (const [index, id] of (["entry", "relay", "exit", "fourth"] as const).entries()) {
      for (const [path, data] of [
        ["/hosts", { id, name: names[id], address: "127.0.0.1" }],
        ["/core-instances", { id: `${id}-core`, hostId: id, name: `${id} core`, adapterId: "routeweaver/xray", version: "26.10.31" }],
        ["/managed-endpoints", {
          id, instanceId: `${id}-core`, name: endpoints[id],
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
    const chain = editor.getByRole("list", { name: "代理链", exact: true });
    const summary = editor.getByRole("region", { name: "路径摘要", exact: true });
    const save = editor.getByRole("button", { name: "保存草稿", exact: true });
    await expect(editor.getByRole("list", { name: "代理链", exact: true })).toBeVisible();
    await expect(editor.getByRole("region", { name: "最终出口", exact: true })).toHaveCount(0);
    await expect(summary).toContainText("客户端 → 选择第一跳 → 目标");
    await capture(page, info, editor, "path-empty-chain");

    await editor.getByLabel("转发路径名称", { exact: true }).fill("按顺序转发");
    await choose(page, editor.getByRole("combobox", { name: "第 1 跳服务器", exact: true }), names.entry);
    await expect(save).toBeDisabled();
    await choose(page, editor.getByRole("combobox", { name: "第 1 跳端点", exact: true }), endpoints.entry);
    await expect(editor.getByRole("button", { name: `配置第 1 跳 ${endpoints.entry}`, exact: true })).toBeFocused();
    await expect(summary).toContainText("客户端 → 香港监听 → 目标");
    await capture(page, info, editor, "path-one-hop", chain.getByRole("listitem").last());

    const add = editor.getByRole("button", { name: "添加下一跳", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByRole("combobox", { name: "第 2 跳服务器", exact: true })).toBeFocused();
    await expect(save).toBeDisabled();
    await expect(summary).toContainText("香港监听 → 第 2 跳（待选择） → 目标");
    await capture(page, info, editor, "path-append-pending", chain.getByRole("listitem").last());
    await choose(page, editor.getByRole("combobox", { name: "第 2 跳服务器", exact: true }), names.relay);
    await editor.getByRole("button", { name: "取消添加", exact: true }).click();
    await expect(add).toBeFocused();
    await expect(save).toBeEnabled();
    await expect(summary).toContainText("香港监听 → 目标");

    for (const [index, id] of (["relay", "exit", "fourth"] as const).entries()) {
      await add.focus();
      await page.keyboard.press("Enter");
      await expect(save).toBeDisabled();
      const hop = index + 2;
      await choose(page, editor.getByRole("combobox", { name: `第 ${hop} 跳服务器`, exact: true }), names[id]);
      await choose(page, editor.getByRole("combobox", { name: `第 ${hop} 跳端点`, exact: true }), endpoints[id]);
      await expect(editor.getByRole("button", { name: `配置第 ${hop} 跳 ${endpoints[id]}`, exact: true })).toBeFocused();
      if (hop === 3) {
        await expect(summary).toContainText("香港监听 → 东京监听 → 洛杉矶监听 → 目标");
        await capture(page, info, editor, "path-three-hops", chain.getByRole("listitem").last());
      }
    }
    await expect(summary).toContainText("香港监听 → 东京监听 → 洛杉矶监听 → 新加坡监听 → 目标");
    await capture(page, info, editor, "path-four-hops-summary", chain.getByRole("listitem").last());
    await capture(page, info, editor, "path-fourth-hop-actions", editor.getByRole("button", { name: "第 4 跳更多操作", exact: true }));
    await hopAction(editor, 4, "上移第 4 跳");
    await expect(summary).toContainText("香港监听 → 东京监听 → 新加坡监听 → 洛杉矶监听 → 目标");
    await expect(editor.getByRole("button", { name: `配置第 3 跳 ${endpoints.fourth}`, exact: true })).toBeFocused();
    await capture(page, info, editor, "path-reordered-summary", chain.getByRole("listitem").last());
    await hopAction(editor, 2, "移除第 2 跳");
    await expect(summary).toContainText("香港监听 → 新加坡监听 → 洛杉矶监听 → 目标");
    await expect(editor.getByRole("button", { name: `配置第 2 跳 ${endpoints.fourth}`, exact: true })).toBeFocused();
    await capture(page, info, editor, "path-removed-hop-summary", chain.getByRole("listitem").last());

    // Inspection, graph view and expanding configuration preserve the exact ordered chain.
    const details = editor.getByRole("button", { name: "监听快照与转发详情", exact: true });
    await expect(editor.getByRole("button", { name: "检查监听更新 洛杉矶监听", exact: true })).toHaveCount(0);
    await details.click();
    await expect(editor.getByRole("button", { name: "检查监听更新 洛杉矶监听", exact: true })).toBeVisible();
    await details.click();
    await editor.getByRole("tab", { name: "图形编辑", exact: true }).click();
    await expect(summary).toContainText("香港监听 → 新加坡监听 → 洛杉矶监听 → 目标");
    await editor.getByRole("tab", { name: "顺序编辑", exact: true }).click();
    const configure = editor.getByRole("button", { name: `配置第 3 跳 ${endpoints.exit}`, exact: true });
    await expect(configure).toHaveAttribute("aria-expanded", "false");
    await configure.click();
    await expect(summary).toContainText("香港监听 → 新加坡监听 → 洛杉矶监听 → 目标");
    await expect(editor.getByRole("combobox", { name: "第 3 跳端点", exact: true })).toContainText(endpoints.exit);
    await configure.click();
    await expect(configure).toHaveAttribute("aria-expanded", "false");

    await expect(editor.getByText("仅保存草稿，检查与应用需另行操作。", { exact: true })).toHaveCount(0);
    await capture(page, info, editor, "path-save-draft", save);
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/server-deployments" && response.request().method() === "POST");
    await save.click();
    expect((await saved).status()).toBe(200);
    await expect(editor).toBeHidden();
    const deployments = await read(page.request, "/server-deployments");
    expect(deployments).toHaveLength(1);
    expect(deployments[0].ir.programs.map((program: { listener: { id: string } }) => program.listener.id)).toEqual(["entry", "fourth", "exit"]);
    expect(deployments[0].ir.programs[0].egress[0]).toMatchObject({ host: "127.0.0.1", port: 23083 });
    expect(deployments[0].ir.programs[1].egress[0]).toMatchObject({ host: "127.0.0.1", port: 23082 });
    expect(deployments[0].ir.programs[2].egress || []).toEqual([]);
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(mutations).toEqual(["POST /api/server-deployments"]);
  });
}
