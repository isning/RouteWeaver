import { expect, test, type Locator, type Page } from "@playwright/test";
import { settledTask } from "./ui-settled-task";
import type {
  Collection,
  HostRecord,
  Output,
  Overview,
  Profile,
  State,
} from "../src/types";

// Complements run 41166434440's route inventory: fleet/activity had no pixels;
// collections, servers and settings only had editor/secondary-tab captures.
// These are production views with synthetic GET-boundary inventories, NOT API
// persistence, applied configuration, live health or publication acceptance.
// No access dialog is opened and no fixture contains a subscription credential.
test.use({ trace: "off", screenshot: "off", video: "off" });

const profile: Profile = {
  id: "visual-draft",
  name: "办公与远程协作分流配置",
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  sourceIds: [],
  ir: {
    schemaVersion: "1.0",
    id: "visual-draft",
    name: "办公与远程协作分流配置",
    ownerId: "visual-admin",
    revision: "1",
    endpoints: [],
    groups: [],
    rules: [],
    resources: [],
    defaultAction: { kind: "direct" },
    runtime: {},
  },
};
const outputs: Output[] = ["办公电脑", "移动设备"].map((name, index) => ({
  id: `visual-client-${index}`,
  name,
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "draft",
}));
const collections: Collection[] = [
  {
    id: "visual-collection",
    name: "欧洲与亚太远程协作节点集合",
    sources: [],
    steps: [],
  },
];
const hosts: HostRecord[] = [
  {
    id: "visual-host",
    name: "远程协作服务器",
    address: "inventory.example.test",
    group: "协作团队",
    tags: ["办公", "远程"],
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
const overview: Overview = {
  status: "active",
  quotaBytes: 0,
  user: {
    id: "visual-admin",
    name: "视觉审查管理员",
    enabled: true,
    quotaBytes: 0,
    usedBytes: 0,
  },
  usage: { rawBytes: 0, weightedBytes: 0 },
  routes: [],
};
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "visual-admin", name: "视觉审查管理员", role: "admin" },
    csrfToken: "unused-read-only-fixture",
  },
  "/state": state,
  "/services": [],
  "/published-routes": [],
  "/settings": {
    name: "协作平台",
    registration: "invite",
    timezone: "UTC+8",
  },
  "/admin/subscription-origin": {
    revision: 0,
    configuredRevision: 0,
    effectiveRevision: 0,
    draftOrigin: "",
    effectiveOrigin: "",
    defaultOrigin: "",
    verificationStatus: "not-required",
    tokensUnchanged: true,
    // A literal public placeholder, never a token, credential or usable feed.
    currentLinkExample: "https://subscriptions.example.test/feed/{订阅标识}",
    proposedLinkExample: "",
  },
  "/audit": [
    {
      id: "visual-audit",
      actorId: "visual-admin",
      action: "service.saved",
      targetId: "visual-service",
      at: "2026-10-27T08:00:00Z",
    },
  ],
  "/admin/fleet-batches": [],
  "/hosts": hosts,
  "/core-instances": [],
  "/managed-endpoints": [],
  "/links": [],
  "/server-deployments": [],
  "/me/sources": [
    { id: "visual-source-eu", name: "欧洲办公节点", kind: "text", enabled: true },
    { id: "visual-source-ap", name: "亚太远程协作节点", kind: "url", enabled: true },
  ],
  "/me/collections": collections,
  "/me/overview": overview,
  "/me/profiles": [profile],
  "/me/profiles/visual-draft/reveal": profile,
  "/me/resources": [],
  "/me/platform-entries": [],
  "/auth/sessions": [],
  "/admin/accounts": [],
  "/me/outputs": outputs,
};

async function readOnlyInventory(page: Page, overrides: Record<string, unknown> = {}) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Visual gap QA requires a loopback base URL");
  const origin = new URL(baseURL).origin;
  const unexpected: string[] = [];
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    if (request.method() !== "GET" || !(path in fixtures || path in overrides)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 503,
        json: { detail: "Unsupported read-only visual fixture request" },
      });
    }
    return route.fulfill({ json: overrides[path] ?? fixtures[path] });
  });
  return unexpected;
}

