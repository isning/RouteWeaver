import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { initialPassword, requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import {
  routeName,
  selectedName,
  serviceName,
  serviceCenterFixture,
} from "./service-center-backend";

// Credentials and feed URLs stay in memory: no trace, screenshot or video.
test.use({ trace: "off", screenshot: "off", video: "off" });
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 80; i++) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Required service-center action is not reachable by Tab");
}
async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}
async function fits(page: Page, dialog?: Locator) {
  // Visibility starts before the finite entrance transition has settled.
  // Measure the final task surface without changing the viewport bounds.
  if (dialog) await settledTask(dialog);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  if (dialog) {
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
  }
}
for (const width of [1440, 390]) {
  test(`E09 invited service center keyboard delivery and selected-link rotation at ${width}px`, async ({
    page,
    request,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const owner = await playwright.request.newContext({ baseURL });
    const other = await playwright.request.newContext({ baseURL });
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const f = await serviceCenterFixture(request, owner, other, anonymous);
      await page.goto("/#subscriptions");
      await page.getByLabel("账号", { exact: true }).fill(f.account.username);
      await page.getByLabel("密码", { exact: true }).fill(initialPassword);
      const loggedIn = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/auth/login") &&
          r.request().method() === "POST",
      );
      await activate(
        page,
        page.getByRole("button", { name: "进入工作空间", exact: true }),
      );
      expect((await loggedIn).status()).toBe(200);
      const row = page.getByRole("group", {
        name: `客户端订阅 ${selectedName}`,
        exact: true,
      });
      await expect(row).toBeVisible();
      const mutations: { path: string; method: string }[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
          mutations.push({ path, method: request.method() });
      });
      expect(
        (await (await page.request.get("/api/auth/me")).json()).user.role,
      ).toBe("user");
      await expect(page.getByText(serviceName, { exact: true })).toBeVisible();
      await expect(
        page.getByText("100 MiB", { exact: true }).first(),
      ).toBeVisible();
      await activate(
        page,
        page.getByRole("button", { name: "用量与周期明细", exact: true }),
      );
      await expect(page.getByText("UTC+8", { exact: true })).toBeVisible();
      await expect(page.getByText(/（还有 .+）/)).toBeVisible();
      await expect(
        page.getByText("本周期实际流量", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("服务到期", { exact: true })).toBeVisible();
      await activate(
        page,
        page.getByRole("button", { name: "平台提供的线路 · 1", exact: true }),
      );
      await expect(
        page.getByRole("heading", { name: routeName, exact: true }),
      ).toBeVisible();
      await fits(page);
      const getSubscription = row.getByRole("button", {
        name: "获取订阅",
        exact: true,
      });
      await activate(page, getSubscription);
      const access = page.getByRole("dialog", {
        name: `获取「${selectedName}」`,
        exact: true,
      });
      await expect(access).toBeVisible();
      await fits(page, access);
      const link = access.getByRole("textbox", {
        name: "订阅链接",
        exact: true,
      });
      const oldURL = await link.inputValue();
      expect(new URL(oldURL).origin).toBe(new URL(baseURL!).origin);
      expect(new URL(oldURL).pathname === f.outputs[0].feedPath).toBe(true);
      const downloaded = page.waitForEvent("download");
      await activate(
        page,
        access.getByRole("link", { name: "下载配置", exact: true }),
      );
      const download = await downloaded;
      expect(await download.failure()).toBeNull();
      const stream = await download.createReadStream();
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(f.ownBefore)).toBe(true);
      await download.delete();
      await page.keyboard.press("Escape");
      await expect(access).toBeHidden();
      await expect(getSubscription).toBeFocused();

      const menu = row.getByRole("button", {
        name: `管理 ${selectedName}`,
        exact: true,
      });
      const openRotation = async () => {
        await activate(page, menu);
        const item = page.getByRole("menuitem", {
          name: "更换订阅链接",
          exact: true,
        });
        // Menus use roving keyboard focus, not Tab traversal.
        for (let i = 0; i < 8; i++) {
          if (
            await item.evaluate((element) => element === document.activeElement)
          )
            break;
          await page.keyboard.press("ArrowDown");
        }
        await expect(item).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await openRotation();
      const confirmation = page.getByRole("alertdialog", {
        name: `更换「${selectedName}」的订阅链接？`,
        exact: true,
      });
      await expect(
        confirmation.getByText(
          "旧链接将停止获取更新，需要在客户端替换链接。已经下载的配置无法收回。",
          { exact: true },
        ),
      ).toBeVisible();
      await fits(page, confirmation);
      await page.keyboard.press("Escape");
      await expect(confirmation).toBeHidden();
      expect((await f.feed(f.outputs[0].feedPath)).equals(f.ownBefore)).toBe(
        true,
      );
      await f.unchangedOthers();
      expect(mutations).toEqual([]);

      await openRotation();
      const rotated = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/outputs/${f.outputs[0].id}/rotate`) &&
          r.request().method() === "POST",
      );
      await activate(
        page,
        confirmation.getByRole("button", { name: "更换链接", exact: true }),
      );
      const result = await rotated;
      expect(result.status()).toBe(200);
      const nextPath = (await result.json()).feedPath;
      await expect(confirmation).toBeHidden();
      await f.verifyRotation(nextPath);
      // Rotation opens the replacement access task itself; do not try to
      // activate an inert background action while that task owns focus.
      await expect(access).toBeVisible();
      await expect
        .poll(
          async () => new URL(await link.inputValue()).pathname === nextPath,
        )
        .toBe(true);
      await fits(page, access);
      await page.keyboard.press("Escape");
      await expect(access).toBeHidden();
      await activate(page, getSubscription);
      await expect(access).toBeVisible();
      await expect
        .poll(
          async () => new URL(await link.inputValue()).pathname === nextPath,
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(getSubscription).toBeFocused();
      expect(mutations).toEqual([
        { path: `/api/me/outputs/${f.outputs[0].id}/rotate`, method: "POST" },
      ]);
    } finally {
      await Promise.all([
        owner.dispose(),
        other.dispose(),
        anonymous.dispose(),
      ]);
    }
  });
}
