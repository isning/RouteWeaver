import { expect, test, type Page } from "@playwright/test";
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
  "/me/outputs": outputs,
};

async function readOnlyInventory(page: Page) {
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
    if (request.method() !== "GET" || !(path in fixtures)) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 503,
        json: { detail: "Unsupported read-only visual fixture request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
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
    await expect(page.getByRole("textbox", { name: "平台名称", exact: true })).toHaveValue("协作平台");
    const settingsForm = page.getByRole("form", { name: "平台基本设置", exact: true });
    await expect(settingsForm.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "基本设置", exact: true })).toHaveCount(0);
    await expect(settingsForm.getByText("账号注册", { exact: true })).toBeVisible();
    await expect(settingsForm.getByText("仅受邀用户", { exact: true })).toBeVisible();
    await expect(settingsForm.getByText("默认时区", { exact: true })).toBeVisible();
    await expect(settingsForm.getByText("UTC+8", { exact: true })).toBeVisible();
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
          await expect(
            main.getByRole("textbox", { name: "平台名称", exact: true }),
          ).toHaveValue("协作平台");
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
