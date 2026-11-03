import { test, expect, type Page } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";
import { emptyProfile } from "../src/model";

// Controlled Vite DEVELOPMENT-module observations, never production/Site latency.
// Uses normal demo login, a new document, and intercept-controlled gates; no sleeps.
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const profile = {
  ...emptyProfile(),
  id: "loading-profile",
  name: "Loading test profile",
};
const output = {
  id: "loading-output",
  name: "Loading test client",
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
  delivery: "feed",
};
async function inventories(
  page: Page,
  gate?: ReturnType<typeof barrier>,
  withOutput = false,
) {
  const reads = new Set<string>();
  await page.route(/\/api\/me\/(profiles|outputs)$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    reads.add(new URL(route.request().url()).pathname);
    if (gate) await gate.promise;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        route.request().url().endsWith("/profiles")
          ? [profile]
          : withOutput
            ? [output]
            : [],
      ),
    });
  });
  return reads;
}
for (const width of [1440, 390])
  test(`controlled module-to-data-to-content loading at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openWorkspace(page);
    const module = barrier(),
      data = barrier();
    const reads = await inventories(page, data);
    let moduleRequests = 0;
    await page.route(/\/src\/Subscriptions\.tsx(?:\?.*)?$/, async (route) => {
      moduleRequests++;
      await module.promise;
      await route.continue();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("status", { name: "正在打开页面", exact: true }),
      ).toBeVisible();
      await expect.poll(() => moduleRequests).toBeGreaterThan(0);
      const shell = await page.getByRole("main").boundingBox();
      await page.evaluate(() => performance.mark("controlled-module-pending"));
      await expect(page.locator('[data-slot="skeleton"]').first()).toHaveCSS(
        "animation-name",
        "none",
      );
      await info.attach(`module-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      module.release();
      await expect(
        page.getByRole("status", {
          name: "正在加载配置与客户端订阅",
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(() => [...reads].sort())
        .toEqual(["/api/me/outputs", "/api/me/profiles"]);
      await expect(page.getByText("暂无订阅", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "新建分流配置", exact: true }),
      ).toBeEnabled();
      await page.evaluate(() => performance.mark("controlled-data-pending"));
      await info.attach(`data-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      data.release();
      await expect(
        page.getByRole("article", {
          name: `分流配置 ${profile.name}`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("status", {
          name: "正在加载配置与客户端订阅",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.evaluate(() => performance.mark("controlled-route-ready"));
      const ready = await page.getByRole("main").boundingBox();
      expect(shell).not.toBeNull();
      expect(ready).not.toBeNull();
      for (const key of ["x", "y", "width"] as const)
        expect(Math.abs(shell![key] - ready![key])).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await info.attach(`content-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await info.attach(`controlled-dev-observations-${width}`, {
        contentType: "application/json",
        body: JSON.stringify(
          await page.evaluate(() => ({
            condition:
              "Vite development modules; authorized document reload; routing disables HTTP cache; artificial module/data barriers released by assertions; reduced motion. Not production or hosted-Site latency.",
            paints: performance
              .getEntriesByType("paint")
              .map(({ name, startTime }) => ({ name, startTime })),
            marks: performance
              .getEntriesByType("mark")
              .filter((e) => e.name.startsWith("controlled-"))
              .map(({ name, startTime }) => ({ name, startTime })),
            staticResources: (
              performance.getEntriesByType(
                "resource",
              ) as PerformanceResourceTiming[]
            )
              .filter((e) => /\.(?:tsx?|js|css)(?:\?|$)/.test(e.name))
              .map((e) => ({
                path: new URL(e.name).pathname,
                duration: e.duration,
                transferSize: e.transferSize,
                encodedBodySize: e.encodedBodySize,
              })),
          })),
          null,
          2,
        ),
      });
    } finally {
      module.release();
      data.release();
    }
  });
test("a held optional route import cannot replace newer navigation", async ({
  page,
}) => {
  await openWorkspace(page);
  const gate = barrier();
  let requested = false;
  await page.route(/\/src\/Sources\.tsx(?:\?.*)?$/, async (route) => {
    requested = true;
    await gate.promise;
    await route.continue();
  });
  try {
    await navigateWorkspace(page, "订阅来源");
    await expect.poll(() => requested).toBe(true);
    await expect(
      page.getByRole("status", { name: "正在打开页面", exact: true }),
    ).toBeVisible();
    await navigateWorkspace(page, "我的订阅");
    await expect(
      page.getByRole("heading", { name: "我的订阅", level: 1, exact: true }),
    ).toBeVisible();
    const delivered = page.waitForResponse((response) =>
      /\/src\/Sources\.tsx(?:\?|$)/.test(response.url()),
    );
    gate.release();
    await delivered;
    await expect(
      page.getByRole("heading", { name: "我的订阅", level: 1, exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe("#subscriptions");
  } finally {
    gate.release();
  }
});
test("an interrupted QR module preserves the link, copy and Close", async ({
  page,
  context,
}) => {
  await openWorkspace(page);
  await inventories(page, undefined, true);
  await page.route(
    /\/api\/me\/outputs\/loading-output\/access(?:\?.*)?$/,
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          delivery: "feed",
          feedPath: "/feed/nonfunctional-loading-test",
        }),
      }),
  );
  let blockedQR = 0;
  await page.route(/\/node_modules\/.*qrcode.*\.js(?:\?.*)?$/, (route) => {
    blockedQR++;
    return route.abort("failed");
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.reload();
  await page.getByRole("button", { name: "获取订阅", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: `获取「${output.name}」`,
    exact: true,
  });
  await expect.poll(() => blockedQR).toBeGreaterThan(0);
  await expect(
    dialog.getByText("二维码暂时无法加载，请复制订阅链接。", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "订阅链接", exact: true }),
  ).toHaveValue(new URL("/feed/nonfunctional-loading-test", page.url()).href);
  await dialog
    .getByRole("button", { name: "复制订阅链接", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    new URL("/feed/nonfunctional-loading-test", page.url()).href,
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
