import { settledTask } from "./ui-settled-task";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { templateFollowFixture } from "./template-follow-backend";
import type { Locator, Page, Response, TestInfo } from "@playwright/test";

const conflictMessage =
  "模板或草稿已变化，本次更新未应用。请重新检查后再应用。";
const connectionFailure = "无法连接服务。请检查网络后重试，当前输入已保留。";

function waitForPreview(page: Page, bindingId: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/me/template-bindings/${bindingId}/preview` &&
      response.request().method() === "POST",
  );
}

async function reviewed(sheet: Locator, response: Response) {
  expect(response.status()).toBe(200);
  const value = await response.json();
  expect(value).toMatchObject({
    compatible: true,
    hasUpdate: true,
    candidateVersion: 2,
    nativeChecked: false,
  });

  expect(value.preservedLocalEdits.length).toBeGreaterThan(0);
  await expect(sheet.getByText("可以更新到 v2", { exact: true })).toBeVisible();
  await expect(sheet.getByText("监听端口", { exact: true })).toBeVisible();
  await expect(sheet.getByText("策略组修改", { exact: true })).toBeVisible();
  await expect(
    sheet.getByRole("list", { name: "分流规则变更", exact: true }),
  ).toContainText("blocked.example");
  return value;
}

async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  surface?: Locator,
) {
  if (surface) await settledTask(surface);
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: false,
    // Explicit captures only. Keep access links and generated configurations
    // masked if a surrounding surface ever starts rendering them by default.
    mask: [
      page.locator('input, textarea, pre, code, canvas, a[href*="/feed/"]'),
    ],
  });
}

// Real browser -> private built UI -> isolated normal backend, no fulfilled API responses.
// The transport is interrupted/held only where explicitly noted below.
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
      const previews: Record<string, unknown>[] = [];
      const publications: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() !== "POST") return;
        if (path.endsWith(`/template-bindings/${f.bindingId}/apply`))
          applications++;
        if (path.endsWith(`/template-bindings/${f.bindingId}/preview`))
          previews.push(request.postDataJSON());
        if (/\/outputs\/[^/]+\/publish$/.test(path)) publications.push(path);
      });
      await page.goto("/#templates");
      await page.getByRole("tab", { name: "我的引用", exact: true }).click();
      const entry = () =>
        page.getByRole("button", {
          name: "检查更新 模板跟随草稿",
          exact: true,
        });
      const sheet = page.getByRole("dialog", {
        name: "模板更新 模板跟随草稿",
        exact: true,
      });
      const recheck = sheet.getByRole("button", {
        name: "检查此绑定的更新",
        exact: true,
      });
      const applyDraft = sheet.getByRole("button", {
        name: "应用到草稿",
        exact: true,
      });
      const result = sheet.getByRole("region", {
        name: "模板更新检查结果",
        exact: true,
      });
      const bindingChoice = sheet.getByRole("combobox", {
        name: "模板连接",
        exact: true,
      });
      // The real template task has an icon Close and a visible text Close in
      // its body (no TaskSheet footer). Select the text action, not its position.
      const closeComparison = sheet
        .getByRole("button", { name: "关闭", exact: true })
        .filter({ hasText: /^关闭$/ });
      const inspect = async (action: Locator = entry()) => {
        const response = waitForPreview(page, f.bindingId);
        await action.click();
        return reviewed(sheet, await response);
      };
      // Real isolated backend list, before opening the task surface.
      await expect(entry()).toBeVisible();
      await expect(
        page.getByRole("tab", { name: "我的引用", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await capture(page, info, `template-references-real-backend-${width}`);
      await inspect();
      // Dismissed comparison grants no write authority.
      await closeComparison.click();
      await expect(sheet).toHaveCount(0);
      expect(applications).toBe(0);
      expect(publications).toEqual([]);
      await f.unchanged();
      await inspect();
      // Change a real non-empty binding so recovery cannot pass by silently
      // resetting both controls and request input to their initial defaults.
      await bindingChoice.click();
      await page
        .getByRole("option", { name: "个人备用连接", exact: true })
        .click();
      await expect(applyDraft).toHaveCount(0);
      const first = await inspect(recheck);
      const selectedInput = {
        version: 2,
        bindings: { endpoints: { exit: "alternate" }, resources: {} },
      };
      expect(previews.at(-1)).toEqual(selectedInput);
      const edited = await f.draft();
      edited.ir.runtime.mixedPort = 10001;
      await f.save(edited); // Real concurrent local edit invalidates the review.
      const savedEdit = await f.draft();
      const rejection = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/template-bindings/${f.bindingId}/apply`) &&
          r.request().method() === "POST",
      );
      await applyDraft.click();
      const rejected = await rejection;
      expect(rejected.status()).toBe(409);
      expect(rejected.request().postDataJSON()).toEqual({
        ...selectedInput,
        previewDigest: first.previewDigest,
      });
      await expect(
        sheet.getByText(conflictMessage, { exact: true }),
      ).toBeVisible();
      await expect(sheet).toBeVisible();
      await expect(result).toHaveCount(0);
      await expect(applyDraft).toHaveCount(0);
      await expect(bindingChoice).toContainText("个人备用连接");
      await expect(recheck).toBeEnabled();
      await expect(recheck).toBeInViewport();
      expect(applications).toBe(1);
      expect(await f.draft()).toEqual(savedEdit);
      await f.unchanged();
      await capture(
        page,
        info,
        `template-follow-conflict-recovery-${width}`,
        sheet,
      );

      // A failed explicit recheck cannot resurrect the obsolete review. This
      // interrupts one transport request, never substitutes a backend payload.
      const previewPath = `**/api/me/template-bindings/${f.bindingId}/preview`;
      await page.route(previewPath, (route) => route.abort("failed"), {
        times: 1,
      });
      const failed = page.waitForEvent("requestfailed", {
        predicate: (request) =>
          new URL(request.url()).pathname ===
          `/api/me/template-bindings/${f.bindingId}/preview`,
      });
      await recheck.click();
      await failed;
      await expect(
        sheet.getByText(connectionFailure, { exact: true }),
      ).toBeVisible();
      await expect(applyDraft).toHaveCount(0);
      await expect(result).toHaveCount(0);
      await expect(bindingChoice).toContainText("个人备用连接");
      expect(previews.at(-1)).toEqual(selectedInput);
      expect(applications).toBe(1);

      // Hold only delivery to the actual backend. Repeated activation while
      // pending, and held Enter when the result arrives, grant no Apply intent.
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      await page.route(
        previewPath,
        async (route) => {
          entered();
          await gate;
          await route.continue();
        },
        { times: 1 },
      );
      const previewCount = previews.length;
      const freshResponse = waitForPreview(page, f.bindingId);
      let fresh: Awaited<ReturnType<typeof reviewed>>;
      try {
        if (width === 1440) {
          await recheck.focus();
          await page.keyboard.down("Enter");
        } else await recheck.dblclick();
        await pending;
        await expect(recheck).toBeDisabled();
        await expect(applyDraft).toHaveCount(0);
        if (width === 1440) await page.keyboard.down("Enter");
        release();
        fresh = await reviewed(sheet, await freshResponse);
        await expect(recheck).toBeEnabled();
        if (width === 1440) {
          await page.keyboard.down("Enter");
          await page.keyboard.up("Enter");
        }
      } finally {
        release();
        await page.keyboard.up("Enter");
      }
      expect(previews).toHaveLength(previewCount + 1);
      expect(previews.at(-1)).toEqual(selectedInput);
      expect(fresh.previewDigest).not.toBe(first.previewDigest);
      await expect(
        sheet.getByText(connectionFailure, { exact: true }),
      ).toHaveCount(0);
      await expect(
        sheet.getByText(conflictMessage, { exact: true }),
      ).toHaveCount(0);
      await expect(bindingChoice).toContainText("个人备用连接");
      await expect(applyDraft).toBeEnabled();
      expect(applications).toBe(1);
      expect(publications).toEqual([]);
      expect(await f.draft()).toEqual(savedEdit);
      await f.unchanged();
      await capture(page, info, `template-follow-rechecked-${width}`, sheet);
      const applied = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/template-bindings/${f.bindingId}/apply`) &&
          r.request().method() === "POST",
      );
      await applyDraft.click();
      const accepted = await applied;
      expect(accepted.status()).toBe(200);
      expect(accepted.request().postDataJSON()).toEqual({
        ...selectedInput,
        previewDigest: fresh.previewDigest,
      });
      const appliedNotice = page.getByText(
        "更新已应用到草稿，已发布订阅保留原版本",
        { exact: true },
      );
      await expect(appliedNotice).toBeVisible();
      await expect(sheet).toHaveCount(0);
      const updated = await f.draft();
      expect(updated.ir.groups[0].name).toBe("Personal group");
      expect(updated.ir.runtime.mixedPort).toBe(10001);
      expect(updated.ir.rules[0].match.value).toBe("blocked.example");
      expect(updated.ir.rules[1].action).toEqual({
        kind: "endpoint",
        ref: "alternate",
      });
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
          review.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
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
      await capture(page, info, `template-follow-review-${width}`, review);
      // Keep the immediate capture, then observe Sonner's normal removal.
      // Do not suppress the notification, disable motion, or extend timeouts.
      await expect(appliedNotice).toHaveCount(0);
      await settledTask(review);
      await expect(
        review.getByRole("button", {
          name: "确认更新「待更新订阅」",
          exact: true,
        }),
      ).toBeInViewport();
      await capture(
        page,
        info,
        `template-follow-review-${width}-clear`,
        review,
      );
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

test("cancelled template conflict recheck cannot reopen or apply a late result", async ({
  page,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await playwright.request.newContext({ baseURL });
  let release = () => {};
  try {
    const f = await templateFollowFixture(admin, page.request);
    let applications = 0;
    let publications = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "POST") return;
      if (path.endsWith(`/template-bindings/${f.bindingId}/apply`))
        applications++;
      if (/\/outputs\/[^/]+\/publish$/.test(path)) publications++;
    });
    await page.goto("/#templates");
    await page.getByRole("tab", { name: "我的引用", exact: true }).click();
    const sheet = page.getByRole("dialog", {
      name: "模板更新 模板跟随草稿",
      exact: true,
    });
    const initial = waitForPreview(page, f.bindingId);
    await page
      .getByRole("button", { name: "检查更新 模板跟随草稿", exact: true })
      .click();
    await reviewed(sheet, await initial);
    const edited = await f.draft();
    edited.ir.runtime.mixedPort = 10002;
    await f.save(edited);
    const saved = await f.draft();
    const rejection = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/me/template-bindings/${f.bindingId}/apply` &&
        response.request().method() === "POST",
    );
    await sheet
      .getByRole("button", { name: "应用到草稿", exact: true })
      .click();
    expect((await rejection).status()).toBe(409);
    await expect(
      sheet.getByText(conflictMessage, { exact: true }),
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "应用到草稿", exact: true }),
    ).toHaveCount(0);

    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route(
      `**/api/me/template-bindings/${f.bindingId}/preview`,
      async (route) => {
        entered();
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    const response = waitForPreview(page, f.bindingId);
    const recheck = sheet.getByRole("button", {
      name: "检查此绑定的更新",
      exact: true,
    });
    await recheck.click();
    await pending;
    await expect(recheck).toBeDisabled();
    // No changed UI choices in this journey, so Close dismisses immediately.
    // Dismiss the real task while its real preview request remains in flight.
    await sheet.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    release();
    const late = await response;
    expect(late.status()).toBe(200);
    await late.finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByText("更新已应用到草稿，已发布订阅保留原版本", { exact: true }),
    ).toHaveCount(0);
    expect(applications).toBe(1);
    expect(publications).toBe(0);
    expect(await f.draft()).toEqual(saved);
    await f.unchanged();
  } finally {
    release();
    await admin.dispose();
  }
});
