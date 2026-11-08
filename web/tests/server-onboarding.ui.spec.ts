import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Normal UI + isolated backend. No enrollment issuance, node process, installer,
// API setup writes, response substitution, or configuration application.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

async function capture(page: Page, info: TestInfo, name: string, surface: Locator, targets: Locator[] = []) {
  // Save feedback is real transitional UI. Move away so hover does not pause
  // its own dismissal timer, then capture the naturally settled task. Never
  // hide/remove notifications or relax the visibility and hit-test checks.
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]:visible")).toHaveCount(0);
  await settledTask(surface);
  const visibility = [];
  for (const target of targets) {
    await expect(target).toBeInViewport({ ratio: 1 });
    const evidence = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const pointerlessDisabled = element.matches(":disabled") && getComputedStyle(element).pointerEvents === "none";
      const points = [[0.5, 0.5], [0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82]].map(([x, y]) => {
        const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
        // The disabled endpoint picker intentionally ignores pointer events.
        // Only its immediate layout parent may stand in for that hit, never an
        // overlay, footer or unrelated element covering the control.
        return !!hit && (element.contains(hit) || (pointerlessDisabled && hit === element.parentElement));
      });
      return {
        label: element.getAttribute("aria-label") || element.textContent,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        fullyInside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        unobscured: points.every(Boolean),
      };
    });
    visibility.push(evidence);
    expect(evidence.fullyInside, "Captured action and controls fit fully in the viewport").toBe(true);
    expect(evidence.unobscured, "Captured action and controls are not covered by other content").toBe(true);
  }
  if (visibility.length) await info.attach(`${name}-visibility`, {
    body: JSON.stringify(visibility), contentType: "application/json",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  }), "Server workspace or editing task fits the viewport").toBe(true);
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
    const host = page.getByRole("region", { name: "Setup server", exact: true });
    await expect(host.getByText("服务器信息已登记", { exact: true })).toBeVisible();
    await expect(host.getByRole("heading", { level: 1, name: "Setup server", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const registeredHosts = await read(page.request, "/hosts");
    await expect(page).toHaveURL(new RegExp(`#servers\\?host=${registeredHosts[0].id}$`));
    await capture(page, info, `server-workspace-overview-${width}`, host);
    await host.getByRole("button", { name: "返回服务器清单", exact: true }).click();
    const enterServer = page.getByRole("button", { name: "进入服务器 Setup server", exact: true });
    await expect(enterServer).toBeVisible();
    await capture(page, info, `server-explicit-entry-${width}`, page.locator(".server-grid"), [enterServer]);
    await enterServer.click();
    const setup = host.getByRole("list", { name: "服务器配置步骤" });
    await setup.getByRole("button", { name: "开始配置核心", exact: true }).click();
    const coreEditor = page.getByRole("dialog", { name: "添加核心实例", exact: true });
    await expect(coreEditor.getByLabel("所属服务器", { exact: true })).toHaveText("Setup server");
    await coreEditor.getByLabel("实例名称", { exact: true }).fill("Setup core");
    await expect(coreEditor.getByLabel("核心版本", { exact: true })).toHaveText("1.14.4");
    await coreEditor.getByRole("button", { name: "保存", exact: true }).click();
    const coreOpener = host.getByRole("button", { name: "查看接入与配置", exact: true });
    const core = page.getByRole("region", { name: "Setup server的Setup core", exact: true });
    await expect(core.getByText("核心配置已登记", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(core.getByText("尚未接入", { exact: true })).toBeVisible();
    await expect(core.getByRole("heading", { name: "1. Agent 接入与上报", exact: true })).toBeVisible();
    await capture(page, info, `core-registration-${width}`, core);
    const registeredCores = await read(page.request, "/core-instances");
    const coreURL = `#servers?host=${registeredHosts[0].id}&instance=${registeredCores[0].id}`;
    expect(new URL(page.url()).hash).toBe(coreURL);
    await host.getByRole("tab", { name: "配置记录", exact: true }).click();
    await expect(host.getByText("暂无关联的转发配置", { exact: true })).toBeVisible();
    await expect(host.getByRole("tab", { name: "配置记录", exact: true })).toBeFocused();
    await capture(page, info, `server-workspace-records-${width}`, host);
    await page.goBack();
    await expect(core).toBeVisible();
    expect(new URL(page.url()).hash).toBe(coreURL);
    await page.goForward();
    await expect(host.getByRole("tab", { name: "配置记录", exact: true })).toHaveAttribute("aria-selected", "true");
    await host.getByRole("tab", { name: "核心与监听", exact: true }).click();
    await expect(core.getByText("尚未接入", { exact: true })).toBeVisible();

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
    const paths = core.getByRole("link", { name: "用 Setup listener 创建转发路径", exact: true });
    await paths.scrollIntoViewIfNeeded();
    await expect(core.getByText("保存监听端点不会修改节点。转发路径需另行检查并确认应用。", { exact: true })).toBeVisible();
    await capture(page, info, `listener-path-continuation-${width}`, core);
    await core.getByRole("button", { name: "返回核心列表", exact: true }).click();
    await settledTask(host);
    await expect(coreOpener).toBeFocused();
    await host.getByRole("tab", { name: "概览", exact: true }).click();
    await setup.getByRole("button", { name: "查看 Agent 接入", exact: true }).click();
    await expect(core.getByText("尚未接入", { exact: true })).toBeVisible();
    await host.getByRole("tab", { name: "概览", exact: true }).click();
    const createPath = setup.getByRole("link", { name: "创建转发路径", exact: true });
    await expect(createPath).toHaveAttribute("href", `#routes?entryEndpoint=${listenerRecords[0].id}&returnHost=${cores[0].hostId}&returnInstance=${cores[0].id}`);
    // Keep the next action in the reading area rather than flush against the
    // mobile viewport edge, where a legitimate save notification may remain.
    await createPath.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await capture(page, info, `server-actionable-setup-${width}`, setup, [createPath]);
    await createPath.click();
    const pathEditor = page.getByRole("dialog", { name: "新建转发路径", exact: true });
    await expect(pathEditor).toBeVisible();
    await expect(pathEditor.getByRole("combobox", { name: "第 1 跳服务器", exact: true })).toHaveText("Setup server");
    await expect(pathEditor.getByRole("combobox", { name: "第 1 跳端点", exact: true })).toContainText("Setup listener");
    await expect(pathEditor.getByRole("region", { name: "路径摘要" })).toContainText("客户端 → Setup listener → 目标");
    await expect(pathEditor.getByRole("combobox", { name: "第 2 跳服务器", exact: true })).toHaveCount(0);
    await pathEditor.getByLabel("转发路径名称", { exact: true }).fill("Unsaved contextual path");
    await capture(page, info, `listener-prefilled-path-${width}`, pathEditor);
    const appendHop = pathEditor.getByRole("button", { name: "添加下一跳", exact: true });
    await appendHop.click();
    const nextServer = pathEditor.getByRole("combobox", { name: "第 2 跳服务器", exact: true });
    const nextEndpoint = pathEditor.getByRole("combobox", { name: "第 2 跳端点", exact: true });
    // The next hop is added only by an explicit choice. No
    // endpoint is selected and the contextual draft remains unsaved.
    await nextEndpoint.scrollIntoViewIfNeeded();
    await expect(nextServer).toHaveText("选择服务器");
    await expect(nextEndpoint).toHaveText("先选择服务器");
    await expect(nextEndpoint).toBeDisabled();
    await expect(pathEditor.getByRole("region", { name: "路径摘要" })).toContainText("第 2 跳（待选择）");
    await expect(pathEditor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await capture(page, info, `listener-prefilled-next-hop-${width}`, pathEditor, [nextServer, nextEndpoint]);
    expect(await read(page.request, "/server-deployments")).toEqual([]);
    const backToServer = pathEditor.getByRole("link", { name: "返回原服务器", exact: true });
    await backToServer.click();
    let discardPath = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await discardPath.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(pathEditor.getByLabel("转发路径名称", { exact: true })).toHaveValue("Unsaved contextual path");
    await backToServer.click();
    discardPath = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await discardPath.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await expect(core).toBeVisible();
    await expect(core.getByText("Setup listener", { exact: true })).toBeVisible();
    await capture(page, info, `contextual-server-return-${width}`, core);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#servers\\?host=${cores[0].hostId}&instance=${cores[0].id}$`));
    // Back reopens a new unsaved draft from the same explicit endpoint identity,
    // not a previously saved/applied route or a replayed write.
    await page.goBack();
    await expect(pathEditor).toBeVisible();
    await expect(pathEditor.getByRole("combobox", { name: "第 1 跳端点", exact: true })).toContainText("Setup listener");
    await page.goForward();
    discardPath = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await discardPath.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await expect(core).toBeVisible();
    expect(mutations).toEqual(["POST /api/hosts", "POST /api/core-instances", "POST /api/managed-endpoints"]);
    expect(await read(page.request, "/server-deployments")).toEqual([]);
  });
}


