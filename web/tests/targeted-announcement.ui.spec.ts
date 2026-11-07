import { type Page, type TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, initialPassword, requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import {
  announcementBody,
  announcementTitle,
  recipientName,
  targetedAnnouncementFixture,
} from "./targeted-announcement-backend";

// No persisted credentials, storageState, traces, videos or automatic screenshots.
// The sole network fault is a recipient-catalog read interruption. Every success,
// write, delivery, receipt and authorization response comes from the real daemon.
test.use({ trace: "off", screenshot: "off", video: "off" });
async function login(page: Page, username: string, password: string, hash: string) {
  await page.goto(`/#${hash}`);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const response = page.waitForResponse(r =>
    new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
    mask: [page.locator('input[type="password"], input[autocomplete="username"]')],
  });
}

for (const width of [1440, 390]) {
  test(`targeted announcement survives catalog interruption and retains private read receipt at ${width}px`, async ({
    page, request, playwright, browser, baseURL,
  }, info) => {
    // One production notification cycle can take 60s + 15s batch wait. The
    // explicit 80s lifecycle poll below is separate from normal UI assertions;
    // 150s allows that cycle plus browser authoring/recovery and three logins.
    test.setTimeout(150000);
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const intended = await playwright.request.newContext({ baseURL });
    const excluded = await playwright.request.newContext({ baseURL });
    const recipientContext = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    const excludedContext = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    let releaseCatalog: (() => void) | undefined;
    try {
      const f = await targetedAnnouncementFixture(request, intended, excluded);
      await login(page, "routeweaver", demoPassword, "notifications");
      await expect(page.getByRole("heading", { name: "公告与通知", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "创建公告", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "创建公告", exact: true });
      await settledTask(editor);
      await editor.getByLabel("公告标题", { exact: true }).fill(announcementTitle);
      await editor.getByLabel("公告正文", { exact: true }).fill(announcementBody);
      await editor.getByRole("combobox", { name: "通知谁", exact: true }).click();
      await page.getByRole("option", { name: "指定用户", exact: true }).click();
      const select = editor.getByRole("combobox", { name: "选择用户", exact: true });
      await expect(editor.getByText("按姓名或用户标识选择接收公告的用户。", { exact: true })).toBeVisible();
      await select.click();
      const intendedLabel = `${recipientName}，用户标识 ${f.intended.id}`;
      const excludedLabel = `${recipientName}，用户标识 ${f.excluded.id}`;
      await expect(page.getByRole("option", { name: intendedLabel, exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: excludedLabel, exact: true })).toBeVisible();
      await screenshot(page, info, `targeted-choice-${width}`);
      await page.getByRole("option", { name: intendedLabel, exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(select).toContainText("已选择 1 项");

      // A real selected draft exists before the transport interruption. Release
      // a 503, then retry against the original production endpoint unchanged.
      let failed = true;
      const gate = new Promise<void>(resolve => { releaseCatalog = resolve; });
      await page.route(new URL("/api/state", baseURL!).href, async route => {
        if (route.request().method() !== "GET") return route.continue();
        if (!failed) return route.continue();
        await gate;
        return route.fulfill({ status: 503, json: { message: "接收人目录暂时无法读取" } });
      });
      await editor.getByRole("button", { name: "刷新用户列表", exact: true }).click();
      await expect(editor.getByText("正在读取公告接收用户，请稍候。", { exact: true })).toBeVisible();
      await select.click();
      await expect(page.getByRole("option", { name: intendedLabel, exact: true })).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Escape");
      const save = editor.getByRole("button", { name: "保存并安排发布", exact: true });
      await expect(save).toBeDisabled();
      await screenshot(page, info, `targeted-catalog-loading-${width}`);
      releaseCatalog();
      await expect(editor.getByText("无法读取公告接收用户，请重试。草稿和已选用户已保留。", { exact: true })).toBeVisible();
      await expect(editor.getByLabel("公告标题", { exact: true })).toHaveValue(announcementTitle);
      await expect(editor.getByLabel("公告正文", { exact: true })).toHaveValue(announcementBody);
      await expect(select).toContainText("已选择 1 项");
      await screenshot(page, info, `targeted-catalog-error-${width}`);
      expect(await f.announcements()).toEqual([]);
      failed = false;
      await editor.getByRole("button", { name: "重试读取用户", exact: true }).click();
      await expect(editor.getByText("按姓名或用户标识选择接收公告的用户。", { exact: true })).toBeVisible();
      await expect(editor.getByRole("button", { name: `移除 ${intendedLabel}`, exact: true })).toBeVisible();
      await expect(editor.getByRole("button", { name: `移除 ${excludedLabel}`, exact: true })).toHaveCount(0);

      const writes: string[] = [];
      page.on("request", r => {
        if (new URL(r.url()).pathname.startsWith("/api/admin/announcements") && ["POST", "PUT"].includes(r.method())) writes.push(r.method());
      });
      // 41 four-byte symbols exceed the 160-byte title limit, despite fitting
      // a character-count maxLength. Likewise 2001 symbols exceed 8000 bytes.
      await editor.getByLabel("公告标题", { exact: true }).fill("🧭".repeat(41));
      await editor.getByLabel("公告正文", { exact: true }).fill("🧭".repeat(2001));
      await save.click();
      await expect(editor.getByLabel("公告标题", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await expect(editor.getByLabel("公告正文", { exact: true })).toHaveAttribute("aria-invalid", "true");
      expect(writes).toEqual([]);
      expect(await f.announcements()).toEqual([]);
      await editor.getByLabel("公告标题", { exact: true }).fill(announcementTitle);
      await editor.getByLabel("公告正文", { exact: true }).fill(announcementBody);
      await expect(editor.getByLabel("公告标题", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
      await expect(editor.getByLabel("公告正文", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
      await screenshot(page, info, `targeted-review-${width}`);
      const saved = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/announcements" && r.request().method() === "POST");
      await save.click();
      const response = await saved;
      expect(response.status()).toBe(200);
      const announcement = await response.json();
      expect(announcement.id.length).toBeLessThanOrEqual(64);
      expect(announcement.audience).toBe("users");
      expect(announcement.userIds).toEqual([f.intended.id]);
      await expect(editor).toBeHidden();
      await expect(page.getByRole("cell", { name: announcementTitle, exact: true })).toBeVisible();
      await screenshot(page, info, `targeted-saved-${width}`);

      await expect.poll(async () => (await f.inbox(intended)).filter(item => item.announcementId === announcement.id).length, {
        timeout: 80000, intervals: [250, 1000, 2000],
        message: "Production daemon makes the selected announcement available",
      }).toBe(1);
      const delivered = (await f.inbox(intended)).find(item => item.announcementId === announcement.id)!;
      expect(delivered.readAt).toBeUndefined();
      expect(await f.inbox(excluded)).toEqual([]);
      const outsiderSession = await (await excluded.get("/api/auth/me")).json();
      expect((await excluded.post(`/api/me/notifications/${delivered.eventId}/read`, {
        headers: { "X-CSRF-Token": outsiderSession.csrfToken },
      })).status()).toBe(404);

      const reader = await recipientContext.newPage();
      await login(reader, f.intended.username, initialPassword, "inbox");
      const unread = reader.getByRole("button", { name: new RegExp(`${announcementTitle}.*未读`) });
      await expect(unread).toBeVisible();
      await screenshot(reader, info, `targeted-unread-${width}`);
      const acknowledged = reader.waitForResponse(r => new URL(r.url()).pathname === `/api/me/notifications/${delivered.eventId}/read` && r.request().method() === "POST");
      await unread.click();
      expect((await acknowledged).status()).toBe(200);
      const opened = reader.getByRole("dialog", { name: announcementTitle, exact: true });
      await settledTask(opened);
      await expect(opened.getByText(announcementBody, { exact: true })).toBeVisible();
      await expect.poll(async () => (await f.inbox(intended))[0].readAt).toBeTruthy();
      const receipt = (await f.inbox(intended))[0].readAt;
      await screenshot(reader, info, `targeted-open-read-${width}`);
      await reader.keyboard.press("Escape");
      const read = reader.getByRole("button", { name: new RegExp(`${announcementTitle}.*已读`) });
      await expect(read).toBeVisible();
      await reader.reload();
      await expect(read).toBeVisible();
      // Reload proves persistence across UI reconstruction, not process restart.
      expect((await f.inbox(intended))[0].readAt).toBe(receipt);
      const nav = reader.getByRole("navigation", { name: "工作空间导航", exact: true });
      if (!(await nav.isVisible())) await reader.getByRole("button", { name: "打开导航", exact: true }).click();
      await reader.getByRole("button", { name: new RegExp(`${recipientName}.*个人账号`) }).click();
      const loggedOut = reader.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/logout" && r.request().method() === "POST");
      await reader.getByRole("menuitem", { name: "退出登录", exact: true }).click();
      expect((await loggedOut).status()).toBe(200);
      await login(reader, f.intended.username, initialPassword, "inbox");
      await expect(read).toBeVisible();
      expect((await f.inbox(intended))[0].readAt).toBe(receipt);

      await page.getByRole("row").filter({ has: page.getByRole("cell", { name: announcementTitle, exact: true }) }).getByRole("button", { name: "编辑", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "编辑公告", exact: true });
      await settledTask(edit);
      await expect(edit.getByRole("button", { name: `移除 ${intendedLabel}`, exact: true })).toBeVisible();
      const updatedBody = "维护时间已更新，请在稍后检查连接。接收账号不变。";
      await edit.getByLabel("公告正文", { exact: true }).fill(updatedBody);
      const updated = page.waitForResponse(r => new URL(r.url()).pathname === `/api/admin/announcements/${announcement.id}` && r.request().method() === "PUT");
      await edit.getByRole("button", { name: "保存并安排发布", exact: true }).click();
      expect((await updated).status()).toBe(200);
      await expect(edit).toBeHidden();
      expect(writes).toEqual(["POST", "PUT"]);
      const stored = await f.announcements();
      expect(stored).toHaveLength(1);
      expect(stored[0].audience).toBe("users");
      expect(stored[0].userIds).toEqual([f.intended.id]);
      await reader.reload();
      await expect(read).toBeVisible();
      await read.click();
      await expect(opened.getByText(updatedBody, { exact: true })).toBeVisible();
      const afterEdit = await f.inbox(intended);
      expect(afterEdit).toHaveLength(1);
      expect(afterEdit[0]).toMatchObject({ eventId: delivered.eventId, readAt: receipt, body: updatedBody });
      await screenshot(reader, info, `targeted-edited-read-${width}`);
      const outsider = await excludedContext.newPage();
      await login(outsider, f.excluded.username, initialPassword, "inbox");
      await expect(outsider.getByText("暂无消息", { exact: true })).toBeVisible();
      expect(await f.inbox(excluded)).toEqual([]);
      await screenshot(outsider, info, `targeted-excluded-${width}`);
    } finally {
      releaseCatalog?.();
      await Promise.all([intended.dispose(), excluded.dispose(), recipientContext.close(), excludedContext.close()]);
    }
  });
}
