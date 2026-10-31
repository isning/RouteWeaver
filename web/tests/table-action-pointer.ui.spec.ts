import { test, expect, type Page } from "@playwright/test";

// Actual application views with read-only API fixtures. These checks establish
// rendering/keyboard context, not backend persistence or deployment behavior.
test.use({ trace: "off", screenshot: "off", video: "off" });
const names = ["日常连接订阅", "备用连接 · 长期维护的欧洲与亚太跨区域订阅来源"];
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "review-admin", name: "审查管理员", role: "admin" },
    csrfToken: "local-ui-fixture",
  },
  "/state": {
    users: names.map((name, i) => ({
      id: `u${i}`,
      name,
      enabled: true,
      quotaBytes: 107374182400,
    })),
    nodes: [],
    routes: [],
    revisions: [],
    capabilities: [],
  },
  "/services": [],
  "/settings": {},
  "/published-routes": [],
  "/rates": [],
  "/user-groups": [],
  "/me/sources": names.map((name, i) => ({
    id: `s${i}`,
    name,
    kind: "text",
    enabled: true,
    revision: "accepted-1",
    snapshot: {
      endpoints: [
        {
          id: `n${i}`,
          name,
          region: "JP",
          connection: {
            protocol: "socks",
            host: `192.0.2.${10 + i}`,
            port: 1080,
          },
        },
      ],
    },
    nodeCount: 1,
    refreshStatus: "accepted",
    updatedAt: "2026-10-27T08:00:00Z",
  })),
  "/me/resources": [...names, undefined].map((name, i) => ({
    id: name ? `r${i}` : "unnamed-rule-resource",
    name,
    revision: "1",
    format: "mihomo-yaml",
    behavior: "domain",
    location: "inline",
    updatePolicy: "pinned",
    acceptedVersion: "accepted-1",
    sizeBytes: 2450,
    canRefresh: i === 1,
  })),
  "/templates": [
    {
      id: "short",
      name: "工作与浏览分流",
      kind: "client-profile",
      version: 2,
      publishedAt: "2026-10-27T08:00:00Z",
      spec: { groups: [], rules: [] },
    },
    {
      id: "long",
      name: "按地区整理并去除重复节点",
      kind: "processing-preset",
      version: 1,
      publishedAt: "2026-10-27T08:00:00Z",
      spec: { steps: [] },
    },
  ],
  "/me/template-bindings": [],
  "/me/profiles": [],
  "/me/collections": [],
};
const openedSource = (
  fixtures["/me/sources"] as Array<Record<string, unknown>>
)[0];
fixtures["/me/sources/s0"] = openedSource;
fixtures["/me/sources/s0/reveal"] = {
  ...openedSource,
  content: "socks5://192.0.2.10:1080#日常连接订阅",
};

async function setup(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Controlled layout QA requires loopback");
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
        json: { detail: "Unexpected controlled layout request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}

// Both clicks use actual pointer events at the intersection of the button,
// clipping table and viewport. No forced dispatch or outside-clip coordinate.
for (const mode of ["visible-clipped", "fully-right"] as const) {
  test(`source edit opens from ${mode} native pointer at short viewport`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 640, height: 320 });
    const unexpected = await setup(page);
    await page.goto("/#sources");
    const edit = page.getByRole("button", {
      name: `编辑 ${names[0]}`,
      exact: true,
    });
    await expect(edit).toBeVisible();
    // Vertical wheel setup does not focus or activate the row action.
    for (let i = 0; i < 8; i++) {
      const r = await edit.boundingBox();
      expect(r).not.toBeNull();
      if (r!.y >= 60 && r!.y + r!.height <= 300) break;
      await page.mouse.move(320, 250);
      await page.mouse.wheel(
        0,
        r!.y + r!.height > 300 ? r!.y + r!.height - 260 : r!.y - 70,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    }
    const viewport = page.locator('[data-slot="table-container"]').first();
    if (mode === "fully-right") {
      const t = await viewport.boundingBox();
      expect(t).not.toBeNull();
      await page.mouse.move(t!.x + 40, Math.max(100, Math.min(260, t!.y + 40)));
      await page.mouse.wheel(1200, 0);
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(0);
    }
    const before = await edit.boundingBox(),
      clip = await viewport.boundingBox();
    expect(before).not.toBeNull();
    expect(clip).not.toBeNull();
    const left = Math.max(0, before!.x, clip!.x + 1),
      right = Math.min(
        640,
        before!.x + before!.width,
        clip!.x + clip!.width - 1,
      );
    const top = Math.max(60, before!.y, clip!.y),
      bottom = Math.min(
        304,
        before!.y + before!.height,
        clip!.y + clip!.height,
      );
    expect(right).toBeGreaterThan(left);
    expect(bottom).toBeGreaterThan(top);
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    expect(
      await edit.evaluate((el, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit === el || (!!hit && el.contains(hit));
      }, point),
    ).toBe(true);
    if (mode === "visible-clipped")
      expect(before!.x + before!.width).toBeGreaterThan(clip!.x + clip!.width);
    const startScroll = await viewport.evaluate((el) => el.scrollLeft);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    const afterDown = await edit.boundingBox(),
      afterScroll = await viewport.evaluate((el) => el.scrollLeft);
    await page.mouse.up();
    await info.attach("pointer-geometry", {
      body: JSON.stringify({
        mode,
        before,
        clip,
        point,
        startScroll,
        afterDown,
        afterScroll,
      }),
      contentType: "application/json",
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "来源名称", exact: true }),
    ).toHaveValue(names[0]);
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              a.effect?.getTiming().iterations !== Infinity,
          )
          .map((a) => a.finished.catch(() => {})),
      );
    });
    await page.screenshot({ path: info.outputPath(`${mode}-after-click.png`) });
    expect(afterDown!.x).toBeCloseTo(before!.x, 1);
    expect(afterDown!.y).toBeCloseTo(before!.y, 1);
    expect(afterScroll).toBe(startScroll);
    expect(unexpected).toEqual([]);
  });
}
