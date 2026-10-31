import { expect, test, type Page } from "@playwright/test";
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
  "/me/sources": [],
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
