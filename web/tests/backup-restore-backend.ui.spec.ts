import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as createRequest, type Locator, type Page, type TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { settledTask } from "./ui-settled-task";
import {
  backupPassword,
  backupSession,
  expectFreshRestore,
  requireBackupLoopback,
  seedBackupSentinel,
} from "./backup-restore-backend";

async function capture(page: Page, info: TestInfo, name: string, surface: Locator, fullPage = true) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No horizontal page overflow").toBe(true);
  expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "Backup task content fits without horizontal overflow").toBe(true);
  await page.screenshot({
    path: info.outputPath(`${name}.png`), fullPage,
    // Password fields only, scoped to the current task. Keep filename, recovery
    // copy, confirmation text and the safe restored basename fully readable.
    mask: [surface.locator('input[type="password"]')],
  });
}

async function uncovered(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || !!hit && element.contains(hit);
  }), "The final restore action is not covered").toBe(true);
}

// Real HTTP throughout, with test-owned normal CLIs and synthetic state only.
// No archive/credential payloads in traces, videos or automatic screenshots.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [1440, 390]) {
  test(`OPS01 downloaded backup rejects a wrong password and restores without activating at ${width}`, async ({
    page,
    isolatedControlPlane,
  }, info) => {
    requireBackupLoopback(isolatedControlPlane.url);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const directory = await mkdtemp(join(tmpdir(), "routeweaver-ops01-"));
    try {
      let inspections = 0;
      let restores = 0;
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const path = new URL(request.url()).pathname;
        if (path === "/api/admin/backups/preview") inspections++;
        if (path === "/api/admin/backups/restore") restores++;
      });
      await page.goto("/");
      await page.getByLabel("账号", { exact: true }).fill("routeweaver");
      await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
      await page
        .getByRole("button", { name: "进入工作空间", exact: true })
        .click();
      await waitForConfirmedWorkspace(page, "normal-ui-login");
      const headers = await backupSession(page.request);
      const sentinel = await seedBackupSentinel(page.request, headers);
      await page.goto("/#settings");
      await page.getByRole("tab", { name: "备份与恢复", exact: true }).click();
      const restoreSection = page.getByRole("region", { name: "恢复备份设置", exact: true });
      await page
        .getByRole("button", { name: "创建加密备份", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "创建加密备份",
        exact: true,
      });
      await dialog
        .getByLabel("设置备份密码", { exact: true })
        .fill(backupPassword);
      await dialog
        .getByLabel("再次输入密码", { exact: true })
        .fill(backupPassword);
      await expect(dialog.getByText("备份包含账号与订阅凭据，仅下载到你的设备，不发送到第三方。请将文件与密码分开保管；忘记密码无法恢复。", { exact: true }))
        .toBeVisible();
      await settledTask(page.locator('[data-slot="dialog-overlay"]'));
      await capture(page, info, `backup-export-decision-${width}`, dialog, false);
      const downloadEvent = page.waitForEvent("download");
      await dialog
        .getByRole("button", { name: "加密并下载", exact: true })
        .click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(
        /^routeweaver-\d{4}-\d{2}-\d{2}\.age$/,
      );
      const filename = download.suggestedFilename();
      const file = join(directory, filename);
      await download.saveAs(file);
      expect(await download.failure()).toBeNull();
      expect((await readFile(file)).subarray(0, 30).toString()).toContain(
        "age-encryption.org",
      );
      await expect(dialog).not.toBeVisible();
      await sentinel.changeAfterBackup();
      // Let the actual export feedback finish before reviewing the next decision.
      await expect(page.getByText("加密备份已准备好，请保管好文件和密码", { exact: true })).not.toBeVisible();
      const chooserEvent = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "选择备份文件", exact: true })
        .click();
      await (await chooserEvent).setFiles(file);
      expect(inspections, "Selecting the downloaded file does not upload it").toBe(0);
      expect(restores).toBe(0);
      const password = page.getByLabel("备份密码", { exact: true });
      const inspect = page.getByRole("button", {
        name: "校验备份并查看影响",
        exact: true,
      });
      await password.fill("wrong-synthetic-passphrase");
      const rejectedEvent = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/admin/backups/preview" &&
          r.request().method() === "POST",
      );
      await inspect.click();
      expect((await rejectedEvent).status()).toBe(400);
      await expect(restoreSection.getByRole("alert")).toContainText(
        "备份无法验证。请核对密码，并确认文件完整后重试。",
      );
      await expect(
        page.getByText("文件校验通过", { exact: true }),
      ).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "恢复到新数据库", exact: true }),
      ).not.toBeVisible();
      await expect(password).toHaveValue("wrong-synthetic-passphrase");
      await expect(restoreSection.getByText(filename, { exact: true })).toBeVisible();
      expect(inspections).toBe(1);
      expect(restores).toBe(0);
      await expect(inspect).toBeEnabled();
      await capture(page, info, `backup-password-rejected-${width}`, restoreSection);
      await password.fill(backupPassword);
      await expect(restoreSection.getByRole("alert")).toHaveCount(0);
      const inspectedEvent = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/admin/backups/preview" &&
          r.request().method() === "POST",
      );
      await inspect.click();
      const inspected = await inspectedEvent;
      expect(inspected.status()).toBe(200);
      expect(await inspected.json()).toMatchObject({
        restoreAvailable: true,
        impact: { mode: "fresh-target", replacesLiveStore: false, requiresRestart: true },
        manifest: { containsSecrets: true },
      });
      await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
      await expect(
        page.getByText("恢复到独立的新数据库，保留当前数据；服务切换需另行操作。", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(restoreSection.getByText("备份包含当时的账号、二次验证、会话与订阅凭据。启用前，请复核备份后撤销过的权限和凭据。", { exact: true }))
        .toBeVisible();
      await restoreSection.getByText("备份详情", { exact: true }).click();
      await expect(restoreSection.getByRole("row").filter({ hasText: "来源" })).toContainText("1");
      const confirmation = page.getByLabel("输入“恢复到新数据库”以确认", {
        exact: true,
      });
      const restore = page.getByRole("button", {
        name: "恢复到新数据库",
        exact: true,
      });
      await expect(restore).toBeDisabled();
      await confirmation.fill("RESTORE TO NEW STORE");
      await expect(restore).toBeDisabled();
      await confirmation.fill("恢复到新数据库");
      await expect(restore).toBeEnabled();
      expect(inspections).toBe(2);
      expect(restores, "Inspection and typing confirmation do not restore").toBe(0);
      await confirmation.press("Tab");
      await expect(restore).toBeFocused();
      await uncovered(restore);
      await capture(page, info, `backup-restore-decision-${width}`, restoreSection);
      const restoredEvent = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/admin/backups/restore" &&
          r.request().method() === "POST",
      );
      await restore.press("Enter");
      const restored = await restoredEvent;
      expect(restored.status()).toBe(201);
      const result = await restored.json();
      expectFreshRestore(result);
      await expect(
        page.getByText("已恢复到新数据库，尚未启用", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          `目标：${result.target}。由运维人员停止服务后选择该数据库启动；当前服务未切换。`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(password).toHaveValue("");
      await expect(page.getByText("未选择文件", { exact: true })).toBeVisible();
      await expect(restore).not.toBeVisible();
      expect(restores).toBe(1);
      await capture(page, info, `backup-restored-inactive-${width}`, restoreSection);
      const target = await isolatedControlPlane.restore(result.target);
      const reader = await createRequest.newContext({ baseURL: target.url });
      try {
        await sentinel.expectRestoredState(reader);
      } finally {
        await reader.dispose();
      }
      await sentinel.expectLiveUnchanged();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
