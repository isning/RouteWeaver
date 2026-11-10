import { expect, test, type Route } from "@playwright/test";
import { openWorkspace } from "./ui-session";

// Controlled delayed archives exercise browser navigation/download ownership.
// Encryption and restore correctness belong to backup-restore-backend.ui.spec.ts.
test("leaving backup export retires its download and preserves the new export task", async ({ page }) => {
  await openWorkspace(page);
  const requests: Route[] = [];
  await page.route("**/api/admin/backups", (route) => { requests.push(route); });
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const prepare = async (password: string) => {
    await page.goto("/#settings");
    await page.getByRole("tab", { name: "备份与恢复", exact: true }).click();
    await page.getByRole("button", { name: "创建加密备份", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "创建加密备份", exact: true });
    await dialog.getByLabel("设置备份密码", { exact: true }).fill(password);
    await dialog.getByLabel("再次输入密码", { exact: true }).fill(password);
    return dialog;
  };
  const previous = await prepare("synthetic-previous-backup");
  await previous.getByRole("button", { name: "加密并下载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  // A hash-only route change leaves the React page while retaining its pending
  // request, unlike a full browser reload which abandons the document itself.
  await page.goto("/#profiles");
  await expect(previous).not.toBeVisible();
  const current = await prepare("synthetic-current-backup");
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/backups");
  await requests[0].fulfill({ contentType: "application/octet-stream", body: "synthetic old archive" });
  await (await oldResponse).finished();
  // Finish the old response and interact with the current task instead of using
  // a sleep. An abandoned download remains observable in the event array.
  await current.getByRole("button", { name: "加密并下载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(current.getByLabel("设置备份密码", { exact: true })).toHaveValue("synthetic-current-backup");
  await expect(current.getByLabel("再次输入密码", { exact: true })).toHaveValue("synthetic-current-backup");
  expect(downloads).toEqual([]);
  await expect(page.getByText("加密备份已准备好，请保管好文件和密码", { exact: true })).toHaveCount(0);
  const downloaded = page.waitForEvent("download");
  await requests[1].fulfill({ contentType: "application/octet-stream", body: "synthetic current archive" });
  await downloaded;
  await expect(current).not.toBeVisible();
  await expect(page.getByText("加密备份已准备好，请保管好文件和密码", { exact: true })).toHaveCount(1);
  expect(downloads).toHaveLength(1);
  expect(requests).toHaveLength(2);
});