// Reconstructed acceptance for shared console controls. Synthetic GET fixtures
// establish task behavior/pixels only, not deployment or production health.
for (const width of [1280, 390]) {
  test(`refined resource controls and task spacing at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpected = await readOnlyInventory(page);
    await page.goto("/#sources");
    const toolbar = page.getByRole("search", { name: "查找订阅来源", exact: true });
    const search = toolbar.getByRole("textbox", { name: "搜索来源", exact: true });
    await expect(page.getByRole("button", { name: "欧洲办公节点 文本导入", exact: true })).toBeVisible();
    await search.fill("欧洲");
    await expect(page.getByRole("button", { name: "亚太远程协作节点 订阅链接", exact: true })).toHaveCount(0);
    const clear = toolbar.getByRole("button", { name: "清除搜索输入", exact: true });
    for (const control of [search, clear]) expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    if (width >= 1280) {
      const searchBox = (await search.locator("..").boundingBox())!;
      const summaryBox = (await toolbar.getByText("2 个私有来源", { exact: true }).boundingBox())!;
      const gap = summaryBox.x - searchBox.x - searchBox.width;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(16);
      expect(Math.abs(searchBox.y + searchBox.height / 2 - summaryBox.y - summaryBox.height / 2)).toBeLessThanOrEqual(2);
    }
    await page.screenshot({ path: info.outputPath(`refined-source-toolbar-${width}.png`), fullPage: true });
    await clear.focus();
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(page.getByRole("button", { name: "亚太远程协作节点 订阅链接", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    const sourceDialog = page.getByRole("dialog", { name: "添加订阅来源", exact: true });
    await expect(sourceDialog.getByRole("textbox", { name: "来源名称", exact: true })).toBeVisible();
    await settledTask(sourceDialog);
    await page.screenshot({ path: info.outputPath(`refined-source-dialog-${width}.png`) });
    await sourceDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(sourceDialog).toHaveCount(0);

    await page.goto("/#fleet");
    await page.getByRole("button", { name: "计划变更", exact: true }).click();
    const plan = page.getByRole("dialog", { name: "计划批量变更", exact: true });
    const range = plan.getByRole("search", { name: "筛选执行范围", exact: true });
    await range.scrollIntoViewIfNeeded();
    const groupFilter = range.getByRole("combobox", { name: "筛选服务器分组", exact: true });
    const tagFilter = range.getByRole("combobox", { name: "筛选服务器标签", exact: true });
    const rangeSearch = range.getByRole("textbox", { name: "筛选批量变更实例", exact: true });
    await groupFilter.click();
    await page.getByRole("option", { name: "协作团队", exact: true }).click();
    await tagFilter.click();
    await page.getByRole("option", { name: "办公", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(tagFilter).toBeFocused();
    await expect(groupFilter).toHaveText("协作团队");
    const removeTag = range.getByRole("button", { name: "移除 办公", exact: true });
    await expect(removeTag).toBeVisible();
    await range.scrollIntoViewIfNeeded();
    const groupBox = (await groupFilter.boundingBox())!;
    const tagBox = (await tagFilter.boundingBox())!;
    const searchBox = (await rangeSearch.boundingBox())!;
    for (const box of [groupBox, tagBox, searchBox]) expect(box.height).toBeGreaterThanOrEqual(44);
    const labelBox = (await range.getByText("服务器标签", { exact: true }).boundingBox())!;
    if (width >= 1280) {
      expect(Math.abs(groupBox.y - tagBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(searchBox.y - tagBox.y)).toBeLessThanOrEqual(2);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(tagBox.x);
      expect(Math.abs(labelBox.y + labelBox.height / 2 - tagBox.y - tagBox.height / 2)).toBeLessThanOrEqual(2);
    } else expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(tagBox.y);
    expect(await range.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual((await range.boundingBox())!.width + 1);
    await page.screenshot({ path: info.outputPath(`refined-fleet-filters-${width}.png`) });
    await removeTag.focus();
    await page.keyboard.press("Enter");
    await expect(removeTag).toHaveCount(0);
    await expect(groupFilter).toHaveText("协作团队");
    await rangeSearch.fill("远程");
    await range.getByRole("button", { name: "清除搜索输入", exact: true }).click();
    await expect(rangeSearch).toBeFocused();
    await expect(rangeSearch).toHaveValue("");
    await plan.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(plan).toHaveCount(0);

    await page.goto("/#settings");
    await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "平台基本设置" }).getByText("协作平台", { exact: true })).toBeVisible();
    const settingsForm = page.getByRole("form", { name: "平台基本设置", exact: true });
    await expect(settingsForm.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "基本设置", exact: true })).toHaveCount(0);
    for (const policy of [
      { term: /^平台名称$/, help: null, value: "协作平台" },
      { term: /^账号注册$/, help: "新账号须由管理员生成邀请后创建。", value: "仅受邀用户" },
      { term: /^默认时区$/, help: "流量周期按 UTC+8 计算；具体重置方式在服务方案或用户授权中设置。", value: "UTC+8" },
    ]) {
      const term = settingsForm.getByRole("term").filter({ hasText: policy.term });
      await expect(term).toHaveCount(1);
      await expect(term).toBeVisible();
      const row = term.locator("..");
      const value = row.locator(":scope > dt + dd");
      const help = row.locator(":scope > dt + dd + dd");
      await expect(value).toHaveCount(1);
      await expect(value).toBeVisible();
      await expect(value).toHaveText(policy.value);
      const surface = settingsForm.locator("..");
      const surfaceBox = (await surface.boundingBox())!;
      const rowBox = (await row.boundingBox())!;
      expect(rowBox.x).toBeCloseTo(surfaceBox.x + 1, 0);
      expect(rowBox.width).toBeCloseTo(surfaceBox.width - 2, 0);
      if (!policy.help) {
        await expect(settingsForm.getByText("用于记录此控制平面的名称。", { exact: true })).toHaveCount(0);
        continue;
      }
      await expect(help).toHaveCount(1);
      await expect(help).toBeVisible();
      await expect(help).toHaveText(policy.help);
      const termBox = (await term.boundingBox())!;
      const valueBox = (await value.boundingBox())!;
      const helpBox = (await help.boundingBox())!;
      if (width <= 390) {
        expect(valueBox.y).toBeGreaterThanOrEqual(termBox.y + termBox.height);
        expect(helpBox.y).toBeGreaterThanOrEqual(valueBox.y + valueBox.height);
        expect(valueBox.x).toBeCloseTo(termBox.x, 0);
        expect(helpBox.x).toBeCloseTo(termBox.x, 0);
      } else {
        expect(valueBox.y).toBeCloseTo(termBox.y, 0);
        expect(helpBox.x).toBeCloseTo(valueBox.x, 0);
        expect(helpBox.y).toBeGreaterThanOrEqual(valueBox.y + valueBox.height);
      }
    }
    const platform = page.getByRole("region", { name: "平台信息", exact: true });
    const groupHeading = platform.getByRole("heading", { name: "平台信息", exact: true });
    const groupSurface = platform.locator(".settings-surface");
    expect((await groupHeading.boundingBox())!.y + (await groupHeading.boundingBox())!.height).toBeLessThan((await groupSurface.boundingBox())!.y);
    const lines = await settingsForm.evaluate(form => {
      const name = form.querySelector("dl[hidden]") ? form.querySelector("dl:not([hidden])") : form.querySelector("dl");
      const registration = Array.from(form.querySelectorAll("dt")).find(node => node.textContent === "账号注册")!.parentElement!;
      return [name!, registration].map(node => parseFloat(getComputedStyle(node).borderBottomWidth) + parseFloat(getComputedStyle(node).borderTopWidth));
    });
    expect(lines.every(width => width >= 1)).toBe(true);
    const platformRows = settingsForm.locator(".settings-row");
    await expect(platformRows).toHaveCount(3);
    const rowRects = await platformRows.evaluateAll(rows => rows.map(row => {
      const box = row.getBoundingClientRect();
      const term = row.querySelector("dt")!.getBoundingClientRect();
      return { y: box.y, bottom: box.bottom, inset: term.y - box.y };
    }));
    // Only the separating 1px border may lie between consecutive setting rows.
    for (let index = 1; index < rowRects.length; index++) {
      expect(rowRects[index].y - rowRects[index - 1].bottom).toBeGreaterThanOrEqual(0);
      expect(rowRects[index].y - rowRects[index - 1].bottom).toBeLessThanOrEqual(1);
      expect(Math.abs(rowRects[index].inset - rowRects[0].inset)).toBeLessThanOrEqual(1);
    }
    const originHelp = page.getByText(/请先由运维配置 DNS、有效 HTTPS/);
    const originSave = page.getByRole("button", { name: "保存域名草稿", exact: true });
    await expect(originHelp).toBeVisible();
    const originHelpBox = (await originHelp.boundingBox())!;
    const originSaveBox = (await originSave.boundingBox())!;
    expect(originHelpBox.y + originHelpBox.height).toBeLessThanOrEqual(originSaveBox.y);
    for (const tab of await page.getByRole("tab").all()) expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: info.outputPath(`refined-settings-${width}.png`), fullPage: true });
    await page.route("**/api/auth/me", route => route.fulfill({ status: 401, json: { detail: "Sign in required for the synthetic login view" } }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "登录 RouteWeaver", exact: true })).toBeVisible();
    const password = page.getByLabel("密码", { exact: true });
    const inputBox = (await password.boundingBox())!;
    const outlineBox = (await password.locator("..").boundingBox())!;
    const revealBox = (await page.getByRole("button", { name: "显示密码", exact: true }).boundingBox())!;
    expect(inputBox.height).toBeGreaterThanOrEqual(44);
    expect(revealBox.height).toBeGreaterThanOrEqual(44);
    expect(outlineBox.y).toBeLessThanOrEqual(inputBox.y);
    expect(outlineBox.y + outlineBox.height).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    await page.screenshot({ path: info.outputPath(`refined-login-controls-${width}.png`) });
    expect(unexpected, "No writes or unmodelled fixture requests").toEqual([]);
  });
}

const surfaces = [
  {
    route: "fleet",
    title: "执行任务",
    state: "empty-history",
    ready: "暂无批量变更",
  },
  {
    route: "activity",
    title: "变更记录",
    state: "audit-and-empty-generations",
    ready: "保存服务方案",
  },
  {
    route: "collections",
    title: "节点集合",
    state: "saved-list",
    ready: collections[0].name,
  },
  {
    route: "servers",
    title: "服务器",
    state: "registered-host-list",
    ready: hosts[0].name,
  },
  {
    route: "settings",
    title: "平台设置",
    state: "default-basic-settings",
    ready: "跟随当前访问地址",
  },
  // Existing API journeys cover desktop subscriptions and inbox. Capture the
  // missing narrow inventory here without opening access or publication views.
  {
    route: "subscriptions",
    title: "我的订阅",
    state: "unpublished-client-list",
    ready: profile.name,
    narrowOnly: true,
  },
];

for (const width of [1440, 390]) {
  test(`fixture-backed missing route surfaces at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    const unexpected = await readOnlyInventory(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const captured: { route: string; state: string; filename: string }[] = [];
    for (const surface of surfaces.filter(
      (item) => !item.narrowOnly || width < 700,
    )) {
      await test.step(`${surface.route}: ${surface.state}`, async () => {
        await page.goto(`/#${surface.route}`);
        const main = page.getByRole("main");
        await expect(
          main.getByRole("heading", { name: surface.title, exact: true }),
        ).toBeVisible();
        await expect(
          main.getByText(surface.ready, { exact: true }),
        ).toBeVisible();
        if (surface.route === "activity")
          await expect(
            main.getByText("还没有配置记录", { exact: true }),
          ).toBeVisible();
        if (surface.route === "servers")
          await expect(
            main.getByRole("tab", { name: "服务器 1", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
        if (surface.route === "settings") {
          await expect(
            main.getByRole("tab", { name: "基本设置", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(main.getByRole("button", { name: "编辑平台名称", exact: true })).toBeVisible();
          await expect(main.getByRole("form", { name: "平台基本设置" }).getByText("协作平台", { exact: true })).toBeVisible();
        }
        if (surface.route === "subscriptions") {
          await expect(
            main.getByRole("group", {
              name: "客户端订阅 办公电脑",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            main.getByRole("group", {
              name: "客户端订阅 移动设备",
              exact: true,
            }),
          ).toBeVisible();
        }
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width + 1);
        expect(
          unexpected,
          "No writes, external calls or unmodelled API requests",
        ).toEqual([]);
        expect(errors, "No render errors").toEqual([]);
        const filename = `fixture-${surface.route}-${surface.state}-${width}.png`;
        await page.screenshot({
          path: info.outputPath(filename),
          fullPage: true,
        });
        captured.push({ route: surface.route, state: surface.state, filename });
      });
    }
    await info.attach("fixture-backed-route-capture-scope", {
      body: JSON.stringify(
        {
          viewport: { width },
          boundary:
            "synthetic GET inventories only; no writes or backend acceptance",
          captured,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });
}

async function settleSectionNavigation(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function expectAlignedSurfaces(surfaces: Locator[]) {
  const edges = [];
  for (const surface of surfaces) {
    await expect(surface).toHaveCount(1);
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox())!;
    edges.push({ left: box.x, right: box.x + box.width });
  }
  for (const edge of edges.slice(1)) {
    expect(Math.abs(edge.left - edges[0].left)).toBeLessThanOrEqual(1);
    expect(Math.abs(edge.right - edges[0].right)).toBeLessThanOrEqual(1);
  }
}

// Real production composition with read-only fixtures: context is navigation or
// existing account usage, never fabricated telemetry. Geometry awaits CI.
for (const width of [3440, 2880, 2560, 2304, 1920, 1536, 1440, 1366, 1280, 1024, 768, 390, 320]) {
  test(`contextual page composition preserves local tasks at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 480 : 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const populatedProfile: Profile = {
      ...profile,
      ir: { ...profile.ir, endpoints: [
        { id: "visual-tokyo", name: "东京远程办公连接 Tokyo workspace", origin: "imported", connection: { protocol: "socks", host: "tokyo.example.test", port: 1080 } },
        { id: "visual-london", name: "伦敦跨区域协作备用连接 London workspace", origin: "imported", connection: { protocol: "socks", host: "london.example.test", port: 1080 } },
      ] },
    };
    const unexpected = await readOnlyInventory(page, {
      "/me/profiles": [populatedProfile],
      "/me/profiles/visual-draft/reveal": populatedProfile,
      // Keep the overview sparse, like the reported page, rather than filling
      // the screen with extra records that could conceal the outer-frame gap.
      "/me/outputs": [outputs[0]],
      "/me/overview": {
      ...overview,
      quotaBytes: 100 * 1024 ** 3, remainingBytes: 75 * 1024 ** 3,
      service: { id: "visual-service", name: "跨区域协作与远程办公服务 International-Remote-Workspace", quotaBytes: 100 * 1024 ** 3, routeIds: ["visual-route"], cycle: { mode: "monthly", timezone: "UTC+8" } },
      usage: { rawBytes: 20 * 1024 ** 3, weightedBytes: 25 * 1024 ** 3 },
      cycle: { nextReset: "2026-12-01T00:00:00+08:00", timezone: "UTC+8" },
      routes: [{ id: "visual-route", name: "欧洲与亚太协作线路 LongRemoteWorkspaceConnection", rateMicros: 1500000 }],
    } });
    const assertLayout = async (navigation: boolean) => {
      const workspace = page.locator('.workspace-frame[data-presentation="workspace"]');
      if (await workspace.count()) {
        const frame = (await workspace.boundingBox())!;
        const canvas = (await workspace.locator('.workspace-canvas').boundingBox())!;
        const content = (await workspace.locator('.workspace-canvas > .workspace-content').boundingBox())!;
        const header = (await workspace.locator('.workspace-header > .workspace-content').boundingBox())!;
        const pane = (await workspace.locator('.workspace-context').boundingBox())!;
        const grid = (await workspace.locator('.workspace-grid').boundingBox())!;
        const main = (await page.locator('#main').boundingBox())!;
        const viewport = await page.evaluate(() => document.documentElement.clientWidth);
        const sideBySide = frame.width >= (navigation ? 864 : 1120);
        expect(frame.x).toBeCloseTo(main.x, 0);
        expect(frame.x + frame.width).toBeCloseTo(viewport, 0);
        expect(content.width).toBeLessThanOrEqual(navigation ? 832 : 1152);
        expect(content.x - canvas.x).toBeCloseTo(canvas.x + canvas.width - content.x - content.width, 0);
        expect(header.x).toBeCloseTo(content.x, 0);
        expect(header.width).toBeCloseTo(content.width, 0);
        if (sideBySide) {
          expect(pane.width).toBeCloseTo(navigation ? 224 : 352, 0);
          expect(canvas.width).toBeGreaterThanOrEqual(navigation ? 640 : 768);
          expect(pane.x).toBeCloseTo(canvas.x + canvas.width, 0);
          expect(pane.x + pane.width).toBeCloseTo(viewport, 0);
          expect(pane.y).toBeCloseTo(grid.y, 0);
          expect(pane.height).toBeCloseTo(grid.height, 0);
          const paneStyle = await workspace.locator('.workspace-context').evaluate(element => ({
            border: getComputedStyle(element).borderLeftWidth,
            position: getComputedStyle(element).position,
          }));
          expect(paneStyle.border).toBe("1px");
          expect(paneStyle.position).not.toBe("fixed");
        } else if (navigation) {
          expect(header.y + header.height).toBeLessThanOrEqual(pane.y);
          expect(pane.y + pane.height).toBeLessThanOrEqual(canvas.y);
        } else expect(canvas.y + canvas.height).toBeLessThanOrEqual(pane.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await info.attach(`pilot-${navigation ? "settings" : "subscriptions"}-${width}`, {
          body: JSON.stringify({ frame, canvas, content, header, pane, grid, main, viewport, sideBySide }), contentType: "application/json",
        });
        return content;
      }
      const layout = page.locator(".context-layout:visible").first();
      const primary = (await layout.locator(":scope > .page-primary").boundingBox())!;
      const rail = (await layout.locator(":scope > .page-context").boundingBox())!;
      const frame = (await layout.boundingBox())!;
      const sideBySide = frame.width >= (navigation ? 976 : 1088);
      if (sideBySide) {
        expect(primary.width).toBeGreaterThanOrEqual(776);
        expect(rail.width).toBeCloseTo(navigation ? 176 : 288, 0);
        expect(rail.x - primary.x - primary.width).toBeCloseTo(24, 0);
        expect(rail.x + rail.width).toBeLessThanOrEqual(width);
      } else if (navigation) expect(rail.y + rail.height).toBeLessThanOrEqual(primary.y);
      else expect(primary.y + primary.height).toBeLessThanOrEqual(rail.y);
      if (width === 1280) {
        // v10 gave either task only ~704px. Directory and data now differ.
        expect(primary.width).toBeGreaterThanOrEqual(navigation ? 800 : 1000);
        expect(sideBySide).toBe(navigation);
      }
      const main = (await page.locator("#main").boundingBox())!;
      const shell = (await page.locator(".main-shell").boundingBox())!;
      const environment = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        devicePixelRatio: window.devicePixelRatio,
        visualViewport: window.visualViewport && {
          width: window.visualViewport.width, scale: window.visualViewport.scale,
        },
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        mainMaxWidth: getComputedStyle(document.getElementById("main")!).maxWidth,
        mainPaddingRight: getComputedStyle(document.getElementById("main")!).paddingRight,
      }));
      const viewport = environment.clientWidth;
      // The task frame must use the available window, not strand the rail at
      // an old max-width while the shell leaves a growing empty area beyond it.
      expect(main.x + main.width).toBeCloseTo(viewport, 0);
      expect(main.x + main.width).toBeCloseTo(shell.x + shell.width, 0);
      const rightGutter = viewport - frame.x - frame.width;
      expect(rightGutter).toBeCloseTo(width >= 640 ? 24 : 16, 0);
      if (sideBySide) {
        expect(rail.x + rail.width).toBeCloseTo(frame.x + frame.width, 0);
        expect(viewport - rail.x - rail.width).toBeGreaterThanOrEqual(23);
        expect(viewport - rail.x - rail.width).toBeLessThanOrEqual(25);
      }
      if (width >= 1024) {
        const sidebar = (await page.locator('#workspace-navigation').boundingBox())!;
        expect(sidebar.width).toBeCloseTo(224, 0);
        // Keep the task beside navigation, including at 1920, not centered far away.
        expect(primary.x - sidebar.x - sidebar.width).toBeGreaterThanOrEqual(24);
        expect(primary.x - sidebar.x - sidebar.width).toBeLessThanOrEqual(26);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await info.attach(`proportions-${navigation ? "directory" : "data"}-${width}`, {
        body: JSON.stringify({ environment, shell, main, frame, primary, rail, sideBySide, rightGutter }), contentType: "application/json",
      });
      return primary;
    };
    await page.goto("/#settings");
    const editName = page.getByRole("button", { name: "编辑平台名称", exact: true });
    await expect(editName).toBeVisible();
    const name = page.getByRole("textbox", { name: "平台名称", exact: true });
    await expect(name).toHaveCount(0);
    const index = page.getByRole("navigation", { name: "本页设置", exact: true });
    await expect(index).toBeVisible();
    await assertLayout(true);
    const originSummary = page.locator(".subscription-origin-summary");
    await expect(originSummary).toBeVisible();
    const originSurface = page.getByRole("region", { name: "订阅域名设置", exact: true }).locator(".settings-surface");
    const surfaceBox = (await originSurface.boundingBox())!;
    const summaryBox = (await originSummary.boundingBox())!;
    expect(surfaceBox.width).toBeLessThanOrEqual(832);
    expect(summaryBox.x).toBeCloseTo(surfaceBox.x + 1, 0);
    expect(summaryBox.width).toBeCloseTo(surfaceBox.width - 2, 0);
    for (const pair of await originSummary.locator(":scope > div").all()) {
      const term = (await pair.locator("dt").boundingBox())!;
      const value = (await pair.locator(":scope > dt + dd").boundingBox())!;
      if (surfaceBox.width >= 640) {
        expect(value.x - term.x - term.width).toBeCloseTo(20, 0);
        expect(value.y).toBeCloseTo(term.y, 0);
      } else {
        expect(value.x).toBeCloseTo(term.x, 0);
        expect(value.y - term.y - term.height).toBeCloseTo(6, 0);
      }
      expect(await pair.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual((await pair.boundingBox())!.width + 1);
    }
    if ((await page.locator(".workspace-frame").boundingBox())!.width >= 864) {
      const currentSection = index.locator('[aria-current="location"]');
      await expect(currentSection).not.toBeFocused();
      const marker = await currentSection.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          top: style.borderTopColor, right: style.borderRightColor,
          bottom: style.borderBottomColor, left: style.borderLeftColor,
          leftWidth: style.borderLeftWidth,
        };
      });
      expect(marker.top).toBe("rgba(0, 0, 0, 0)");
      expect(marker.right).toBe("rgba(0, 0, 0, 0)");
      expect(marker.bottom).toBe("rgba(0, 0, 0, 0)");
      expect(marker.left).not.toBe("rgba(0, 0, 0, 0)");
      expect(marker.leftWidth).toBe("2px");
    }
    const cardWithHeading = (heading: string) => page.locator('[data-slot="card"]').filter({
      has: page.getByRole("heading", { name: heading, exact: true }),
    });
    await expectAlignedSurfaces([
      page.getByRole("region", { name: "平台信息", exact: true }).locator(".settings-surface").filter({
        has: page.getByRole("form", { name: "平台基本设置", exact: true }),
      }),
      page.getByRole("region", { name: "订阅域名设置", exact: true }).locator(".settings-surface"),
    ]);
    await page.screenshot({ path: info.outputPath(`context-settings-${width}.png`), fullPage: true });
    await editName.click();
    await expect(name).toBeFocused();
    expect((await name.boundingBox())!.width).toBeLessThanOrEqual(576);
    await name.fill("未保存的平台信息");
    await page.screenshot({ path: info.outputPath(`pilot-settings-name-edit-${width}.png`) });
    const domain = page.getByRole("textbox", { name: "订阅域名草稿", exact: true });
    await domain.fill("https://draft.example.test");
    const historyBefore = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
    const goDomain = index.getByRole("button", { name: "前往订阅域名", exact: true });
    await goDomain.focus();
    await page.keyboard.press("Enter");
    const domainSection = page.getByRole("region", { name: "订阅域名设置", exact: true });
    await settleSectionNavigation(page);
    await expect(domainSection).toBeFocused();
    await expect(goDomain).toHaveAttribute("aria-current", "location");
    await page.screenshot({ path: info.outputPath(`context-settings-domain-focus-${width}.png`) });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await page.evaluate(() => ({ hash: location.hash, length: history.length }))).toEqual(historyBefore);
    await expect(name).toHaveValue("未保存的平台信息");
    await expect(domain).toHaveValue("https://draft.example.test");
    // Restore only the two edited inputs before a real workspace navigation.
    await name.fill("协作平台");
    await domain.fill("");
    await page.getByRole("tab", { name: "备份与恢复", exact: true }).click();
    await assertLayout(true);
    const restoreLink = page.getByRole("navigation", { name: "本页备份任务", exact: true }).getByRole("button", { name: "前往恢复备份", exact: true });
    await restoreLink.focus();
    await page.keyboard.press("Enter");
    await settleSectionNavigation(page);
    await expect(page.getByRole("region", { name: "恢复备份设置", exact: true })).toBeFocused();
    await expect(restoreLink).toHaveAttribute("aria-current", "location");
    await page.screenshot({ path: info.outputPath(`context-backup-restore-focus-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`context-backup-${width}.png`), fullPage: true });
    await page.goto("/#account-security");
    const securityIndex = page.getByRole("navigation", { name: "本页账号设置", exact: true });
    await expect(securityIndex).toBeVisible();
    await assertLayout(true);
    await expectAlignedSurfaces([
      cardWithHeading("修改密码"),
      cardWithHeading("登录会话"),
      cardWithHeading("账号恢复与退役"),
      cardWithHeading("管理员二次验证"),
    ]);
    for (const label of ["当前密码", "新密码", "确认新密码", "验证当前密码"]) {
      const field = page.getByLabel(label, { exact: true });
      const measure = await field.evaluate(element => {
        const content = element.closest('[data-slot="card-content"]')!;
        const control = element.closest('[data-slot="input-group"]')!;
        const style = getComputedStyle(content);
        return {
          width: control.getBoundingClientRect().width,
          available: content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      });
      expect(measure.width).toBeLessThanOrEqual(576);
      if (width <= 390) expect(measure.width).toBeCloseTo(measure.available, 0);
    }
    const sessionsLink = securityIndex.getByRole("button", { name: "前往登录会话", exact: true });
    await sessionsLink.focus();
    await page.keyboard.press("Enter");
    await settleSectionNavigation(page);
    await expect(page.getByRole("region", { name: "登录会话设置", exact: true })).toBeFocused();
    await expect(sessionsLink).toHaveAttribute("aria-current", "location");
    await page.screenshot({ path: info.outputPath(`context-account-sessions-focus-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`context-account-security-${width}.png`), fullPage: true });
    const mfaLink = securityIndex.getByRole("button", { name: "前往管理员二次验证", exact: true });
    await mfaLink.focus();
    await page.keyboard.press("Enter");
    await settleSectionNavigation(page);
    const mfa = page.getByRole("region", { name: "管理员二次验证设置", exact: true });
    await expect(mfa).toBeFocused();
    await expect(mfa.getByLabel("验证当前账号密码", { exact: true })).toBeVisible();
    await expect(mfaLink).toHaveAttribute("aria-current", "location");
    await page.screenshot({ path: info.outputPath(`context-account-mfa-focus-${width}.png`) });
    await page.goto("/#subscriptions");
    await expect(page.getByRole("heading", { name: "平台服务用量", exact: true })).toHaveCount(1);
    const subscriptionPrimary = await assertLayout(false);
    const createBox = (await page.getByRole("button", { name: "新建分流配置", exact: true }).boundingBox())!;
    const titleBox = (await page.getByRole("heading", { name: "我的订阅", exact: true }).boundingBox())!;
    expect(titleBox.x).toBeCloseTo(subscriptionPrimary.x, 0);
    if (width >= 1024) expect(createBox.x + createBox.width).toBeCloseTo(subscriptionPrimary.x + subscriptionPrimary.width, 0);
    await page.screenshot({ path: info.outputPath(`context-subscriptions-${width}.png`), fullPage: true });
    const usage = page.getByRole("complementary", { name: "平台服务概览", exact: true });
    const details = usage.getByRole("button", { name: "用量与周期明细", exact: true });
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await usage.getByRole("button", { name: "平台提供的线路 · 1", exact: true }).click();
    await expect(usage.getByText("欧洲与亚太协作线路 LongRemoteWorkspaceConnection", { exact: true })).toBeVisible();
    const dataRailIsSideBySide = (await usage.boundingBox())!.width < 400;
    if (width >= 1024 && dataRailIsSideBySide) {
      expect((await usage.locator('[data-slot="card-content"]').boundingBox())!.width).toBeGreaterThanOrEqual(300);
    }
    for (const inner of await usage.locator('[data-slot="card-header"], [data-slot="card-content"], .route-option').all()) {
      expect(await inner.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual((await inner.boundingBox())!.width + 1);
    }
    await page.screenshot({ path: info.outputPath(`context-usage-expanded-${width}.png`), fullPage: true });
    await page.setViewportSize({ width: width >= 1280 ? 390 : 1280, height: 900 });
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("heading", { name: "平台服务用量", exact: true })).toHaveCount(1);
    await page.setViewportSize({ width, height: width === 320 ? 480 : 900 });
    await page.getByRole("button", { name: "编辑配置", exact: true }).click();
    const profileIndex = page.getByRole("navigation", { name: "配置内容", exact: true });
    await expect(profileIndex).toBeVisible();
    const profilePrimary = await assertLayout(true);
    const profileTitle = (await page.getByRole("heading", { name: profile.name, exact: true }).boundingBox())!;
    expect(profileTitle.x).toBeCloseTo(profilePrimary.x, 0);
    const inspect = (await page.getByRole("button", { name: "检查发布", exact: true }).boundingBox())!;
    if (width >= 1024) expect(inspect.x + inspect.width).toBeCloseTo(profilePrimary.x + profilePrimary.width, 0);
    await expect(page.getByText("2 个有效连接", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑来源", exact: true }).click();
    const inputTask = (await page.locator(".profile-input-task").boundingBox())!;
    const trafficTask = (await page.locator(".profile-traffic-task").boundingBox())!;
    if (width >= 1024) {
      expect(inputTask.y).toBeCloseTo(trafficTask.y, 0);
      expect(trafficTask.x).toBeGreaterThan(inputTask.x + inputTask.width);
      expect(inputTask.width).toBeGreaterThanOrEqual(340);
      expect(trafficTask.width).toBeGreaterThanOrEqual(340);
    } else expect(trafficTask.y).toBeGreaterThanOrEqual(inputTask.y + inputTask.height);
    await page.screenshot({ path: info.outputPath(`context-profile-${width}.png`), fullPage: true });
    if (width <= 390) {
      // A full-page capture after focusing a low control can stitch the sticky
      // actions across the index. Record the real initial viewport separately.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await settleSectionNavigation(page);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const title = (await page.getByRole("heading", { name: profile.name, exact: true }).boundingBox())!;
      const actions = (await page.locator(".profile-publish-action").boundingBox())!;
      const directory = (await profileIndex.boundingBox())!;
      expect(title.y + title.height).toBeLessThanOrEqual(actions.y);
      expect(actions.y + actions.height).toBeLessThanOrEqual(directory.y);
      await page.screenshot({ path: info.outputPath(`context-profile-initial-viewport-${width}.png`) });
    }
    const runtimeLink = profileIndex.getByRole("button", { name: "前往运行设置", exact: true });
    await runtimeLink.focus();
    await page.keyboard.press("Enter");
    const runtime = page.getByRole("tab", { name: "运行设置", exact: true });
    await settleSectionNavigation(page);
    await expect(runtime).toBeFocused();
    await expect(runtime).toHaveAttribute("aria-selected", "true");
    await expect(runtimeLink).toHaveAttribute("aria-current", "location");
    const strip = (await page.locator(".profile-editor-tools [role=tablist]").boundingBox())!;
    const panel = (await page.getByRole("tabpanel", { name: "运行设置", exact: true }).boundingBox())!;
    expect(panel.y - strip.y - strip.height).toBeGreaterThanOrEqual(0);
    expect(panel.y - strip.y - strip.height).toBeLessThanOrEqual(32);
    const stickySave = (await page.locator(".profile-publish-action").boundingBox())!;
    expect(stickySave.y).toBeGreaterThanOrEqual(0);
    expect(stickySave.y).toBeLessThanOrEqual(1);
    expect(strip.y).toBeGreaterThanOrEqual(stickySave.height);
    await page.screenshot({ path: info.outputPath(`context-profile-runtime-focus-${width}.png`) });
    await page.locator(".profile-intent-task").evaluate(el => el.scrollIntoView({ block: "start" }));
    await settleSectionNavigation(page);
    await expect(profileIndex.getByRole("button", { name: "前往连接与流量", exact: true })).toHaveAttribute("aria-current", "location");
    expect(unexpected).toEqual([]);
  });
}

for (const width of [1536, 1920, 2560, 3440]) {
  test(`wide settings frame stays stable from loading to ready at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpected = await readOnlyInventory(page);
    let releaseModule!: () => void;
    const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
    await page.route(/\/src\/Admin\.tsx(?:\?.*)?$/, async route => { await moduleGate; await route.continue(); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/settings", async route => {
      await gate;
      await route.fulfill({ json: fixtures["/settings"] });
    });
    try {
      await page.goto("/#settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("status", { name: "正在打开页面", exact: true })).toBeVisible();
      const moduleRects = await Promise.all([".workspace-frame", ".workspace-header", ".workspace-canvas", ".workspace-context"].map(selector => page.locator(selector).boundingBox()));
      releaseModule();
      await expect(page.getByRole("status", { name: "正在加载", exact: true })).toBeVisible();
      for (const [index, selector] of [".workspace-frame", ".workspace-header", ".workspace-canvas", ".workspace-context"].entries()) {
        const box = (await page.locator(selector).boundingBox())!;
        expect(box.x).toBeCloseTo(moduleRects[index]!.x, 0);
        expect(box.y).toBeCloseTo(moduleRects[index]!.y, 0);
        expect(box.width).toBeCloseTo(moduleRects[index]!.width, 0);
      }
      const pending = (await page.locator("#main").boundingBox())!;
      const pendingFrame = (await page.locator(".workspace-frame").boundingBox())!;
      const pendingCanvas = (await page.locator(".workspace-canvas").boundingBox())!;
      const pendingPane = (await page.locator(".workspace-context").boundingBox())!;
      expect(pending.x + pending.width).toBeCloseTo(await page.evaluate(() => document.documentElement.clientWidth), 0);
      await page.screenshot({ path: info.outputPath(`proportions-settings-loading-${width}.png`) });
      release();
      await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toBeVisible();
      await expect(page.getByRole("form", { name: "平台基本设置" }).getByText("协作平台", { exact: true })).toBeVisible();
      await settleSectionNavigation(page);
      const ready = (await page.locator("#main").boundingBox())!;
      expect(ready.x).toBe(pending.x);
      expect(ready.width).toBe(pending.width);
      for (const [selector, before] of [[".workspace-frame", pendingFrame], [".workspace-canvas", pendingCanvas], [".workspace-context", pendingPane]] as const) {
        const after = (await page.locator(selector).boundingBox())!;
        expect(after.x).toBeCloseTo(before.x, 0);
        expect(after.y).toBeCloseTo(before.y, 0);
        expect(after.width).toBeCloseTo(before.width, 0);
      }
      expect(unexpected).toEqual([]);
    } finally {
      releaseModule();
      release();
    }
  });
}

// Sample both sides of each content budget rather than hard-coding a device name.
test("context rails yield space before their primary task becomes cramped", async ({ page }) => {
  const unexpected = await readOnlyInventory(page);
  for (const task of [
    { route: "settings", navigation: true, widths: [1072, 1104], threshold: 864 },
    { route: "subscriptions", navigation: false, widths: [1336, 1368], threshold: 1120 },
  ]) {
    await page.goto(`/#${task.route}`);
    // A visible grid can still belong to the lazy or GET skeleton. Await the
    // actual task before testing resize; loading transitions have a separate test.
    if (task.navigation) {
      await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toBeVisible();
      await expect(page.getByRole("form", { name: "平台基本设置", exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "新建分流配置", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "搜索配置或客户端订阅", exact: true })).toBeVisible();
    }
    await expect(page.locator(".workspace-grid:visible")).toHaveCount(1);
    const modes: boolean[] = [];
    for (const width of task.widths) {
      await page.setViewportSize({ width, height: 900 });
      await settleSectionNavigation(page);
      const layout = page.locator(".workspace-grid:visible");
      await expect(layout.locator(":scope > .workspace-canvas")).toBeVisible();
      await expect(layout.locator(":scope > .workspace-context")).toBeVisible();
      // Read one DOM generation atomically, not three locator resolutions that
      // can span a render. Missing children remain an explicit test failure.
      const { frame, main, rail } = await layout.evaluate(element => {
        const canvas = element.querySelector(":scope > .workspace-canvas");
        const context = element.querySelector(":scope > .workspace-context");
        if (!canvas || !context) throw new Error("Ready workspace is missing its canvas or context pane");
        const rect = (node: Element) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return { frame: rect(element), main: rect(canvas), rail: rect(context) };
      });
      const sideBySide = frame.width >= task.threshold;
      modes.push(sideBySide);
      if (sideBySide) {
        expect(main.width).toBeGreaterThanOrEqual(task.navigation ? 640 : 768);
        expect(rail.x).toBeGreaterThanOrEqual(main.x + main.width);
      } else if (task.navigation) expect(rail.y + rail.height).toBeLessThanOrEqual(main.y);
      else expect(main.y + main.height).toBeLessThanOrEqual(rail.y);
    }
    expect(modes).toEqual([false, true]);
  }
  expect(unexpected).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`pilot name editing retains pending drafts and owns only its focus at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpected = await readOnlyInventory(page);
    const writes: unknown[] = [];
    let release!: () => void;
    let pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/settings", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: fixtures["/settings"] });
      expect(route.request().method()).toBe("PUT");
      const submitted = route.request().postDataJSON();
      writes.push(submitted);
      await pending;
      return route.fulfill({ json: submitted });
    });
    try {
      await page.goto("/#settings");
      const edit = page.getByRole("button", { name: "编辑平台名称", exact: true });
      await edit.click();
      const name = page.getByRole("textbox", { name: "平台名称", exact: true });
      await expect(name).toBeFocused();
      await name.fill("第一次提交");
      const save = page.getByRole("button", { name: "保存设置", exact: true });
      await save.click();
      await expect(save).toHaveAttribute("aria-busy", "true");
      await expect(save).toBeFocused();
      await page.keyboard.press("Enter");
      await name.fill("保存中的新草稿");
      release();
      await expect(save).not.toHaveAttribute("aria-busy", "true");
      await expect(name).toHaveValue("保存中的新草稿");
      await expect(name).toBeFocused();
      expect(writes).toEqual([{ name: "第一次提交", registration: "invite", timezone: "UTC+8" }]);
      await page.getByRole("button", { name: "取消名称修改", exact: true }).click();
      await expect(edit).toBeFocused();
      await expect(page.getByRole("form", { name: "平台基本设置" }).getByText("第一次提交", { exact: true })).toBeVisible();
      await edit.click();
      pending = new Promise<void>(resolve => { release = resolve; });
      await name.fill("第二次提交");
      await save.click();
      await expect(save).toHaveAttribute("aria-busy", "true");
      const backup = page.getByRole("tab", { name: "备份与恢复", exact: true });
      await backup.click();
      release();
      await expect(page.getByText("平台设置已保存", { exact: true })).toBeVisible();
      await expect(backup).toBeFocused();
      await page.getByRole("tab", { name: "基本设置", exact: true }).click();
      await expect(name).toHaveCount(0);
      await expect(page.getByRole("form", { name: "平台基本设置" }).getByText("第二次提交", { exact: true })).toBeVisible();
      expect(writes).toEqual([
        { name: "第一次提交", registration: "invite", timezone: "UTC+8" },
        { name: "第二次提交", registration: "invite", timezone: "UTC+8" },
      ]);
      expect(unexpected).toEqual([]);
    } finally {
      release();
    }
  });
}

// Explicit synthetic GET-state visual coverage. These screenshots prove rendering
// and action eligibility only, NOT DNS/TLS verification or deployed availability.
// The real HTTP E13 suite separately covers draft/error/default activation tasks.
for (const width of [390, 768, 1440]) {
  for (const status of ["verified", "expired", "failed"] as const) {
    test(`saved origin ${status} remains distinguishable at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      // Freeze Date only: rendering timers and transitions still run normally.
      await page.clock.setFixedTime(new Date("2026-11-03T12:03:00Z"));
      const current = "https://current.example.test/feed/{订阅标识}";
      const proposed = "https://proposed.example.test/feed/{订阅标识}";
      const failure = "HTTPS 证书校验失败，无法确认该地址属于当前实例。";
      const unexpected = await readOnlyInventory(page, {
        "/admin/subscription-origin": {
          revision: 7, configuredRevision: 6, effectiveRevision: 2,
          draftOrigin: "https://proposed.example.test",
          effectiveOrigin: "https://current.example.test",
          defaultOrigin: "https://default.example.test",
          verificationStatus: status,
          verifiedAt: status === "failed" ? undefined : status === "expired"
            ? "2026-11-03T11:55:00Z" : "2026-11-03T12:00:00Z",
          verificationExpiresAt: status === "failed" ? undefined : status === "expired"
            ? "2026-11-03T12:00:00Z" : "2026-11-03T12:05:00Z",
          lastFailure: status === "failed" ? failure : undefined,
          currentLinkExample: current, proposedLinkExample: proposed,
          tokensUnchanged: true,
        },
      });
      await page.goto("/#settings");
      const region = page.getByRole("region", { name: "订阅域名设置", exact: true });
      await expect(region.getByRole("textbox", { name: "订阅域名草稿", exact: true })).toHaveValue("https://proposed.example.test");
      await expect(region.getByText(current, { exact: true })).toBeVisible();
      await expect(region.getByText(proposed, { exact: true })).toBeVisible();
      const proof = {
        verified: "草稿已验证",
        expired: "再次启用前需要重新验证",
        failed: "草稿验证未通过",
      }[status];
      await expect(region.getByText(proof, { exact: false })).toBeVisible();
      await expect(region.getByText("待启用", { exact: true })).toBeVisible();
      if (status === "verified") await expect(region.getByText(/^本次验证有效至 .*过期后需重新验证再启用。$/)).toBeVisible();
      if (status === "expired") await expect(region.getByText(/^验证已于 .*过期，请重新验证后再启用。$/)).toBeVisible();
      if (status === "failed") await expect(region.getByText(/5 分钟/)).toHaveCount(0);
      await expect(region.getByText(/上次验证|不代表持续可用性/)).toHaveCount(0);
      // Both summaries use the same row grid and container breakpoint, including 768px.
      const linkRows = await region.locator(".settings-row").evaluateAll(rows => rows
        .filter(row => ["当前链接示例", "拟用链接"].includes(row.querySelector("dt")?.textContent ?? ""))
        .map(row => {
          const label = row.querySelector("dt")!.getBoundingClientRect();
          const value = row.querySelector("dd")!.getBoundingClientRect();
          return { labelX: label.x, labelY: label.y, valueX: value.x, valueY: value.y };
        }));
      expect(linkRows).toHaveLength(2);
      expect(Math.abs(linkRows[0].labelX - linkRows[1].labelX)).toBeLessThanOrEqual(1);
      expect(Math.abs(linkRows[0].valueX - linkRows[1].valueX)).toBeLessThanOrEqual(1);
      const groupWidth = await region.locator(".settings-group").evaluate(el => el.getBoundingClientRect().width);
      for (const row of linkRows) {
        if (groupWidth >= 640) expect(Math.abs(row.valueY - row.labelY)).toBeLessThanOrEqual(1);
        else expect(row.valueY - row.labelY).toBeGreaterThanOrEqual(24);
      }
      const enable = region.getByRole("button", { name: "启用已保存草稿", exact: true });
      await expect(region.getByRole("button", { name: "验证 HTTPS 与实例", exact: true })).toBeEnabled();
      if (status === "verified") await expect(enable).toBeEnabled();
      else await expect(enable).toBeDisabled();
      if (status === "failed") {
        await expect(region.getByText(failure, { exact: true })).toBeVisible();
        await expect(region.getByText("检查域名解析、HTTPS 证书与 /feed 路由后重试", { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`origin-state-${status}-${width}.png`), fullPage: true });
      if (status === "verified") {
        await enable.click();
        const dialog = page.getByRole("dialog", { name: "启用订阅地址", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(current, { exact: true })).toBeVisible();
        await expect(dialog.getByText(proposed, { exact: true })).toBeVisible();
        await expect(dialog.getByText(/旧链接只有在旧域名的 DNS/)).toBeVisible();
        await expect(dialog.getByRole("button", { name: "确认启用", exact: true })).toBeDisabled();
        await settledTask(dialog);
        const backdrop = page.locator('[data-slot="dialog-overlay"][data-state="open"]');
        await expect(backdrop).toHaveCount(1);
        await settledTask(backdrop);
        await page.screenshot({ path: info.outputPath(`origin-review-verified-${width}.png`) });
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(enable).toBeFocused();
        await expect(region.getByText(current, { exact: true })).toBeVisible();
      }
      expect(unexpected).toEqual([]);
    });
  }
}
