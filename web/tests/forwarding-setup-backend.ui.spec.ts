import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { read, signIn } from "./uiux-inventory-helper";
import { navigateWorkspace } from "./ui-session";
import { settledTask } from "./ui-settled-task";

// Every object under test is created through the built UI against a fresh normal
// CLI database. Public GETs establish persistence; no API setup writes, response
// mocks, enrollment, principals, runtime process or configuration application.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

const names = {
  host: "首次配置服务器",
  core: "首次配置受管核心",
  listener: "首次配置用户入口",
  path: "首次配置转发路径",
  line: "首次配置公开线路",
};
const listenerPort = 23456;
const publicPort = 23457;
const missingPrincipals = "MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required";
const publicTLSRefusal = "public VLESS entries require TLS; unencrypted entries are restricted to explicit private or loopback IPs";

function responseFor(page: Page, path: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api${path}` &&
    response.request().method() === "POST",
  );
}

async function choose(page: Page, control: Locator, query: string) {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await expect(search).toBeFocused();
  await search.fill(query);
  // A unique visible choice is required before Enter, not an assumed first row.
  const option = page.getByRole("option");
  await expect(option).toHaveCount(1);
  await expect(option).toContainText(query);
  await search.press("Enter");
  await expect(control).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, name: string, surface: Locator) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 &&
      element.scrollWidth <= element.clientWidth + 1;
  }), "Foreground task has no horizontal overflow").toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`first managed line joins real server setup to checked saved identity without application at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    for (const path of ["/hosts", "/core-instances", "/managed-endpoints", "/server-deployments", "/published-routes", "/admin/fleet-batches"])
      expect(await read(page.request, path), `Fresh ${path} inventory`).toEqual([]);

    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
        mutations.push(`${request.method()} ${path}`);
    });
    await page.goto("/#servers");
    await expect(page.getByRole("heading", { name: "服务器", exact: true })).toBeVisible();
    await expect(page.getByText("暂无服务器", { exact: true })).toBeVisible();
    await page.locator(".page-heading").getByRole("button", { name: "添加服务器", exact: true }).click();
    const hostEditor = page.getByRole("dialog", { name: "添加服务器", exact: true });
    await hostEditor.getByLabel("服务器名称", { exact: true }).fill(names.host);
    await hostEditor.getByLabel("服务器连接地址", { exact: true }).fill("127.0.0.1");
    await expect(hostEditor.getByText("将服务器信息登记到控制平面；服务器连接与配置需另行操作。", { exact: true })).toBeVisible();
    const hostSaved = responseFor(page, "/hosts");
    await hostEditor.getByRole("button", { name: "保存", exact: true }).click();
    expect((await hostSaved).status()).toBe(200);
    await expect(hostEditor).not.toBeVisible();
    const hosts = await read(page.request, "/hosts");
    expect(hosts).toHaveLength(1);
    const host = hosts[0];
    expect(host).toMatchObject({ name: names.host, address: "127.0.0.1" });
    expect(host.id).toEqual(expect.any(String));

    // Continue from the saved server, rather than finding it in another tab.
    const hostDetail = page.getByRole("dialog", { name: names.host, exact: true });
    await expect(hostDetail.getByText("先添加核心，再配置监听端点", { exact: true })).toBeVisible();
    await capture(page, info, `setup-host-continuation-${width}`, hostDetail);
    await hostDetail.getByRole("button", { name: "添加核心", exact: true }).click();
    const coreEditor = page.getByRole("dialog", { name: "添加核心实例", exact: true });
    await expect(hostDetail).not.toBeVisible();
    await expect(coreEditor.getByLabel("所属服务器", { exact: true })).toHaveText(names.host);
    await coreEditor.getByLabel("实例名称", { exact: true }).fill(names.core);
    await choose(page, coreEditor.getByLabel("核心家族", { exact: true }), "受管 Xray");
    await expect(coreEditor.getByLabel("核心版本", { exact: true })).toHaveText("26.3.27-rw1");
    const coreSaved = responseFor(page, "/core-instances");
    await coreEditor.getByRole("button", { name: "保存", exact: true }).click();
    expect((await coreSaved).status()).toBe(200);
    await expect(coreEditor).not.toBeVisible();
    const cores = await read(page.request, "/core-instances");
    expect(cores).toHaveLength(1);
    const core = cores[0];
    expect(core).toMatchObject({ name: names.core, hostId: host.id, adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" });
    await expect(hostDetail).toBeVisible();
    await hostDetail.getByRole("button", { name: `为 ${names.core} 添加监听端点`, exact: true }).click();

    const listenerEditor = page.getByRole("dialog", { name: "添加监听端点", exact: true });
    await expect(hostDetail).not.toBeVisible();
    await expect(listenerEditor.getByLabel("所属服务器", { exact: true })).toHaveText(names.host);
    await expect(listenerEditor.getByLabel("所属核心", { exact: true })).toHaveText(names.core);
    await expect(listenerEditor.getByLabel("协议", { exact: true })).toHaveText("VLESS");
    await expect(listenerEditor.getByLabel("用户 UUID", { exact: true })).toHaveCount(0);
    await expect(listenerEditor.getByLabel("用户名", { exact: true })).toHaveCount(0);
    await expect(listenerEditor.getByLabel("监听 IP", { exact: true })).toHaveValue("0.0.0.0");
    const port = listenerEditor.getByLabel("端口", { exact: true });
    await expect(port).toHaveValue("");
    await listenerEditor.getByLabel("端点名称", { exact: true }).fill(names.listener);
    await listenerEditor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(listenerEditor.getByText("填写端口", { exact: true })).toBeVisible();
    expect(await read(page.request, "/managed-endpoints")).toEqual([]);
    expect(mutations).toEqual(["POST /api/hosts", "POST /api/core-instances"]);
    await expect(listenerEditor.getByLabel("端点名称", { exact: true })).toHaveValue(names.listener);
    await port.scrollIntoViewIfNeeded();
    await capture(page, info, `setup-listener-explicit-port-${width}`, listenerEditor);

    await listenerEditor.getByRole("button", { name: "取消", exact: true }).click();
    const discard = page.getByRole("alertdialog", { name: "放弃尚未保存的配置修改？", exact: true });
    const keepEditing = discard.getByRole("button", { name: "继续编辑", exact: true });
    await expect(keepEditing).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(discard).not.toBeVisible();
    await expect(listenerEditor.getByLabel("端点名称", { exact: true })).toHaveValue(names.listener);
    await expect(port).toHaveValue("");
    await port.fill(String(listenerPort));
    const listenerSaved = responseFor(page, "/managed-endpoints");
    await listenerEditor.getByRole("button", { name: "保存", exact: true }).click();
    expect((await listenerSaved).status()).toBe(200);
    await expect(listenerEditor).not.toBeVisible();
    const listeners = await read(page.request, "/managed-endpoints");
    expect(listeners).toHaveLength(1);
    const listener = listeners[0];
    expect(listener).toMatchObject({ name: names.listener, instanceId: core.id, authentication: "principals", connection: { protocol: "vless", host: "0.0.0.0", port: listenerPort } });
    // Ordinary inventory deliberately omits UUIDs. Use the existing explicit
    // administrator read, not that redacted summary, to prove none was stored.
    const completeListener = await read(page.request, `/managed-endpoints/${listener.id}/reveal`);
    expect(Boolean(completeListener.connection.uuid), "No shared UUID was invented").toBe(false);
    expect(Boolean(completeListener.connection.password), "No shared password was invented").toBe(false);
    expect(completeListener.connection.tls?.enabled).not.toBe(true);
    await expect(hostDetail).toBeVisible();
    await hostDetail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(hostDetail).not.toBeVisible();

    await navigateWorkspace(page, "转发路径");
    await page.locator(".page-heading").getByRole("button", { name: "新建转发路径", exact: true }).click();
    const pathEditor = page.getByRole("dialog", { name: "新建转发路径", exact: true });
    await pathEditor.getByLabel("转发路径名称", { exact: true }).fill(names.path);
    await choose(page, pathEditor.getByRole("combobox", { name: "入口服务器", exact: true }), names.host);
    await choose(page, pathEditor.getByRole("combobox", { name: "入口端点", exact: true }), names.listener);
    const selectedListener = pathEditor.getByRole("combobox", { name: "第 1 跳端点", exact: true });
    await expect(selectedListener).toContainText(names.listener);
    await pathEditor.getByRole("tab", { name: "图形编辑", exact: true }).click();
    await pathEditor.getByRole("tab", { name: "顺序编辑", exact: true }).click();
    await expect(selectedListener).toContainText(names.listener);
    await expect(pathEditor.getByLabel("转发路径名称", { exact: true })).toHaveValue(names.path);
    const pathSaved = responseFor(page, "/server-deployments");
    await pathEditor.getByRole("button", { name: "保存草稿", exact: true }).click();
    expect((await pathSaved).status()).toBe(200);
    await expect(pathEditor).not.toBeVisible();
    const paths = await read(page.request, "/server-deployments");
    expect(paths).toHaveLength(1);
    const deployment = paths[0];
    expect(deployment).toMatchObject({ name: names.path, status: "draft", diagnostics: [missingPrincipals] });
    expect(deployment.ir.programs).toHaveLength(1);
    expect(deployment.ir.programs[0]).toMatchObject({ instance: { id: core.id, hostId: host.id }, listener: { id: listener.id, instanceId: core.id, authentication: "principals", connection: { protocol: "vless", host: "0.0.0.0", port: listenerPort } } });
    expect(deployment.ir.programs[0].principals ?? []).toEqual([]);

    // Save is real even though this managed path cannot yet be applied. Capture
    // current missing-principals guidance for review; do not manufacture users
    // or weaken the renderer just to turn the first-use state into success.
    const pathDetail = page.getByRole("dialog", { name: names.path, exact: true });
    await expect(pathDetail.getByText("草稿需要调整", { exact: true })).toBeVisible();
    await expect(pathDetail.getByText(missingPrincipals, { exact: true })).toBeVisible();
    await pathDetail.getByText("草稿需要调整", { exact: true }).scrollIntoViewIfNeeded();
    await capture(page, info, `setup-path-awaiting-principals-${width}`, pathDetail);
    await pathDetail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(pathDetail).not.toBeVisible();

    await navigateWorkspace(page, "线路");
    await page.locator(".page-heading").getByRole("button", { name: "配置公开线路", exact: true }).click();
    const lineEditor = page.getByRole("dialog", { name: "配置公开线路", exact: true });
    await lineEditor.getByLabel("线路名称", { exact: true }).fill(names.line);
    await choose(page, lineEditor.getByLabel("服务器转发路径", { exact: true }), names.path);
    await expect(lineEditor.getByLabel("公开线路转发路径", { exact: true })).toHaveText(names.listener);
    const publicHost = lineEditor.getByLabel("对外域名或 IP", { exact: true });
    const publicPortField = lineEditor.getByLabel("对外端口", { exact: true });
    await expect(publicHost).toHaveValue("127.0.0.1");
    await expect(publicPortField).toHaveValue(String(listenerPort));
    const inspect = lineEditor.getByRole("button", { name: "检查公开线路", exact: true });
    const saveLine = lineEditor.getByRole("button", { name: "保存公开线路", exact: true });
    // No TLS exists. A public hostname must genuinely fail the current backend
    // rule. This reserved hostname is metadata only; no DNS/network probe runs.
    await publicHost.fill("public-entry.example.test");
    const refused = responseFor(page, "/published-routes/preview");
    await inspect.click();
    expect((await refused).status()).toBe(422);
    await expect(lineEditor.getByText(publicTLSRefusal, { exact: true })).toBeVisible();
    await expect(saveLine).toHaveCount(0);
    await expect(lineEditor.getByLabel("线路名称", { exact: true })).toHaveValue(names.line);
    await expect(lineEditor.getByLabel("服务器转发路径", { exact: true })).toHaveText(names.path);
    await expect(publicHost).toHaveValue("public-entry.example.test");
    await expect(publicPortField).toHaveValue(String(listenerPort));
    expect(await read(page.request, "/published-routes")).toEqual([]);
    await lineEditor.getByText(publicTLSRefusal, { exact: true }).scrollIntoViewIfNeeded();
    await capture(page, info, `setup-public-tls-refusal-${width}`, lineEditor);

    await publicHost.fill("127.0.0.1");
    const checked = responseFor(page, "/published-routes/preview");
    await inspect.click();
    expect((await checked).status()).toBe(200);
    await expect(lineEditor.getByText("路径检查完成", { exact: true })).toBeVisible();
    await expect(saveLine).toBeEnabled();
    expect(await read(page.request, "/published-routes")).toEqual([]);
    await publicPortField.fill(String(publicPort));
    await expect(saveLine).toHaveCount(0);
    await expect(lineEditor.getByText("内容已变更，请重新检查线路。", { exact: true })).toBeVisible();
    await expect(lineEditor.getByText("路径检查完成", { exact: true })).toHaveCount(0);
    expect(await read(page.request, "/published-routes")).toEqual([]);
    const rechecked = responseFor(page, "/published-routes/preview");
    await inspect.click();
    expect((await rechecked).status()).toBe(200);
    await expect(saveLine).toBeEnabled();
    const consequence = lineEditor.getByText("可以保存线路身份；分配用户和节点应用仍是后续独立步骤。", { exact: true });
    await saveLine.scrollIntoViewIfNeeded();
    await expect(consequence).toBeInViewport({ ratio: 1 });
    await expect(saveLine).toBeInViewport({ ratio: 1 });
    await capture(page, info, `setup-line-rechecked-decision-${width}`, lineEditor);
    const lineSaved = responseFor(page, "/published-routes");
    await saveLine.click();
    expect((await lineSaved).status()).toBe(200);
    await expect(lineEditor).not.toBeVisible();
    const lines = await read(page.request, "/published-routes");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({ name: names.line, deploymentId: deployment.id, endpointIds: [listener.id], publicHost: "127.0.0.1", publicPort, status: "draft", effective: null });
    await expect(page.getByRole("dialog", { name: names.line, exact: true })).toBeVisible();
    await page.reload();
    const lineDetail = page.getByRole("dialog", { name: names.line, exact: true });
    await expect(lineDetail.getByText("草稿已保存，尚未确认应用", { exact: true })).toBeVisible();
    await expect(lineDetail.getByLabel("已保存路径", { exact: true })).toContainText(names.listener);
    await expect(lineDetail).toContainText(`127.0.0.1:${publicPort}`);
    await expect(lineDetail.getByRole("link", { name: "检查并应用转发路径", exact: true })).toHaveAttribute("href", `#routes?deployment=${encodeURIComponent(deployment.id)}&line=${encodeURIComponent(line.id)}`);
    await expect(lineDetail.getByText("已确认生效", { exact: true })).toHaveCount(0);
    await capture(page, info, `setup-line-saved-not-applied-${width}`, lineDetail);

    const state = await read(page.request, `/agent/instances/${core.id}/state`);
    expect(state.phase).toBe("unregistered");
    expect(state.desired).toBeUndefined();
    expect(state.state?.observed).toBeUndefined();
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(await read(page.request, "/server-deployments")).toEqual(paths);
    const reloaded = await read(page.request, "/published-routes");
    expect(reloaded).toEqual(lines);
    // Exact mutation inventory also rules out hidden validation/application,
    // enrollment, grants, principal provisioning and duplicate blank-port save.
    expect(mutations).toEqual([
      "POST /api/hosts", "POST /api/core-instances", "POST /api/managed-endpoints",
      "POST /api/server-deployments", "POST /api/published-routes/preview",
      "POST /api/published-routes/preview", "POST /api/published-routes/preview",
      "POST /api/published-routes",
    ]);
    await info.attach("forwarding-setup-result", {
      contentType: "application/json",
      body: JSON.stringify({
        width, ids: { host: host.id, core: core.id, listener: listener.id, path: deployment.id, line: line.id },
        mutations, listenerPort, publicPort, publicHost: line.publicHost,
        pathStatus: deployment.status, pathDiagnostics: deployment.diagnostics,
        lineStatus: line.status, instancePhase: state.phase,
        scope: "Real isolated UI creation, validation refusal, retained input, recheck and saved identity. No enrollment, user entry, configuration application, native process or traffic. Captures require independent pixel review.",
      }),
    });
  });
}
