import { writeFile } from "node:fs/promises";
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

async function choose(page: Page, control: Locator, query: string, selectedControl = control) {
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
  await expect(selectedControl).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function verifyEntryFocus(page: Page, info: TestInfo, surface: Locator) {
  const snapshot = () => surface.evaluate((editor) => {
    const active = document.activeElement;
    const inside = !!active && editor.contains(active);
    const control = active instanceof HTMLElement &&
      active.matches("button,input:not([type=hidden]),select,textarea,a[href],[role=tab],details>summary");
    const inForm = inside && !!active?.closest("[data-task-overlay-body],[data-task-overlay-footer]");
    const disabled = !!active?.matches(":disabled,[aria-disabled=true]");
    let hidden = !!active?.closest("[hidden],[inert],[aria-hidden=true]");
    for (let ancestor = active; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      hidden ||= style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
    }
    const rect = active?.getBoundingClientRect();
    const visible = !!rect && rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    const tabIndex = active instanceof HTMLElement ? active.tabIndex : -1;
    // No input values, HTML, URL, or outside-task text enters this diagnostic.
    const label = inside && control
      ? active.getAttribute("aria-label") || (active.matches("button,a,details>summary") ? active.textContent : "")
      : "";
    return {
      meaningful: !!active?.isConnected && inForm && control && !disabled && !hidden && visible && tabIndex >= 0,
      tag: active?.tagName ?? null, role: active?.getAttribute("role") ?? null,
      label: (label || "").replace(/\s+/g, " ").trim().slice(0, 160),
      inside, inForm, disabled, hidden, visible, tabIndex,
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  type FocusSnapshot = Awaited<ReturnType<typeof snapshot>>;
  const evidence: { before?: FocusSnapshot; after?: FocusSnapshot; afterAppend?: FocusSnapshot; afterCancel?: FocusSnapshot; atEnd?: FocusSnapshot | null; moved?: boolean } = {};
  try {
    // A hidden exit is not yet a completed focus handoff. Wait for the popup
    // to unmount and real task motion to finish, without refocusing anything.
    await expect(page.getByRole("listbox", { includeHidden: true })).toHaveCount(0);
    await settledTask(surface);
    evidence.before = await snapshot();
    const owner = await page.evaluateHandle(() => document.activeElement);
    try {
      // Record Tab even if initial focus is lost, but never accept that loss
      // just because Tab subsequently recovers a valid field.
      await page.keyboard.press("Tab");
      await settledTask(surface);
      evidence.after = await snapshot();
      evidence.moved = await owner.evaluate((previous) => document.activeElement !== previous);
    } finally {
      await owner.dispose();
    }
    expect(evidence.before, "Selection leaves meaningful focus in the path form").toMatchObject({ meaningful: true });
    expect(evidence.after, "Native Tab continues within the path form").toMatchObject({ meaningful: true });
    expect(evidence.moved, "Native Tab advances to another form control").toBe(true);
    await expect(surface.getByRole("button", { name: "移除第 1 跳", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    const append = surface.getByRole("button", { name: "添加下一跳", exact: true });
    await expect(append).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(surface.getByRole("combobox", { name: "第 2 跳服务器", exact: true })).toBeFocused();
    await settledTask(surface);
    evidence.afterAppend = await snapshot();
    expect(evidence.afterAppend, "Adding the next hop keeps keyboard continuation in the path form").toMatchObject({ meaningful: true });
    await expect(surface.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await page.keyboard.press("Tab");
    await expect(surface.getByRole("button", { name: "取消添加", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(surface.getByRole("combobox", { name: "第 2 跳服务器", exact: true })).toHaveCount(0);
    await expect(append).toBeFocused();
    await settledTask(surface);
    evidence.afterCancel = await snapshot();
    expect(evidence.afterCancel, "Cancelling an unfinished hop returns meaningful focus to the append action").toMatchObject({ meaningful: true });
    await expect(surface.getByRole("combobox", { name: "第 1 跳端点", exact: true })).toContainText(names.listener);
    await expect(surface.getByRole("button", { name: "保存草稿", exact: true })).toBeEnabled();
  } finally {
    evidence.atEnd = await snapshot().catch(() => null);
    const width = page.viewportSize()!.width;
    const path = info.outputPath(`setup-entry-focus-${width}.json`);
    await writeFile(path, JSON.stringify(evidence));
    await info.attach("first-entry-keyboard-focus", { contentType: "application/json", path });
  }
}

async function navigateAfterClose(page: Page, width: number, name: string) {
  // A closing sheet can already be visually hidden while Radix still excludes
  // the workspace from the accessible tree. Wait for this case's known viewport
  // entry before the shared helper decides between desktop and mobile controls.
  const entry = width === 390
    ? page.getByRole("button", { name: "打开导航", exact: true })
    : page.getByRole("navigation", { name: "工作空间导航", exact: true });
  await expect(entry).toBeVisible();
  await navigateWorkspace(page, name);
}

async function capture(page: Page, info: TestInfo, name: string, surface: Locator, targets: Locator[] = []) {
  // Save feedback is real transitional UI. Move away so hover does not pause
  // its own dismissal timer, then capture the naturally settled task. Never
  // hide/remove notifications or relax the visibility and hit-test checks.
  await page.mouse.move(0, 0);
  await expect(page.locator("[data-sonner-toast]:visible")).toHaveCount(0);
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 &&
      element.scrollWidth <= element.clientWidth + 1;
  }), "Foreground task has no horizontal overflow").toBe(true);
  // Sample the actual foreground after normal task motion, never after a
  // notification-expiry wait. Viewport intersection alone cannot detect a toast.
  const visibility = await Promise.all(targets.map((target) => target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const points = [[0.5, 0.5], [0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82]].map(([x, y]) => {
      const point = { x: rect.left + rect.width * x, y: rect.top + rect.height * y };
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        ...point, withinTarget: !!hit && element.contains(hit),
        hit: hit ? { tag: hit.tagName, role: hit.getAttribute("role") } : null,
      };
    });
    // Synthetic fixture labels and geometry only, never input values or HTML.
    return {
      name: (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim(),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight }, points,
      unobscured: rect.width > 0 && rect.height > 0 && points.every((point) => point.withinTarget),
    };
  })));
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
  if (visibility.length) {
    const evidence = info.outputPath(`${name}-occlusion.json`);
    await writeFile(evidence, JSON.stringify({ sampled: "Immediately before screenshot, after task motion", targets: visibility }));
    await info.attach(`${name}-occlusion`, { path: evidence, contentType: "application/json" });
    for (const target of visibility)
      expect(target.unobscured, `${name}: ${target.name} is visible above other content at every sampled point`).toBe(true);
  }
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
    const hostDetail = page.getByRole("region", { name: names.host, exact: true });
    await expect(hostDetail.getByText("先添加核心，再配置监听端点", { exact: true })).toBeVisible();
    const startCore = hostDetail.getByRole("list", { name: "服务器配置步骤" }).getByRole("button", { name: "开始配置核心", exact: true });
    await capture(page, info, `setup-host-continuation-${width}`, hostDetail, [startCore]);
    await startCore.click();
    const coreEditor = page.getByRole("dialog", { name: "添加核心实例", exact: true });
    await expect(page.locator(".server-workspace")).toBeAttached();
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
    const coreSetup = page.getByRole("region", { name: `${names.host}的${names.core}`, exact: true });
    await expect(coreSetup.getByText("核心配置已登记", { exact: true })).toBeVisible();
    await coreSetup.getByRole("button", { name: "返回核心列表", exact: true }).click();
    await expect(hostDetail).toBeVisible();
    await hostDetail.getByRole("button", { name: `为 ${names.core} 添加监听端点`, exact: true }).click();

    const listenerEditor = page.getByRole("dialog", { name: "添加监听端点", exact: true });
    await expect(page.locator(".server-workspace")).toBeAttached();
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
    await capture(page, info, `setup-listener-explicit-port-${width}`, listenerEditor, [
      listenerEditor.getByRole("button", { name: "取消", exact: true }),
      listenerEditor.getByRole("button", { name: "保存", exact: true }),
    ]);

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
    await hostDetail.getByRole("button", { name: "返回服务器清单", exact: true }).click();
    await expect(hostDetail).not.toBeVisible();

    await navigateAfterClose(page, width, "转发路径");
    await page.locator(".page-heading").getByRole("button", { name: "新建转发路径", exact: true }).click();
    const pathEditor = page.getByRole("dialog", { name: "新建转发路径", exact: true });
    await pathEditor.getByLabel("转发路径名称", { exact: true }).fill(names.path);
    await choose(page, pathEditor.getByRole("combobox", { name: "第 1 跳服务器", exact: true }), names.host);
    const entryListener = pathEditor.getByRole("combobox", { name: "第 1 跳端点", exact: true });
    const emptyListener = await entryListener.elementHandle();
    expect(emptyListener, "The empty first-hop picker exists before endpoint reveal").not.toBeNull();
    const selectedListener = pathEditor.getByRole("combobox", { name: "第 1 跳端点", exact: true });
    const revealedSelection = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/managed-endpoints/${encodeURIComponent(listener.id)}/reveal`,
    );
    // Only this choice replaces its trigger: the empty first hop becomes an
    // exact selected hop after the real endpoint reveal. Its label stays stable.
    await choose(page, entryListener, names.listener, selectedListener);
    await expect(pathEditor.getByRole("combobox", { name: "第 1 跳服务器", exact: true })).toHaveText(names.host);
    await expect(selectedListener).toHaveText(`${names.listener} vless:${listenerPort} managed-xray`);
    expect(await emptyListener!.evaluate((element) => element.isConnected), "The empty picker is replaced, not reused for a different selection").toBe(false);
    await emptyListener!.dispose();
    await expect(selectedListener).toHaveCount(1);
    await expect(pathEditor.getByRole("combobox", { name: "第 2 跳服务器", exact: true })).toHaveCount(0);
    const selectedResponse = await revealedSelection;
    expect(selectedResponse.status()).toBe(200);
    expect(await selectedResponse.json()).toMatchObject({ id: listener.id, instanceId: core.id, name: names.listener });
    await verifyEntryFocus(page, info, pathEditor);
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

    // Saving is real while application remains blocked. Recovery is read-only:
    // inspect the matching line and its user authorization/entry state, without
    // manufacturing users or weakening the renderer to manufacture success.
    const pathDetail = page.getByRole("dialog", { name: names.path, exact: true });
    await expect(pathDetail.getByText("转发路径草稿已保存", { exact: true })).toBeVisible();
    expect(await page.getByText("转发路径草稿已保存", { exact: true }).count()).toBe(1);
    const entryGap = pathDetail.getByText("草稿缺少可用用户入口", { exact: true });
    const blockedDraft = pathDetail.getByText("草稿已保存，当前不能应用。", { exact: true });
    await expect(entryGap).toBeVisible();
    await expect(blockedDraft).toBeVisible();
    await expect(pathDetail.getByText(`在线路页选择使用「${names.path}」的公开线路；若还没有，先配置公开线路。`, { exact: true })).toBeVisible();
    await expect(pathDetail.getByText("在线路详情中选择用户，核对「用户授权」和「独立入口与运行确认」。按需准备入口后，返回重新检查。", { exact: true })).toBeVisible();
    await expect(pathDetail.getByRole("button", { name: "编辑并修复", exact: true })).toHaveCount(0);
    await expect(pathDetail.getByRole("button", { name: "确认并应用", exact: true })).toHaveCount(0);
    const rawDiagnostic = pathDetail.getByText(missingPrincipals, { exact: true });
    const technicalDetails = pathDetail.getByRole("button", { name: "技术详情", exact: true });
    await expect(rawDiagnostic).toHaveCount(0);
    await technicalDetails.click();
    await expect(rawDiagnostic).toBeVisible();
    await technicalDetails.click();
    await expect(rawDiagnostic).toHaveCount(0);
    const continueToLines = pathDetail.getByRole("link", { name: "前往线路", exact: true });
    await expect(continueToLines).toHaveAttribute("href", "#published-routes");
    await continueToLines.scrollIntoViewIfNeeded();
    await expect(continueToLines).toBeInViewport({ ratio: 1 });
    await expect(entryGap).toBeInViewport({ ratio: 1 });
    await expect(blockedDraft).toBeInViewport({ ratio: 1 });
    await capture(page, info, `setup-path-awaiting-principals-${width}`, pathDetail, [
      continueToLines, blockedDraft,
      pathDetail.getByRole("button", { name: "编辑转发路径", exact: true }),
    ]);
    await continueToLines.click();
    await expect(page).toHaveURL(/#published-routes$/);
    await expect(pathDetail).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "线路", exact: true })).toBeVisible();
    await page.locator(".page-heading").getByRole("button", { name: "配置公开线路", exact: true }).click();
    const lineEditor = page.getByRole("dialog", { name: "配置公开线路", exact: true });
    await lineEditor.getByLabel("线路名称", { exact: true }).fill(names.line);
    // The runtime accessibility snapshot names this button-backed combobox
    // exactly. Its wrapping label is not an exact getByLabel match.
    const pathChoice = lineEditor.getByRole("combobox", { name: "服务器转发路径", exact: true });
    await choose(page, pathChoice, names.path);
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
    const tlsTitle = lineEditor.getByText("公网入口需要启用 TLS", { exact: true });
    await expect(tlsTitle).toBeVisible();
    const tlsNotice = lineEditor.getByRole("alert").filter({ hasText: "公网入口需要启用 TLS" });
    await expect(tlsNotice).toContainText("当前输入已保留。可在这里修正入口与转发路径，再重新检查。");
    await expect(lineEditor.getByRole("button", { name: "就地修复 TLS", exact: true })).toBeVisible();
    const tlsDetails = tlsNotice.locator("details");
    await expect(tlsDetails).not.toHaveAttribute("open", "");
    await expect(tlsNotice.getByText(publicTLSRefusal, { exact: true })).not.toBeVisible();
    await tlsDetails.locator("summary").click();
    await expect(tlsNotice.getByText(publicTLSRefusal, { exact: true })).toBeVisible();
    await tlsDetails.locator("summary").click();
    await expect(tlsDetails).not.toHaveAttribute("open", "");
    await expect(tlsNotice.getByRole("link")).toHaveCount(0);
    await expect(saveLine).toHaveCount(0);
    await expect(lineEditor.getByLabel("线路名称", { exact: true })).toHaveValue(names.line);
    await expect(pathChoice).toHaveText(names.path);
    await expect(publicHost).toHaveValue("public-entry.example.test");
    await expect(publicPortField).toHaveValue(String(listenerPort));
    expect(await read(page.request, "/published-routes")).toEqual([]);
    await tlsTitle.scrollIntoViewIfNeeded();
    await capture(page, info, `setup-public-tls-refusal-${width}`, lineEditor, [tlsTitle]);
    // The tall recovery and completion may require separate narrow-screen
    // views. Preserve the original error frame before inspecting the footer.
    await inspect.scrollIntoViewIfNeeded();
    await capture(page, info, `setup-public-tls-refusal-completion-${width}`, lineEditor, [
      lineEditor.getByRole("button", { name: "取消", exact: true }), inspect,
    ]);

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
    await capture(page, info, `setup-line-rechecked-decision-${width}`, lineEditor, [
      lineEditor.getByRole("button", { name: "取消", exact: true }), inspect, saveLine, consequence,
    ]);
    const lineSaved = responseFor(page, "/published-routes");
    await saveLine.click();
    expect((await lineSaved).status()).toBe(200);
    await expect(lineEditor).not.toBeVisible();
    const lines = await read(page.request, "/published-routes");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({ name: names.line, deploymentId: deployment.id, endpointIds: [listener.id], publicHost: "127.0.0.1", publicPort, status: "draft", effective: null });
    const justSavedLine = page.getByRole("dialog", { name: names.line, exact: true });
    await expect(justSavedLine).toBeVisible();
    await expect(justSavedLine.getByText("线路已保存", { exact: true })).toBeVisible();
    expect(await page.getByText("线路已保存", { exact: true }).count()).toBe(1);
    await capture(page, info, `setup-line-just-saved-${width}`, justSavedLine, [
      justSavedLine.getByText("线路已保存", { exact: true }),
      justSavedLine.getByRole("button", { name: "编辑线路", exact: true }),
    ]);
    await page.reload();
    const lineDetail = page.getByRole("dialog", { name: names.line, exact: true });
    await expect(lineDetail.getByText("草稿已保存，尚未确认应用", { exact: true })).toBeVisible();
    await expect(lineDetail.getByLabel("已保存路径", { exact: true })).toContainText(names.listener);
    await expect(lineDetail).toContainText(`127.0.0.1:${publicPort}`);
    await expect(lineDetail.getByRole("link", { name: "检查并应用转发路径", exact: true })).toHaveAttribute("href", `#routes?deployment=${encodeURIComponent(deployment.id)}&line=${encodeURIComponent(line.id)}`);
    await expect(lineDetail.getByText("已确认生效", { exact: true })).toHaveCount(0);
    await capture(page, info, `setup-line-saved-not-applied-${width}`, lineDetail, [
      lineDetail.getByRole("button", { name: "编辑线路", exact: true }),
    ]);

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


