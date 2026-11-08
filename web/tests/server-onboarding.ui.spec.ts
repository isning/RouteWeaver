import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Normal UI + isolated backend. No enrollment issuance, node process, installer,
// API setup writes, response substitution, or configuration application.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

async function capture(page: Page, info: TestInfo, name: string, surface: Locator) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  }), "Setup task fits the viewport").toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`server registration continues through core setup and listener to paths at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
        mutations.push(`${request.method()} ${path}`);
    });
    await page.goto("/#servers");
    await page.locator(".page-heading").getByRole("button", { name: "添加服务器", exact: true }).click();
    const hostEditor = page.getByRole("dialog", { name: "添加服务器", exact: true });
    await hostEditor.getByLabel("服务器名称", { exact: true }).fill("Setup server");
    await hostEditor.getByLabel("服务器连接地址", { exact: true }).fill("127.0.0.1");
    await expect(hostEditor.getByText("将服务器信息登记到控制平面；服务器连接与配置需另行操作。", { exact: true })).toBeVisible();
    await hostEditor.getByRole("button", { name: "保存", exact: true }).click();
    const host = page.getByRole("dialog", { name: "Setup server", exact: true });
    await expect(host.getByText("服务器信息已登记", { exact: true })).toBeVisible();
    await host.getByRole("button", { name: "添加核心", exact: true }).click();
    const coreEditor = page.getByRole("dialog", { name: "添加核心实例", exact: true });
    await expect(coreEditor.getByLabel("所属服务器", { exact: true })).toHaveText("Setup server");
    await coreEditor.getByLabel("实例名称", { exact: true }).fill("Setup core");
    await expect(coreEditor.getByLabel("核心版本", { exact: true })).toHaveText("1.14.4");
    await coreEditor.getByRole("button", { name: "保存", exact: true }).click();
    const coreOpener = host.getByRole("button", { name: "查看接入与配置", exact: true });
    const core = page.getByRole("dialog", { name: "Setup server的Setup core", exact: true });
    await expect(core.getByText("核心配置已登记", { exact: true })).toBeVisible();
    await expect(core.getByText("尚未接入", { exact: true })).toBeVisible();
    await expect(core.getByRole("heading", { name: "1. Agent 接入与上报", exact: true })).toBeVisible();
    await capture(page, info, `core-registration-${width}`, core);

    // Opening enrollment is not permission to create credentials. Inspect the
    // real scoped decision and cancel without invalidating any credential.
    await core.getByRole("button", { name: "接入 Agent", exact: true }).click();
    const enrollment = page.getByRole("dialog", { name: "接入核心实例", exact: true });
    await expect(enrollment.getByText(/旧凭据会失效/)).toBeVisible();
    await enrollment.getByRole("button", { name: "取消", exact: true }).click();
    await expect(enrollment).not.toBeVisible();
    await settledTask(core);
    await expect(core.getByRole("button", { name: "接入 Agent", exact: true })).toBeFocused();

    const add = core.getByRole("button", { name: "添加监听端点", exact: true });
    await add.click();
    let listener = page.getByRole("dialog", { name: "添加监听端点", exact: true });
    await expect(listener.getByLabel("所属服务器", { exact: true })).toHaveText("Setup server");
    await expect(listener.getByLabel("所属核心", { exact: true })).toHaveText("Setup core");
    await listener.getByLabel("端点名称", { exact: true }).fill("Discarded listener");
    await listener.getByRole("button", { name: "取消", exact: true }).click();
    let confirmation = page.getByRole("alertdialog", { name: "放弃尚未保存的配置修改？", exact: true });
    await expect(confirmation.getByRole("button", { name: "继续编辑", exact: true })).toBeFocused();
    await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(listener.getByLabel("端点名称", { exact: true })).toHaveValue("Discarded listener");
    await listener.getByRole("button", { name: "取消", exact: true }).click();
    confirmation = page.getByRole("alertdialog", { name: "放弃尚未保存的配置修改？", exact: true });
    await confirmation.getByRole("button", { name: "放弃修改", exact: true }).click();
    await settledTask(core);
    await expect(add).toBeFocused();
    expect(await read(page.request, "/managed-endpoints")).toEqual([]);

    await add.click();
    listener = page.getByRole("dialog", { name: "添加监听端点", exact: true });
    await listener.getByLabel("端点名称", { exact: true }).fill("Setup listener");
    await listener.getByLabel("用户名", { exact: true }).fill("fixture");
    await listener.getByLabel("密码", { exact: true }).fill("fixture-password");
    await listener.getByRole("button", { name: "保存", exact: true }).click();
    await expect(listener).not.toBeVisible();
    await expect(core.getByText("Setup listener", { exact: true })).toBeVisible();
    await settledTask(core);
    await expect(add).toBeFocused();
    const listenerRecords = await read(page.request, "/managed-endpoints");
    const cores = await read(page.request, "/core-instances");
    expect(listenerRecords).toHaveLength(1);
    expect(listenerRecords[0]).toMatchObject({ instanceId: cores[0].id, name: "Setup listener", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } });
    await expect(core.getByText("尚未接入", { exact: true })).toBeVisible();
    const paths = core.getByRole("link", { name: "前往转发路径", exact: true });
    await paths.scrollIntoViewIfNeeded();
    await expect(core.getByText("保存监听端点不会修改节点。转发路径需另行检查并确认应用。", { exact: true })).toBeVisible();
    await capture(page, info, `listener-path-continuation-${width}`, core);
    await core.getByRole("button", { name: "关闭", exact: true }).click();
    await settledTask(host);
    await expect(coreOpener).toBeFocused();
    await coreOpener.click();
    await core.getByRole("link", { name: "前往转发路径", exact: true }).click();
    await expect(page.getByRole("heading", { name: "转发路径", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "服务器", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("heading", { name: "转发路径", exact: true })).toBeVisible();
    expect(mutations).toEqual(["POST /api/hosts", "POST /api/core-instances", "POST /api/managed-endpoints"]);
    expect(await read(page.request, "/server-deployments")).toEqual([]);
  });
}
