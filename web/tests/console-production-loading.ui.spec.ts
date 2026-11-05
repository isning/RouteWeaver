import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";

// Production Vite assets served by the real Go handler, with an isolated real
// account/database. No request routing: interception would disable browser cache.
// Timings describe this loopback CI process only, never the owner-private Site.
async function login(browser: Browser, url: string) {
  const setup = await browser.newContext({ baseURL: url });
  try {
    const page = await setup.newPage();
    await page.goto("/");
    await page.getByLabel("账号", { exact: true }).fill("routeweaver");
    await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
    await page
      .getByRole("button", { name: "进入工作空间", exact: true })
      .click();
    await waitForConfirmedWorkspace(page, "normal-ui-login");
    const cookies = (await setup.cookies(url)).filter(
      (cookie) => cookie.name === "routeweaver_session",
    );
    expect(cookies).toHaveLength(1);
    return cookies;
  } finally {
    await setup.close();
  }
}

async function observeDocument(page: Page, path: string) {
  const required = [
    "/api/auth/me",
    "/api/me/overview",
    "/api/me/outputs",
    "/api/me/profiles",
  ];
  const reads = required.map((path) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "GET",
    ),
  );
  await page.goto(path, { waitUntil: "load" });
  await waitForConfirmedWorkspace(page);
  await expect(page.getByText("暂无订阅", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "正在加载配置与客户端订阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新建分流配置", exact: true }),
  ).toBeEnabled();
  for (const response of await Promise.all(reads)) {
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    await response.finished();
  }
  // Font completion keeps the resource sample bounded to the initial viewport.
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    const resources = (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    ).map((entry) => ({
      path: new URL(entry.name).pathname,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }));
    return {
      readyObservedAt: performance.now(),
      navigation: {
        responseStart: navigation.responseStart,
        responseEnd: navigation.responseEnd,
        domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
        loadEventEnd: navigation.loadEventEnd,
        transferSize: navigation.transferSize,
        encodedBodySize: navigation.encodedBodySize,
      },
      paints: performance
        .getEntriesByType("paint")
        .map(({ name, startTime }) => ({ name, startTime })),
      resources,
    };
  });
}

for (const width of [1440, 390])
  test(`production console has bounded assets and reuses static cache at ${width}`, async ({
    browser,
    isolatedControlPlane,
  }, info) => {
    const url = isolatedControlPlane.url;
    const cookies = await login(browser, url);
    const context = await browser.newContext({
      baseURL: url,
      viewport: { width, height: 960 },
      reducedMotion: "reduce",
    });
    try {
      await context.addCookies(cookies);
      const page = await context.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.name));
      const cold = await observeDocument(page, "/#subscriptions");
      // A new document in the same context retains HTTP cache, not React's module
      // or query cache. A normal revisit avoids browser reload cache semantics.
      await page.goto("about:blank");
      const warm = await observeDocument(page, "/#subscriptions");
      await info.attach(`production-loading-${width}`, {
        contentType: "application/json",
        body: JSON.stringify(
          {
            scope:
              "Production build, actual Go HTTP handler, isolated synthetic account and empty inventories, unthrottled loopback CI, reduced motion. Cold = fresh browser context with only a valid session cookie; warm = new document with the same HTTP cache. No request interception, no owner data, no hosted-Site timing claim.",
            sourceCommit: process.env.GITHUB_SHA || null,
            browserVersion: browser.version(),
            viewport: { width, height: 960 },
            budgets: { rawJS: 850_000, rawCSS: 180_000 },
            cold,
            warm,
          },
          null,
          2,
        ),
      });
      const assets = (value: typeof cold) =>
        value.resources.filter((resource) =>
          resource.path.startsWith("/assets/"),
        );
      const coldAssets = assets(cold),
        warmAssets = assets(warm);
      expect(coldAssets.length).toBeGreaterThan(0);
      expect(
        coldAssets.some((resource) =>
          /Subscriptions-.*\.js$/.test(resource.path),
        ),
      ).toBe(true);
      expect(
        cold.resources.some((resource) =>
          /^\/(src|node_modules)\//.test(resource.path),
        ),
      ).toBe(false);
      expect(warmAssets.map((resource) => resource.path).sort()).toEqual(
        coldAssets.map((resource) => resource.path).sort(),
      );
      expect(coldAssets.every((resource) => resource.transferSize > 0)).toBe(
        true,
      );
      expect(warmAssets.every((resource) => resource.transferSize === 0)).toBe(
        true,
      );
      const rawJS = coldAssets
        .filter((resource) => resource.path.endsWith(".js"))
        .reduce((total, resource) => total + resource.decodedBodySize, 0);
      const rawCSS = coldAssets
        .filter((resource) => resource.path.endsWith(".css"))
        .reduce((total, resource) => total + resource.decodedBodySize, 0);
      // Coarse regression budgets from the measured current closure (765 KB JS,
      // 156 KB CSS), not elapsed-time SLAs or an assertion of acceptable UX.
      expect(rawJS).toBeGreaterThan(0);
      expect(rawJS).toBeLessThan(850_000);
      expect(rawCSS).toBeGreaterThan(0);
      expect(rawCSS).toBeLessThan(180_000);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  });
