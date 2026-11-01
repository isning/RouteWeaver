import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { templateFollowFixture } from "./template-follow-backend";

// Real browser -> private built UI -> isolated normal backend, no fulfilled API responses.
// Validation below is the product's actual renderer/semantic review. Native
// parser evidence remains TestNativeTemplateFollowedProfileUpdate, not this UI.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [1440, 390])
  test(`real template follow conflict → review → validate → selected publication at ${width}`, async ({
    page,
    playwright,
    baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    try {
      const f = await templateFollowFixture(admin, page.request);
      let applications = 0;
      const publications: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() !== "POST") return;
        if (path.endsWith(`/template-bindings/${f.bindingId}/apply`))
          applications++;
        if (/\/outputs\/[^/]+\/publish$/.test(path)) publications.push(path);
      });
      await page.goto("/#templates");
      await page.getByRole("tab", { name: "我的引用", exact: true }).click();
      const entry = () =>
        page.getByRole("button", {
          name: "检查更新 · 模板跟随草稿",
          exact: true,
        });
      const sheet = page.getByRole("dialog", {
        name: "模板更新 · 模板跟随草稿",
        exact: true,
      });
      // Both the header icon and footer action are named “关闭”. Exercise the
      // explicit completion action, without positional first()/last() matching.
      const closeComparison = sheet
        .locator("[data-task-overlay-footer]")
        .getByRole("button", { name: "关闭", exact: true });
      const inspect = async () => {
        const response = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/template-bindings/${f.bindingId}/preview`) &&
            r.request().method() === "POST",
        );
        await entry().click();
        const value = await (await response).json();
        expect(value).toMatchObject({
          compatible: true,
          hasUpdate: true,
          nativeChecked: false,
        });
        expect(value.preservedLocalEdits.length).toBeGreaterThan(0);
        await expect(
          sheet.getByText("可以更新到 v2", { exact: true }),
        ).toBeVisible();
        await expect(
          sheet.getByText("监听端口", { exact: true }),
        ).toBeVisible();
        await expect(
          sheet.getByText("策略组修改", { exact: true }),
        ).toBeVisible();
        await expect(
          sheet.getByRole("list", { name: "分流规则变更", exact: true }),
        ).toContainText("blocked.example");
        return value;
      };
      await inspect();
      // Dismissed comparison grants no write authority.
      await closeComparison.click();
      await expect(sheet).toHaveCount(0);
      expect(applications).toBe(0);
      expect(publications).toEqual([]);
      await f.unchanged();
      const first = await inspect();
      const edited = await f.draft();
      edited.ir.runtime.mixedPort = 10001;
      await f.save(edited); // Real concurrent local edit invalidates the review.
      const savedEdit = await f.draft();
      const rejection = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/template-bindings/${f.bindingId}/apply`) &&
          r.request().method() === "POST",
      );
      await sheet
        .getByRole("button", { name: "应用到草稿", exact: true })
        .click();
      expect((await rejection).status()).toBe(409);
      await expect(
        sheet.getByText(
          "template or personal configuration changed; preview again before applying",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(sheet).toBeVisible();
      expect(await f.draft()).toEqual(savedEdit);
      await f.unchanged();
      await closeComparison.click();
      await expect(sheet).toHaveCount(0);
      const fresh = await inspect();
      expect(fresh.previewDigest).not.toBe(first.previewDigest);
      const applied = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/template-bindings/${f.bindingId}/apply`) &&
          r.request().method() === "POST",
      );
      await sheet
        .getByRole("button", { name: "应用到草稿", exact: true })
        .click();
      expect((await applied).status()).toBe(200);
      await expect(sheet).toHaveCount(0);
      const updated = await f.draft();
      expect(updated.ir.groups[0].name).toBe("Personal group");
      expect(updated.ir.runtime.mixedPort).toBe(10001);
      expect(updated.ir.rules[0].match.value).toBe("blocked.example");
      expect(applications).toBe(2);
      expect(publications).toEqual([]);
      await f.unchanged();

      await page.goto("/#subscriptions");
      const row = page.getByRole("group", {
        name: "客户端订阅 待更新订阅",
        exact: true,
      });
      const review = page.getByRole("dialog", {
        name: "检查订阅更新「待更新订阅」",
        exact: true,
      });
      const checkOutput = async () => {
        const response = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/profiles/${f.id}/preview`) &&
            r.request().method() === "POST",
        );
        await row
          .getByRole("button", { name: "检查更新", exact: true })
          .click();
        const value = await (await response).json();
        expect(value).toMatchObject({
          valid: true,
          previewScope: "output-update",
          outputId: f.outputs[0].id,
        });
        await expect(
          review.getByText("链接不变，其他订阅不受影响。", { exact: true }),
        ).toBeVisible();
        await expect(
          review.getByRole("list", { name: "分流规则变更", exact: true }),
        ).toContainText("blocked.example");
        return value;
      };
      await checkOutput();
      await review.getByRole("button", { name: "取消", exact: true }).click();
      await expect(review).toHaveCount(0);
      expect(publications).toEqual([]);
      await f.unchanged();
      const checked = await checkOutput();
      await page.screenshot({
        path: info.outputPath(`template-follow-review-${width}.png`),
        fullPage: false,
      });
      const publication = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/outputs/${f.outputs[0].id}/publish`) &&
          r.request().method() === "POST",
      );
      await review
        .getByRole("button", { name: "确认更新「待更新订阅」", exact: true })
        .click();
      expect((await publication).status()).toBe(200);
      await expect(review).toHaveCount(0);
      expect(publications).toEqual([
        `/api/me/outputs/${f.outputs[0].id}/publish`,
      ]);
      // Preview text omits the renderer feed's terminal newline.
      expect((await f.feed(f.outputs[0])).trimEnd()).toBe(
        checked.artifacts[0].content.trimEnd(),
      );
      expect(await f.feed(f.outputs[0])).not.toBe(f.before[0]);
      expect(await f.feed(f.outputs[1])).toBe(f.before[1]);
      await page.reload();
      await expect(row.getByText("已发布", { exact: true })).toBeVisible();
      expect(await f.feed(f.outputs[1])).toBe(f.before[1]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await admin.dispose();
    }
  });
