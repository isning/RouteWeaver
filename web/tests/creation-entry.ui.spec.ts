import { test, expect } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";

for (const width of [1280, 390])
  test(`new local draft remains available while inventory is pending and failed at ${width}`, async ({
    page,
  }, info) => {
    page.setDefaultTimeout(5000);
    await page.setViewportSize({ width, height: 900 });
    let state: "pending" | "error" | "recovered" = "pending";
    const recoveredPaths = new Set<string>();
    const release: Array<() => void> = [];
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() !== "GET" &&
        /^\/api\/me\/(profiles|outputs)(\/|$)/.test(path)
      )
        writes.push(path);
    });
    await page.route(/\/api\/me\/(profiles|outputs)$/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (state === "pending")
        await new Promise<void>((resolve) => release.push(resolve));
      if (state === "error" && !recoveredPaths.has(path))
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic inventory unavailable" }),
        });
      // This journey recovers to an empty inventory. Other journeys can leave
      // revoked outputs in the shared demo account, so keep successful reads
      // synthetic too rather than depending on backend test execution order.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    try {
      await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
      await expect(
        page.getByRole("status", { name: "正在加载配置与客户端订阅", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("暂无订阅", { exact: true })).toHaveCount(0);
      const create = page.getByRole("button", {
        name: "新建分流配置",
        exact: true,
      });
      const expectTouchTarget = async (phase: string) => {
        const bounds = await create.boundingBox();
        await info.attach(`creation-target-${phase}-${width}`, {
          body: JSON.stringify(
            { viewportWidth: width, phase, bounds },
            null,
            2,
          ),
          contentType: "application/json",
        });
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      };
      await expect(create).toHaveCount(1);
      await expect(create).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath(`pending-${width}.png`) });
      await expectTouchTarget("pending");
      await create.click();
      await expect(page.getByLabel("配置名称", { exact: true })).toBeVisible();
      expect(writes).toEqual([]);
      await page
        .getByLabel("配置名称", { exact: true })
        .fill("Unsaved local draft");
      await page.getByRole("button", { name: "返回", exact: true }).click();
      const discard = page.getByRole("alertdialog", {
        name: "放弃未保存的修改？",
        exact: true,
      });
      await expect(discard).toBeVisible();
      await discard
        .getByRole("button", { name: "继续编辑", exact: true })
        .click();
      await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
        "Unsaved local draft",
      );
      await page.getByRole("button", { name: "返回", exact: true }).click();
      await discard
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "我的订阅", exact: true }),
      ).toBeVisible();
      const before = await create.elementHandle();
      await create.focus();
      state = "error";
      release.forEach((resolve) => resolve());
      await expect(
        page.getByText("暂时无法加载分流配置", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("暂时无法加载客户端订阅", { exact: true }),
      ).toBeVisible();
      await expect(create).toHaveCount(1);
      expect(
        await create.evaluate(
          (element, original) => element === original,
          before,
        ),
      ).toBe(true);
      await expect(create).toBeFocused();
      await expect(page.getByText("暂无订阅", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "重试配置", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "重新核对订阅", exact: true }),
      ).toBeVisible();
      await expect(create).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath(`error-${width}.png`) });
      await expectTouchTarget("error");
      await create.click();
      await expect(page.getByLabel("配置名称", { exact: true })).toBeVisible();
      expect(writes).toEqual([]);
      await page.getByRole("button", { name: "返回", exact: true }).click();
      const recovering = await create.elementHandle();
      // Opening the editor can refetch its Output query. Keep the two failure
      // seams independent: recovering profiles must not make an in-flight
      // Output retry succeed before its own visible retry action is tested.
      for (const [path, name] of [
        ["/api/me/profiles", "重试配置"],
        ["/api/me/outputs", "重新核对订阅"],
      ]) {
        const retry = page.getByRole("button", { name, exact: true });
        await expect(retry).toBeVisible();
        recoveredPaths.add(path);
        await retry.click();
      }
      await expect(page.getByText("暂无订阅", { exact: true })).toBeVisible();
      await expect(create).toHaveCount(1);
      expect(
        await create.evaluate(
          (element, original) => element === original,
          recovering,
        ),
      ).toBe(true);
      await expect(
        page.getByText("暂时无法加载分流配置", { exact: true }),
      ).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: info.outputPath(`recovered-${width}.png`),
      });
      await expectTouchTarget("recovered");
    } finally {
      state = "recovered";
      release.forEach((resolve) => resolve());
      await page.unrouteAll({ behavior: "wait" });
    }
  });
