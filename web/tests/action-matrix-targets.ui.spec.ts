import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  NodeRecord,
  RouteRecord,
  HostRecord,
  CoreInstance,
  ManagedEndpoint,
  ServerDeployment,
  Service,
} from "../src/types";
import type { UserGroup } from "../src/access-policy-model";
import type { PublishedRoute } from "../src/PublishedRoutes";
// Existing typed fixture contracts: registered inventory and draft configuration,
// never live health, validation, application or production-persistence evidence.
const nodes: NodeRecord[] = [
  {
    id: "a",
    name: "主要连接端点 · 日常办公",
    host: "a.example.test",
    port: 1080,
    protocol: "socks",
  },
  {
    id: "b",
    name: "备用连接端点 · 欧洲与亚太团队长期协作",
    host: "b.example.test",
    port: 1080,
    protocol: "socks",
  },
];
const routes: RouteRecord[] = [
  {
    id: "r1",
    name: "日常办公链路配置",
    engine: "sing-box",
    hops: ["a"],
    userIds: [],
  },
  {
    id: "r2",
    name: "跨区域备用链路配置 · 欧洲与亚太团队",
    engine: "sing-box",
    hops: ["b"],
    userIds: [],
  },
];
const groups: UserGroup[] = [
  {
    id: "g1",
    name: "日常办公用户组",
    memberIds: [],
    serviceId: "standard",
    priority: 1,
  },
  {
    id: "g2",
    name: "跨区域协作用户组 · 欧洲与亚太远程办公团队",
    memberIds: [],
    serviceId: "standard",
    priority: 2,
  },
];
// Infrastructure records mirror typed server-endpoint/line-workflow fixtures.
// They are registered inventory/draft configuration, never runtime observations.
const hosts: HostRecord[] = [
  { id: "host", name: "协作服务器", address: "host.example.test" },
];
const instances: CoreInstance[] = [
  {
    id: "core-a",
    hostId: "host",
    name: "日常办公核心实例",
    adapterId: "routeweaver/sing-box",
    version: "1",
  },
  {
    id: "core-b",
    hostId: "host",
    name: "欧洲与亚太长期协作备用核心实例",
    adapterId: "routeweaver/sing-box",
    version: "1",
  },
];
const endpoints: ManagedEndpoint[] = instances.map((instance, i) => ({
  id: `entry-${i}`,
  name: i ? "跨区域备用监听端点" : "日常办公监听端点",
  instanceId: instance.id,
  connection: { protocol: "socks", host: "0.0.0.0", port: 1080 + i },
}));
const deployments: ServerDeployment[] = instances.map((instance, i) => ({
  id: `path-${i}`,
  name: i ? "欧洲与亚太长期协作备用转发路径" : "日常办公转发路径",
  status: "draft",
  diagnostics: [],
  updatedAt: "2026-10-27T08:00:00Z",
  ir: {
    schemaVersion: "1.0",
    id: `path-${i}`,
    topologyRevision: "r1",
    programs: [
      {
        instance,
        listener: endpoints[i],
        rules: [],
        resources: [],
        egress: [],
        defaultAction: { kind: "direct" },
      },
    ],
  },
}));
const published: PublishedRoute[] = deployments.map((deployment, i) => ({
  id: `line-${i}`,
  name: i ? "欧洲与亚太长期协作备用线路" : "日常办公线路",
  deploymentId: deployment.id,
  endpointIds: [endpoints[i].id],
  publicHost: `route-${i}.example.test`,
  publicPort: 443,
  status: "draft",
  diagnostics: [],
}));
const services: Service[] = [
  { id: "standard", name: "日常协作服务方案", quotaBytes: 107374182400, routeIds: [], cycle: { mode: "monthly" }, onlineIpLimit: 3, connectionLimit: 20 },
  { id: "extended", name: "欧洲与亚太团队长期协作服务方案", quotaBytes: 536870912000, routeIds: [], cycle: { mode: "anniversary" }, onlineIpLimit: 8, connectionLimit: 60 },
];
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "admin", name: "审查管理员", role: "admin" },
    csrfToken: "controlled-read-only",
  },
  "/state": {
    nodes,
    routes,
    users: [],
    capabilities: [
      { id: "sing-box", name: "sing-box", protocols: ["socks"], maxHops: 2 },
    ],
    revisions: [],
    deploymentAvailable: false,
  },
  "/hosts": hosts,
  "/core-instances": instances,
  "/managed-endpoints": endpoints,
  "/links": [],
  "/server-deployments": deployments,
  "/services": services,
  "/published-routes": published,
  "/settings": {},
  "/rates": [],
  "/user-groups": groups,
};
const cases = [
  { route: "nodes", name: "nodes", names: nodes.map((n) => n.name) },
  {
    route: "legacy-routes",
    name: "legacy-routes",
    names: routes.map((r) => r.name),
  },
  { route: "users", name: "user-groups", names: groups.map((g) => g.name) },
  {
    route: "servers",
    name: "core-instances",
    names: instances.map((i) => i.name!),
    tab: "核心实例 2",
  },
  {
    route: "servers",
    name: "managed-endpoints",
    names: endpoints.map((e) => e.name),
    tab: "监听端点 2",
  },
  {
    route: "routes",
    name: "forwarding-paths",
    names: deployments.map((d) => d.name),
  },
  {
    route: "published-routes",
    name: "route-registry",
    names: published.map((r) => r.name),
  },
];
async function setup(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Matrix QA requires loopback");
  const origin = new URL(baseURL).origin,
    unexpected: string[] = [];
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
        json: { detail: "Unsupported read-only matrix fixture request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}
async function contained(target: Locator, viewport: Locator) {
  const box = await target.boundingBox(),
    bounds = await viewport.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width + 1,
  );
}
for (const width of [320, 390, 1440])
  for (const surface of cases) {
    test(`${surface.name} retains action target at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      const unexpected = await setup(page);
      await page.goto(`/#${surface.route}`);
      if (surface.tab)
        await page.getByRole("tab", { name: surface.tab, exact: true }).click();
      const rows = surface.names.map((name) =>
        page
          .getByRole("row")
          .filter({ has: page.getByText(name, { exact: false }) }),
      );
      await expect(rows[1]).toBeVisible();
      const viewport = page
        .locator('[data-slot="table-container"]')
        .filter({ has: rows[0] });
      expect(await viewport.count()).toBe(1);
      // Capture the initial information hierarchy before horizontally scrolling
      // to action controls. These records are synthetic inventory, not health.
      if (surface.name === "core-instances") {
        await expect(
          page.getByRole("tab", { name: surface.tab!, exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await page.screenshot({
          path: info.outputPath(
            `core-instances-${width}-initial-inventory.png`,
          ),
        });
      }
      await viewport.scrollIntoViewIfNeeded();
      const overflowing = await viewport.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(overflowing).toBe(width < 700);
      await viewport.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await page.screenshot({
        path: info.outputPath(`${surface.name}-${width}-action-edge.png`),
      });
      for (const [index, name] of surface.names.entries()) {
        const row = rows[index];
        const group = row.getByRole("group", {
          name: `${name} 的操作`,
          exact: true,
        });
        // The complete row is already rendered, so absence is an immediate RED.
        expect(await group.count()).toBe(1);
        const label = group.getByText(name, { exact: true });
        if (overflowing) {
          await expect(label).toBeVisible();
          await contained(label, viewport);
          expect(
            await label.evaluate(
              (el) => el.scrollHeight <= el.clientHeight + 1,
            ),
          ).toBe(true);
          const buttons = group.getByRole("button");
          await viewport.evaluate((el) => {
            el.scrollLeft = 0;
          });
          await buttons.nth(0).focus();
          await page.keyboard.press("Shift+Tab");
          for (let i = 0; i < (await buttons.count()); i++) {
            await page.keyboard.press("Tab");
            await expect(buttons.nth(i)).toBeFocused();
            await contained(label, viewport);
            await contained(buttons.nth(i), viewport);
          }
        } else {
          await expect(label).toBeHidden();
          // Count actual visible target text, not an arbitrary first duplicate.
          let visible = 0;
          for (const text of await row.getByText(name, { exact: false }).all())
            if (await text.isVisible()) visible++;
          expect(visible).toBe(1);
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`${surface.name}-${width}-keyboard-context.png`),
      });
      expect(unexpected).toEqual([]);
    });
  }

type FocusVisibility = {
  bounds: { x: number; y: number; width: number; height: number };
  intersection: { x: number; y: number; width: number; height: number };
  ratio: number;
  clipped: { left: number; top: number; right: number; bottom: number };
  hits: { point: string; target: boolean }[];
};
async function focusVisibility(target: Locator): Promise<FocusVisibility> {
  return target.evaluate((element) => new Promise<FocusVisibility>((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      const bounds = entry.boundingClientRect, intersection = entry.intersectionRect;
      const points = [
        { point: "center", x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
        { point: "left", x: bounds.left + 1, y: bounds.top + bounds.height / 2 },
        { point: "right", x: bounds.right - 1, y: bounds.top + bounds.height / 2 },
        { point: "top", x: bounds.left + bounds.width / 2, y: bounds.top + 1 },
        { point: "bottom", x: bounds.left + bounds.width / 2, y: bounds.bottom - 1 },
      ];
      resolve({
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        intersection: { x: intersection.x, y: intersection.y, width: intersection.width, height: intersection.height },
        ratio: entry.intersectionRatio,
        clipped: {
          left: Math.max(0, intersection.left - bounds.left),
          top: Math.max(0, intersection.top - bounds.top),
          right: Math.max(0, bounds.right - intersection.right),
          bottom: Math.max(0, bounds.bottom - intersection.bottom),
        },
        hits: points.map(({ point, x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return { point, target: hit === element || (hit !== null && element.contains(hit)) };
        }),
      });
    });
    observer.observe(element);
  }));
}

// The tablet breakpoint frees the sidebar but retains real populated tables.
// Verify usable rows rather than assuming every table must fit without scrolling.
for (const surface of [
  { route: "services", name: "services", names: services.map((service) => service.name) },
  { route: "users", name: "user-groups", names: groups.map((group) => group.name) },
  { route: "nodes", name: "endpoints", names: nodes.map((node) => node.name) },
]) {
  test(`${surface.name} populated tablet controls do not overlap and remain reachable at 900`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const unexpected = await setup(page);
    await page.goto(`/#${surface.route}`);
    const groups = surface.names.map((name) => page.getByRole("group", { name: `${name} 的操作`, exact: true }));
    await expect(groups[1]).toBeVisible();
    const viewport = page.locator('[data-slot="table-container"]').filter({ has: groups[0] });
    await expect(viewport).toHaveCount(1);
    await viewport.scrollIntoViewIfNeeded();
    await info.attach(`${surface.name}-900-populated-inventory`, {
      body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png",
    });
    for (const [rowIndex, group] of groups.entries()) {
      const buttons = group.getByRole("button");
      expect(await buttons.count()).toBeGreaterThan(0);
      const boxes = await Promise.all((await buttons.all()).map((button) => button.boundingBox()));
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes[i]).not.toBeNull();
        expect(boxes[i]!.height).toBeGreaterThanOrEqual(44);
        expect(boxes[i]!.width).toBeGreaterThanOrEqual(44);
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!, b = boxes[j]!;
          const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          expect(overlapWidth <= 1 || overlapHeight <= 1).toBe(true);
        }
      }
      await buttons.first().focus();
      await page.keyboard.press("Shift+Tab");
      for (const [actionIndex, button] of (await buttons.all()).entries()) {
        await page.keyboard.press("Tab");
        await expect(button).toBeFocused();
        const geometry = await focusVisibility(button);
        const evidenceName = `${surface.name}-900-row-${rowIndex + 1}-action-${actionIndex + 1}`;
        await info.attach(`${evidenceName}-visibility`, {
          body: Buffer.from(JSON.stringify(geometry, null, 2)), contentType: "application/json",
        });
        await info.attach(`${evidenceName}-focused`, {
          body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
        });
        // Native scroll/intersection rounding can leave a 1/32 CSS px sliver.
        // Bound each clipped edge to 1/8 px instead of accepting an arbitrary
        // area ratio; a whole pixel of clipping or any blocked hit still fails.
        expect(Math.max(...Object.values(geometry.clipped))).toBeLessThanOrEqual(0.125);
        expect(geometry.bounds.width).toBeGreaterThanOrEqual(44);
        expect(geometry.bounds.height).toBeGreaterThanOrEqual(44);
        await contained(button, viewport);
        expect(geometry.hits.every((hit) => hit.target)).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await info.attach(`${surface.name}-900-keyboard-action-context`, {
      body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
    });
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
