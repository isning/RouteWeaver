import { test, expect, type Locator } from "@playwright/test";
import { openWorkspace } from "./ui-session";

// Layout/interaction regression only. Controlled HTTP preview/result fixtures do
// not establish encryption, backend restore correctness, or live-store isolation.
const warning = "备份包含当时的账号、二次验证、会话与订阅凭据。启用前，请复核备份后撤销过的权限和凭据。";
const target = `restore_${"a".repeat(43)}.db`;
const filename = `backup-${"longname".repeat(24)}.age`;
async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}
async function noClipping(locator: Locator) {
  expect(await locator.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)).toBe(true);
}
for (const width of [1440, 390]) {
  test(`backup controls keep a readable rail at ${width}px (controlled layout states)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await openWorkspace(page);
    await page.route("**/api/admin/backups/preview", (route) => route.fulfill({
      json: {
        manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
        digest: "layout-fixture", counts: { records: 1 }, restoreAvailable: true,
      },
    }));
    let writes = 0;
    await page.route("**/api/admin/backups/restore", (route) => {
      writes++;
      return route.fulfill({ status: 201, json: { status: "restored", target, activated: false } });
    });
    await page.goto("/#settings");
    await page.getByRole("tab", { name: "备份与恢复", exact: true }).click();
    const choose = page.getByRole("button", { name: "选择备份文件", exact: true });
    const password = page.getByLabel("备份密码", { exact: true });
    const fileBox = await box(choose);
    // Password's visible component includes the reveal button, not just its input.
    const passwordBox = await password.evaluate((node) => {
      const rect = node.parentElement!.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    });
    if (width === 1440) {
      // Accessible controls exist on baseline too: these fail on actual wide
      // geometry, rather than failing merely because a new class is absent.
      expect.soft(passwordBox.width, "layout-width: desktop password rail").toBeLessThanOrEqual(621);
      expect.soft(fileBox.width, "layout-width: desktop file intrinsic width").toBeLessThan(240);
      expect.soft(fileBox.width, "layout-width: desktop file versus rail").toBeLessThan(passwordBox.width / 2);
    } else {
      expect(Math.abs(fileBox.width - passwordBox.width)).toBeLessThanOrEqual(2);
      expect(fileBox.width).toBeGreaterThan(300);
      // Task actions retain a real touch target, not the old38px skin height.
      expect(fileBox.height).toBeGreaterThanOrEqual(44);
      expect(fileBox.height).toBeLessThanOrEqual(48);
    }
    expect(Math.abs(fileBox.x - passwordBox.x)).toBeLessThanOrEqual(2);
    await choose.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(choose).toBeFocused();
    await page.screenshot({ path: info.outputPath(`file-focus-${width}.png`) });
    const chooserEvent = page.waitForEvent("filechooser");
    await choose.press("Space");
    await (await chooserEvent).setFiles({ name: filename, mimeType: "application/octet-stream", buffer: Buffer.from("layout-only") });
    await expect(choose).toBeFocused();
    const selected = page.getByText(`${filename} · 11 B`, { exact: true });
    await expect(selected).toBeVisible();
    await noClipping(selected);
    await password.fill("layout-only-password");
    await page.getByRole("button", { name: "校验备份并查看影响", exact: true }).click();
    await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
    const guard = page.getByLabel("输入“恢复到新数据库”以确认", { exact: true });
    const restore = page.getByRole("button", { name: "恢复到新数据库", exact: true });
    const disclosure = page.getByText(warning, { exact: true });
    await expect(disclosure).toBeVisible();
    await expect(page.getByText("恢复到独立的新数据库，保留当前数据；服务切换需另行操作。", { exact: true })).toBeVisible();
    expect((await box(disclosure)).y + (await box(disclosure)).height).toBeLessThan((await box(guard)).y);
    const guardBox = await box(guard);
    expect.soft(guardBox.width, "layout-width: confirmation rail").toBeLessThanOrEqual(width === 1440 ? 621 : 326);
    expect(Math.abs(guardBox.x - passwordBox.x)).toBeLessThanOrEqual(2);
    for (const phrase of ["", "恢复", "RESTORE TO NEW STORE"]) {
      await guard.fill(phrase);
      await expect(restore).toBeDisabled();
    }
    await guard.fill("恢复到新数据库");
    await expect(restore).toBeEnabled();
    expect(writes).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: info.outputPath(`decision-${width}.png`), fullPage: true });
    await restore.click();
    await expect(page.getByText("已恢复到新数据库，尚未启用", { exact: true })).toBeVisible();
    const result = page.getByText(`目标：${target}。由运维人员停止服务后选择该数据库启动；当前服务未切换。`, { exact: true });
    await expect(result).toBeVisible();
    await noClipping(result);
    expect.soft((await box(result)).width, "layout-width: result rail").toBeLessThanOrEqual(621);
    expect(writes).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: info.outputPath(`success-${width}.png`), fullPage: true });
  });
}
