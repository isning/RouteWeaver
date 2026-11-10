import { type Page, type Route } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { settledTask } from "./ui-settled-task";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function openBackupWorkspace(page: Page) {
  // Each test owns a fresh normal CLI/database and establishes its own actor.
  // Never reuse a cookie from the shared demo or another isolated test.
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("routeweaver");
  await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await waitForConfirmedWorkspace(page, "normal-ui-login");
}

// Controlled delayed archives exercise browser navigation/download ownership.
// Encryption and restore correctness belong to backup-restore-backend.ui.spec.ts.
test("leaving backup export retires its download and preserves the new export task", async ({ page }) => {
  await openBackupWorkspace(page);
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

for (const width of [1440, 390]) {
  test(`backup keyboard validation reveals its invalid field at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 640 : 1000 });
    await openBackupWorkspace(page);
    let writes = 0;
    await page.route("**/api/admin/backups", (route) => {
      writes++;
      return route.abort();
    });
    await page.goto("/#settings");
    await page.getByRole("tab", { name: "备份与恢复", exact: true }).click();
    await page.getByRole("button", { name: "创建加密备份", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "创建加密备份", exact: true });
    await settledTask(dialog);
    const password = dialog.getByLabel("设置备份密码", { exact: true });
    const confirmation = dialog.getByLabel("再次输入密码", { exact: true });
    const submit = dialog.getByRole("button", { name: "加密并下载", exact: true });
    for (const [name, field] of [["password", password], ["confirmation", confirmation]] as const) {
      if (name === "confirmation") {
        await password.fill("synthetic-valid-backup");
        await confirmation.fill("synthetic-mismatch-backup");
      }
      await submit.focus();
      await submit.press("Enter");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toBeFocused();
      await expect(field).toBeInViewport({ ratio: 1 });
      expect(await field.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node;
      }), "Focused invalid field is uncovered").toBe(true);
      await info.attach(`backup-error-${name}-${width}`, {
        body: await page.screenshot({ mask: [password, confirmation] }),
        contentType: "image/png",
      });
    }
    // Distinct accessible names let keyboard/assistive-tech users choose the
    // confirmation reveal control without disclosing the other field.
    const reveal = dialog.getByRole("button", { name: /^(显示|隐藏)再次输入的密码$/ });
    await expect(dialog.getByRole("button", { name: "显示备份密码", exact: true })).toBeVisible();
    await reveal.focus();
    await reveal.press("Enter");
    await expect(confirmation).toHaveAttribute("type", "text");
    await expect(password).toHaveAttribute("type", "password");
    await expect(reveal).toHaveAccessibleName("隐藏再次输入的密码");
    await expect(reveal).toBeFocused();
    await reveal.press("Space");
    await expect(confirmation).toHaveAttribute("type", "password");
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    expect(writes).toBe(0);
  });
}
