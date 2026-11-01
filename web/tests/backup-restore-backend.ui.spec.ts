import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as createRequest } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import {
  backupPassword,
  backupSession,
  expectFreshRestore,
  requireBackupLoopback,
  seedBackupSentinel,
} from "./backup-restore-backend";

// Real HTTP throughout. Browser execution is separate from the API companion.
test("OPS01 downloaded backup file rejects a wrong password and restores without activating", async ({
  page,
  isolatedControlPlane,
}) => {
  requireBackupLoopback(isolatedControlPlane.url);
  const directory = await mkdtemp(join(tmpdir(), "routeweaver-ops01-"));
  try {
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
    const downloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "加密并下载", exact: true })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(
      /^routeweaver-\d{4}-\d{2}-\d{2}\.age$/,
    );
    const file = join(directory, "downloaded.age");
    await download.saveAs(file);
    expect(await download.failure()).toBeNull();
    expect((await readFile(file)).subarray(0, 30).toString()).toContain(
      "age-encryption.org",
    );
    await expect(dialog).not.toBeVisible();
    await sentinel.changeAfterBackup();
    const chooserEvent = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "选择备份文件", exact: true })
      .click();
    await (await chooserEvent).setFiles(file);
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
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByText("文件校验通过", { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "恢复到新数据库", exact: true }),
    ).not.toBeVisible();
    await expect(password).toHaveValue("wrong-synthetic-passphrase");
    await expect(page.getByText(/downloaded\.age ·/)).toBeVisible();
    await password.fill(backupPassword);
    await inspect.click();
    await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
    await expect(
      page.getByText("恢复到新数据库，不覆盖当前数据，也不会自动切换服务。", {
        exact: true,
      }),
    ).toBeVisible();
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
    const restoredEvent = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/admin/backups/restore" &&
        r.request().method() === "POST",
    );
    await restore.click();
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
