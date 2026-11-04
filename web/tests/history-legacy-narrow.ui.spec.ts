import { settledTask } from "./ui-settled-task";
import { test, expect, type Page } from "@playwright/test";

// Synthetic HTTP / actual App geometry and keyboard checks, not backend proof.
test.use({ trace: "off", screenshot: "off", video: "off" });
import { historyLegacyFixtures, historyLegacyName as name } from "./history-legacy-fixture";
async function setup(page: Page) {
  const base = test.info().project.use.baseURL;
  if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Controlled layout requires loopback");
  const unexpected: string[] = [];
  const fixtures = historyLegacyFixtures;
  await page.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin) { unexpected.push("external request"); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = url.pathname.slice(4);
    if (request.method() !== "GET" || !(key in fixtures)) {
      unexpected.push(`${request.method()} ${key}`);
      return route.fulfill({ status: 503, json: { message: "Unexpected controlled request" } });
    }
    return route.fulfill({ json: fixtures[key] });
  });
  return unexpected;
}
async function fits(page: Page) {
  await settledTask(page.getByRole("dialog"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}
for (const width of [320, 390, 640]) {
  test(`activity historical detail repeated keyboard dismissal at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const unexpected = await setup(page);
    await page.goto("/#activity");
    const opener = page.getByRole("button", { name: "查看", exact: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await opener.click();
      const detail = page.getByRole("dialog", { name: `${name} · 生成记录` });
      await expect(detail.getByText("此处展示当时保存的配置记录。检查当前配置请重新校验；服务器应用情况请查看节点确认状态。")).toBeVisible();
      await fits(page);
      if (attempt === 0) await page.screenshot({ path: info.outputPath(`activity-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(detail).not.toBeVisible();
      await expect(opener).toBeFocused();
    }
    expect(unexpected).toEqual([]);
  });
  test(`legacy route retained draft and exact nested cancel focus at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const unexpected = await setup(page);
    await page.goto("/#legacy-routes");
    const opener = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await opener.click();
    const editor = page.getByRole("dialog", { name: `编辑链路配置 ${name}` });
    const field = editor.getByRole("textbox", { name: "链路配置名称" });
    await field.fill("保留的跨区域链路草稿");
    const close = editor.getByRole("button", { name: "关闭", exact: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await close.click();
      const review = page.getByRole("alertdialog", { name: "放弃未保存的链路配置修改？" });
      await expect(review.getByRole("button", { name: "继续编辑" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(review).not.toBeVisible();
      await expect(close).toBeFocused();
      await expect(field).toHaveValue("保留的跨区域链路草稿");
      await fits(page);
    }
    await field.scrollIntoViewIfNeeded();
    await expect(field).toBeInViewport();
    await editor.getByRole("button", { name: "保存草稿" }).scrollIntoViewIfNeeded();
    await expect(editor.getByRole("button", { name: "保存草稿" })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`legacy-${width}.png`) });
    expect(unexpected).toEqual([]);
  });
}
