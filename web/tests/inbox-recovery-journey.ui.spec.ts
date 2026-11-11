import { writeFile } from "node:fs/promises";
import { test, expect, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";

// Production App/session with exact synthetic HTTP reads. Every write is blocked,
// including read receipts. This does not exercise live notifications or delivery.
test.use({ trace: "off", screenshot: "off", video: "off" });
async function geometry(target: Locator) {
  return target.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      visibleInViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      unobscured: !!hit && element.contains(hit), focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
    };
  });
}
async function capture(page: Page, info: TestInfo, stage: string, targets: Record<string, Locator>) {
  // Original viewport and observed geometry are saved before acceptance assertions.
  await page.screenshot({ path: info.outputPath(`${stage}.png`), animations: "disabled" });
  const observations = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, target]) => [name, await geometry(target)])));
  await writeFile(info.outputPath(`${stage}.json`), JSON.stringify({
    observations, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
  }, null, 2));
  return observations;
}
for (const width of [1440, 390]) {
  test(`controlled inbox interrupted reading recovers selected content and keyboard return at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Inbox recovery requires loopback");
    await page.setViewportSize({ width, height: 900 });
    const origin = new URL(baseURL).origin;
    const requests: { method: string; path: string; outcome: string }[] = [];
    const stages: string[] = [];
    let reads = 0;
    let recovering = false;
    let pending: Route | undefined;
    const messages = () => [
      { eventId: "maintenance", kind: "announcement", title: "维护安排", body: "维护完整正文", createdAt: "2026-11-01T10:00:00Z", readAt: "2026-11-01T11:00:00Z" },
      { eventId: "quota", kind: "quota", title: "额度提醒", body: recovering ? "最新额度正文" : "之前额度正文", createdAt: "2026-11-01T12:00:00Z" },
    ];
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== "GET") {
        requests.push({ method: request.method(), path: url.origin === origin ? url.pathname : "off-origin", outcome: "blocked" });
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const entry = { method: request.method(), path: url.pathname + url.search, outcome: "" };
      requests.push(entry);
      if (url.pathname === "/api/auth/me" && !url.search) {
        entry.outcome = "session";
        return route.fulfill({ json: { user: { id: "reader", name: "Reader", role: "user", passwordChangeRequired: false }, csrfToken: "synthetic" } });
      }
      if (url.pathname === "/api/me/notifications" && !url.search) {
        reads++;
        if (reads === 2) { entry.outcome = "held-then-503"; pending = route; return; }
        if (reads > 2 && !recovering) {
          entry.outcome = "503";
          return route.fulfill({ status: 503, json: { message: "列表读取暂不可用" } });
        }
        entry.outcome = recovering ? "recovered-messages" : "initial-messages";
        return route.fulfill({ json: messages() });
      }
      entry.outcome = "blocked";
      return route.abort();
    });
    try {
      await page.goto("/#inbox");
      const main = page.getByRole("main");
      const first = main.getByRole("button", { name: /维护安排.*已读/ });
      await expect(first).toBeVisible();
      await main.getByRole("button", { name: "刷新", exact: true }).click();
      await expect.poll(() => pending !== undefined).toBe(true);
      await first.click();
      const maintenance = page.getByRole("dialog", { name: "维护安排", exact: true });
      await expect(maintenance).toBeVisible();
      await pending!.fulfill({ status: 503, json: { message: "列表读取暂不可用" } });
      pending = undefined;
      // Production query retries once. Wait for the actual error presentation.
      await expect(maintenance.getByText("消息刷新失败，当前显示上次读取内容。", { exact: true })).toBeVisible();
      await capture(page, info, "selected-refresh-failed", { dialog: maintenance, body: maintenance.getByText("维护完整正文", { exact: true }) });
      stages.push("selected-refresh-failed");
      await page.keyboard.press("Escape");
      await expect(maintenance).not.toBeVisible();
      const returned = await capture(page, info, "return-to-cached-list", { opener: first });
      stages.push("return-to-cached-list");
      expect(returned.opener.focused).toBe(true);
      expect(returned.opener.visibleInViewport && returned.opener.unobscured).toBe(true);
      await expect(main.getByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。", { exact: true })).toBeVisible();
      await page.keyboard.press("Tab");
      const quota = main.getByRole("button", { name: /额度提醒.*未读/ });
      await expect(quota).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "额度提醒", exact: true });
      const retry = dialog.getByRole("button", { name: "重试刷新", exact: true });
      const mark = dialog.getByRole("button", { name: "标记已读", exact: true });
      await expect(mark).toBeDisabled();
      await expect(dialog.getByText("之前额度正文", { exact: true })).toBeVisible();
      // Reach recovery using real keyboard traversal, never DOM focus injection.
      for (let i = 0; i < 6 && !(await retry.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      const failed = await capture(page, info, "keyboard-recovery", { retry, body: dialog.getByText("之前额度正文", { exact: true }) });
      stages.push("keyboard-recovery");
      expect(failed.retry.focused && failed.retry.visibleInViewport && failed.retry.unobscured).toBe(true);
      recovering = true;
      await page.keyboard.press("Enter");
      await expect(dialog.getByText("最新额度正文", { exact: true })).toBeVisible();
      await capture(page, info, "selected-recovered", { dialog, mark });
      stages.push("selected-recovered");
      await expect(mark).toBeEnabled();
      await expect(retry).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      const recovered = await capture(page, info, "return-after-recovery", { opener: quota });
      stages.push("return-after-recovery");
      expect(recovered.opener.focused && recovered.opener.visibleInViewport && recovered.opener.unobscured).toBe(true);
      await expect(main.getByText("暂无消息", { exact: true })).toHaveCount(0);
      await expect(main.getByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。", { exact: true })).toHaveCount(0);
      expect(requests.filter((entry) => entry.outcome === "blocked")).toEqual([]);
      expect(requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    } finally {
      await writeFile(info.outputPath("request-ledger.json"), JSON.stringify(requests, null, 2));
      await writeFile(info.outputPath("evidence-ledger.json"), JSON.stringify({ width, stages, reads, syntheticHTTP: true, liveDelivery: false, acknowledgementAttempted: false }, null, 2));
    }
  });
}
