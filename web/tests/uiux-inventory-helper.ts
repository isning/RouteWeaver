import { mkdir, writeFile } from "node:fs/promises";
import { expect, type APIRequestContext, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { demoPassword, initialPassword, requireLoopback, signInAPI } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";

// These fixtures are owned by a fresh isolated normal-CLI database for EACH test.
// They do not use --demo, database edits, API mocks, live nodes or external feeds.
export const names = {
  account: "界面审查用户",
  source: "日常连接来源",
  collection: "工作与浏览节点",
  profile: "日常分流配置",
  output: "日常设备订阅",
  resource: "常用域名规则",
  template: "按名称整理节点",
  host: "本地审查服务器",
  core: "待接入的受管核心",
  listener: "参考监听端点",
  deployment: "待检查的转发路径",
  line: "待应用的公开线路",
  node: "备用连接端点",
  legacy: "参考链路配置",
  service: "日常连接方案",
  group: "参考用户组",
  announcement: "下次维护安排",
} as const;
const id = "uiux-inventory";

export async function read(client: APIRequestContext, path: string) {
  const response = await client.get(`/api${path}`);
  expect(response.status(), `Authoritative inventory read ${path}`).toBe(200);
  return response.json();
}
export async function headers(client: APIRequestContext) {
  return { "X-CSRF-Token": (await read(client, "/auth/me")).csrfToken as string };
}
async function create(client: APIRequestContext, path: string, data: unknown) {
  const response = await client.post(`/api${path}`, { headers: await headers(client), data });
  // Do not print response bodies: some successful setup responses contain secrets.
  expect(response.ok(), `Create owned synthetic ${path}`).toBe(true);
  return response.json();
}
export async function inviteOwner(admin: APIRequestContext, owner: APIRequestContext) {
  await signInAPI(admin, "routeweaver", demoPassword);
  const invitation = await create(admin, "/invites", { name: names.account, role: "user", expiresInHours: 1 });
  const accepted = await owner.post("/api/auth/accept-invite", {
    data: { token: invitation.token, username: "inventory-owner", password: initialPassword },
  });
  expect(accepted.status()).toBe(200);
  const result = await accepted.json();
  expect(result.user.role).toBe("user");
  return result.user.id as string;
}
export async function seedPersonal(admin: APIRequestContext, owner: APIRequestContext, route: string) {
  if (["sources", "collections", "templates"].includes(route)) {
    const source = await create(owner, "/me/sources", {
      id, name: names.source, kind: "text", enabled: true,
      content: "socks5://192.0.2.20:1080#London\nsocks5://192.0.2.30:1080#Tokyo",
    });
    expect(source.snapshot.endpoints).toHaveLength(2);
    if (route !== "sources") await create(owner, "/me/collections", {
      id, name: names.collection, sources: [{ sourceId: id, steps: [] }], steps: [],
    });
  }
  if (route === "templates") {
    await create(admin, "/admin/templates", {
      id, name: names.template, kind: "processing-preset", expectedVersion: 0,
      spec: { steps: [{ id: "sort", kind: "sort", enabled: true, sortBy: "name" }] },
    });
    await create(owner, `/me/templates/${id}/select`, { version: 1, mode: "follow", targetId: id, bindings: {} });
  }
  if (route === "resources") await create(owner, "/me/resources/import", {
    resource: { id, name: names.resource, format: "mihomo-yaml", behavior: "domain", updatePolicy: "pinned" },
    contentBase64: Buffer.from("payload:\n  - '+.example.test'\n").toString("base64"),
  });
  if (route === "subscriptions") {
    const target = { adapterId: "mihomo", version: "1.19.32" };
    await create(owner, "/me/profiles", {
      id, name: names.profile, target, mode: "full",
      ir: {
        schemaVersion: "1.0", id, name: names.profile, endpoints: [], groups: [], rules: [], resources: [],
        defaultAction: { kind: "direct" }, runtime: { mixedPort: 7890 },
      },
    });
    const output = await create(owner, "/me/outputs", { id, name: names.output, profileId: id, target, mode: "full" });
    expect(output.status).toBe("published");
    // No access endpoint, feed URL, QR, configuration download or raw bytes are captured.
  }
}
export async function seedInfrastructure(admin: APIRequestContext, withLine = false) {
  const host = { id, name: names.host, address: "127.0.0.1", group: "本地审查", tags: ["synthetic"] };
  const instance = { id, name: names.core, hostId: id, adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
  const listener = {
    id, name: names.listener, instanceId: id,
    connection: { protocol: "vless", host: "127.0.0.1", port: 23456, uuid: "00000000-0000-4000-8000-000000000099" },
  };
  await create(admin, "/hosts", host);
  await create(admin, "/core-instances", instance);
  await create(admin, "/managed-endpoints", listener);
  await create(admin, "/server-deployments", {
    id, name: names.deployment,
    ir: { schemaVersion: "1.0", id, topologyRevision: "inventory", programs: [{ instance, listener, egress: [], rules: [], resources: [] }] },
  });
  if (withLine) await create(admin, "/published-routes", {
    id, name: names.line, deploymentId: id, endpointIds: [id], publicHost: "127.0.0.1", publicPort: 23456,
  });
  // Intentionally no enrollment, telemetry, validation, execute or applied-state claim.
}
export async function seedAdmin(admin: APIRequestContext, route: string, userId: string) {
  if (["servers", "routes", "published-routes"].includes(route)) await seedInfrastructure(admin, route === "published-routes");
  if (["nodes", "legacy-routes"].includes(route)) {
    await create(admin, "/nodes", { id, name: names.node, protocol: "socks", host: "192.0.2.40", port: 1080, status: "unknown" });
    if (route === "legacy-routes") await create(admin, "/routes", { id, name: names.legacy, engine: "xray", hops: [id], userIds: [] });
  }
  if (["users", "services", "activity"].includes(route)) {
    await create(admin, "/services", { id, name: names.service, routeIds: [], quotaBytes: 107374182400, cycle: { mode: "monthly", day: 1, timezone: "UTC+8" } });
    if (route === "users") {
      const change = { group: { id, name: names.group, serviceId: id, memberIds: [userId], priority: 1 } };
      const preview = await create(admin, "/access-policy/preview", change);
      expect(preview.blockers).toHaveLength(0);
      await create(admin, "/access-policy/apply", { change, revision: preview.revision });
    }
  }
  if (route === "notifications") await create(admin, "/admin/announcements", {
    id, title: names.announcement, body: "维护时间确认后，将在这里发布安排。", audience: "all", userIds: [],
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(), enabled: false,
  });
}

export async function signIn(page: Page, baseURL: string | undefined, role: "user" | "admin") {
  requireLoopback(baseURL);
  // The existing confirmation helper deliberately confirms the subscriptions landing page.
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill(role === "user" ? "inventory-owner" : "routeweaver");
  await page.getByLabel("密码", { exact: true }).fill(role === "user" ? initialPassword : demoPassword);
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await waitForConfirmedWorkspace(page, "normal-ui-login");
  expect((await read(page.request, "/auth/me")).user.role).toBe(role);
  // Leave the landing document before monitoring. A hash-only change would reuse
  // subscriptions and its already-read query cache instead of making a cold route read.
  await page.goto("about:blank");
}
export async function activate(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
}

export type InventoryState = "populated" | "authoritative-empty" | "configured" | "unsubmitted-task";
type Capture = {
  state: string;
  classification: InventoryState;
  evidence: string;
  screenshot: string;
  scope: "page" | "task";
  assertions: string[];
};
/** This manifest records successful assertions and pixels, not a blanket UX verdict. */
export class Inventory {
  readonly captures: Capture[] = [];
  readonly interactions: string[] = [];
  private mutations: string[] = [];
  private errors: string[] = [];
  private completed = false;
  private observedRequests = new WeakSet<Request>();
  constructor(readonly page: Page, readonly info: TestInfo, readonly role: "user" | "admin", readonly route: string) {
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/")) this.observedRequests.add(request);
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) this.mutations.push(`${request.method()} ${path}`);
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (this.observedRequests.has(response.request()) && response.status() >= 400) this.errors.push(`${response.status()} ${path}`);
    });
    page.on("requestfailed", (request) => {
      if (this.observedRequests.has(request)) this.errors.push(`transport-failed ${new URL(request.url()).pathname}`);
    });
  }
  async stable(surface = this.page.locator(".route-content")) {
    await expect(surface.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await this.page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settledTask(surface);
    expect(await this.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal PAGE overflow; tables may scroll in their own labeled region").toBe(true);
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(this.page.viewportSize()!.width + 1);
  }
  async capture(state: string, classification: InventoryState, evidence: string, surface?: Locator) {
    await this.stable(surface);
    const filename = `${this.role}-${this.route}-${state}-${this.page.viewportSize()!.width}.png`;
    const path = this.info.outputPath("uiux-inventory", filename);
    await mkdir(this.info.outputPath("uiux-inventory"), { recursive: true });
    // No animation disabling, broad masks, raw config, feed URLs or QR surfaces.
    // Password fields are unfilled in these tasks, so no mask paints over a modal.
    await this.page.screenshot({ path, fullPage: !surface });
    this.captures.push({
      state, classification, evidence, screenshot: filename, scope: surface ? "task" : "page",
      assertions: ["real successful API + named rendered state", "natural finite motion settled", "no horizontal page overflow", "surface within viewport width", "fonts ready"],
    });
  }
  async heading(title: string) {
    const heading = this.page.getByRole("heading", { name: title, exact: true, level: 1 });
    await expect(heading).toBeVisible();
    await expect(heading).toBeInViewport({ ratio: 1 });
    if (this.page.viewportSize()!.width < 700) await expect(this.page.getByRole("button", { name: "打开导航", exact: true })).toBeInViewport({ ratio: 1 });
    else await expect(this.page.getByRole("navigation", { name: "工作空间导航", exact: true })).toBeVisible();
    this.interactions.push("main heading and desktop navigation/mobile navigation trigger visible in initial viewport");
  }
  async tab(name: string | RegExp) {
    const tab = this.page.getByRole("tab", { name, exact: typeof name === "string" });
    await activate(this.page, tab);
    await expect(tab).toHaveAttribute("aria-selected", "true");
    this.interactions.push(`keyboard-selected tab: ${String(name)}`);
  }
  async inView(target: Locator) {
    await expect(target).toBeVisible();
    // A viewport-only assertion misses a field underneath a task footer or a
    // table column clipped by its own rail. Intersect every actual clip owner.
    await expect.poll(() => target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, box.left + node.clientLeft);
          right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, box.top + node.clientTop);
          bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
        }
      }
      return rect.width > 0 && rect.height > 0 && rect.left >= left - 1 &&
        rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1;
    }), "The complete named field, consequence or action fits inside its actual visible clip").toBe(true);
  }
  async tabTo(surface: Locator, target: Locator) {
    // Bound traversal by this surface's controls, rather than sleeping or
    // programmatically focusing the destination and calling it keyboard access.
    const stops = await surface.locator('a[href],button,input,select,textarea,[tabindex]').count();
    for (let step = 0; step <= stops; step++) {
      if (await target.evaluate((element) => element === document.activeElement)) break;
      expect(await surface.evaluate((element) => element.contains(document.activeElement)), "Tab remains in the current task").toBe(true);
      await this.page.keyboard.press("Tab");
    }
    await expect(target).toBeFocused();
    await this.stable(surface);
    await this.inView(target);
  }
  async wheelColumns(viewport: Locator, targets: Locator[]) {
    await expect(viewport).toHaveCount(1);
    await expect(viewport).toHaveAccessibleName("表格滚动区域");
    await expect(viewport).toHaveAccessibleDescription("向左右滚动查看完整表格");
    await this.inView(viewport);
    const rail = await viewport.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left + element.clientLeft, top: box.top + element.clientTop,
        width: element.clientWidth, height: element.clientHeight,
        offset: element.scrollLeft, max: element.scrollWidth - element.clientWidth };
    });
    expect(rail.max, "This supplemental capture exercises real table overflow").toBeGreaterThan(0);
    const boxes = await Promise.all(targets.map(async (target) => {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      return box!;
    }));
    const left = Math.min(...boxes.map((box) => box.x));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    expect(right - left, "The chosen semantic columns fit together in this frame").toBeLessThanOrEqual(rail.width + 1);
    const desired = Math.max(0, Math.min(rail.max,
      rail.offset + (left + right) / 2 - (rail.left + rail.width / 2)));
    await this.page.mouse.move(rail.left + rail.width / 2, rail.top + rail.height / 2);
    await this.page.mouse.wheel(desired - rail.offset, 0);
    await expect.poll(async () => Math.abs(await viewport.evaluate((element) => element.scrollLeft) - desired)).toBeLessThanOrEqual(1);
    // Wheel dispatch is asynchronous. Observe actual scroll settling across
    // rendered frames; never assign scrollLeft or disable native motion.
    await expect.poll(() => viewport.evaluate(async (element) => {
      const before = element.scrollLeft;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return element.scrollLeft === before;
    })).toBe(true);
    await this.stable();
    for (const target of targets) await this.inView(target);
  }
  async task(trigger: Locator, title: string, state: string, afterCapture?: (dialog: Locator) => Promise<void>) {
    await activate(this.page, trigger);
    const dialog = this.page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await this.stable(dialog);
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), "Focus entered the actual task").toBe(true);
    await this.capture(state, "unsubmitted-task", `${title}; opened with Enter, no edits or submission`, dialog);
    await afterCapture?.(dialog);
    await activate(this.page, dialog.getByRole("button", { name: "关闭", exact: true }));
    await expect(dialog).toBeHidden();
    await this.stable();
    await expect(trigger).toBeFocused();
    this.interactions.push(`${title}: keyboard Enter open, focus inside, settled task capture, keyboard Close, focus returned to opener`);
  }
  finish() {
    expect(this.mutations, "Inventory interactions must not submit, publish, delete, send or change security settings").toEqual([]);
    expect(this.errors, "Inventory must not silently classify failed reads as empty").toEqual([]);
    this.completed = true;
  }
  async flush() {
    const path = this.info.outputPath("uiux-inventory", `manifest-${this.role}-${this.route}-${this.page.viewportSize()!.width}.json`);
    await mkdir(this.info.outputPath("uiux-inventory"), { recursive: true });
    await writeFile(path, JSON.stringify({
      schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA ?? null, project: this.info.project.name,
      route: `#${this.route}`, role: this.role, supplementalRoleView: this.role === "admin" && ["account-security", "templates"].includes(this.route), viewport: this.page.viewportSize(),
      result: this.completed ? "assertions-completed" : "incomplete-see-test-result",
      fixture: "isolated normal CLI, fresh database per test, synthetic public HTTP setup, real UI login, real API reads, no mocks",
      monitoringWindow: "installed after real UI login and before a fresh navigation to the captured hash, covering initial route requests and subsequent interactions",
      nextTranche: ["loading/paused/read-failure states", "short-height and 320px layouts", "populated inbox and outbox delivery states", "full journey acceptance and full keyboard traversal"],
      motion: "default full motion, finite natural task motion observed via settledTask; not a motion-design or reduced-motion acceptance",
      scope: "route/tab/section visual baseline and explicitly listed bounded interactions, not end-to-end journey completion",
      exclusions: ["live deployment/traffic/telemetry", "logged-out invitation/MFA journeys", "failure recovery and destructive submission journeys", "full keyboard traversal/screen reader/reduced-motion coverage", "fixture has no real credentials, feed/QR/raw config evidence"],
      captures: this.captures, interactions: this.interactions, unexpectedBrowserMutations: this.mutations, failedBrowserReads: this.errors,
    }, null, 2) + "\n");
  }
}
