import { writeFile } from "node:fs/promises";
import { test, expect, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";

// Controlled production UI + read-only HTTP fixtures. These are backend-shaped
// summary records, not observed deliveries. Every API write/off-origin request
// is denied. No recipient, credentials, live settings or transport is exercised.
test.use({ trace: "off", screenshot: "off", video: "off" });
const transportFailure = "channel delivery failed; verify destination, credentials and TLS, then test again";
const exhausted = "delivery attempts exhausted; receiver acceptance may be unknown";
const changed = "channel settings or authorization changed; create a new explicit test";
const ineligible = "recipient or validity is no longer eligible";
const testTitle = "RouteWeaver notification test";
const announcementTitle = "东京与伦敦线路维护安排：请在维护结束后检查连接";
const createdAt = "2026-11-07T10:00:00Z";
const nextAttemptAt = "2026-11-07T10:03:00Z";
const deliveries = [
  { eventId: "retry", kind: "provider-quota", title: "Provider allowance reminder", channel: "email", status: "retrying", attempts: 2, createdAt, nextAttemptAt, lastError: transportFailure },
  { eventId: "queued", kind: "provider-quota", title: "Provider allowance reminder", channel: "webhook", status: "queued", attempts: 0, createdAt, nextAttemptAt: createdAt },
  { eventId: "sending", kind: "test", title: testTitle, channel: "webhook", status: "sending", attempts: 2, createdAt, nextAttemptAt: "2026-11-07T10:01:00Z", lastError: transportFailure },
  { eventId: "failed", kind: "test", title: testTitle, channel: "email", status: "failed", attempts: 5, createdAt, nextAttemptAt: "2026-11-07T10:15:00Z", lastError: exhausted },
  { eventId: "changed", kind: "test", title: testTitle, channel: "email", status: "cancelled", attempts: 1, createdAt, nextAttemptAt: "2026-11-07T10:01:00Z", lastError: changed },
  { eventId: "ineligible", kind: "announcement", title: announcementTitle, channel: "in-app", status: "cancelled", attempts: 0, createdAt, nextAttemptAt: createdAt, lastError: ineligible },
  { eventId: "accepted", kind: "test", title: testTitle, channel: "webhook", status: "accepted", attempts: 2, createdAt, nextAttemptAt: "2026-11-07T10:01:00Z" },
  { eventId: "available", kind: "announcement", title: announcementTitle, channel: "in-app", status: "available", attempts: 1, createdAt, nextAttemptAt: createdAt },
  // Defensive records are separate from the real worker's normal transitions.
  { eventId: "missing-time", kind: "provider-expiry", title: "Provider expiry reminder", channel: "email", status: "retrying", attempts: 1, createdAt, nextAttemptAt: "0001-01-01T00:00:00Z", lastError: transportFailure },
  { eventId: "unknown", kind: "test", title: testTitle, channel: "push", status: "unrecognized", attempts: 1, createdAt, nextAttemptAt, lastError: "Unrecognized persisted delivery classification" },
];
async function setup(page: Page, baseURL: string | undefined, onRefresh?: (route: Route, read: number) => Promise<void>) {
  if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
    throw new Error("Controlled outbox history requires a loopback base URL");
  }
  const origin = new URL(baseURL).origin;
  const unexpected: string[] = [];
  const responses: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "fixture-admin", name: "记录审查管理员", role: "admin" }, csrfToken: "controlled-fixture" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/services": [], "/api/settings": {}, "/api/published-routes": [],
    "/api/rates": [], "/api/user-groups": [], "/api/me/notifications": [],
    "/api/admin/announcements": [], "/api/admin/notifications/outbox": deliveries,
  };
  let outboxReads = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("off-origin request");
      return route.abort();
    }
    if (request.method() !== "GET") {
      unexpected.push("write request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (!Object.hasOwn(responses, url.pathname)) {
      unexpected.push(`unconfigured API read ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/api/admin/notifications/outbox") {
      outboxReads++;
      if (outboxReads > 1 && onRefresh) return onRefresh(route, outboxReads);
    }
    return route.fulfill({ json: responses[url.pathname] });
  });
  await page.goto("/#notifications");
  await page.getByRole("tab", { name: "发送记录", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "创建时间（北京时间）" })).toBeVisible();
  return { unexpected, outboxReads: () => outboxReads };
}
function context(page: Page, title: string, status: string, channel: string) {
  return page.getByRole("cell")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.getByText(status, { exact: true }) })
    .filter({ has: page.getByText(channel, { exact: true }) });
}
async function fitsContext(page: Page, cell: Locator, content: Locator[]) {
  const viewport = page.locator('[data-slot="table-container"]');
  // Reading the first column must not require horizontal scrolling to recover
  // its notification/channel/status/recovery association on a narrow screen.
  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  const frame = await viewport.boundingBox();
  expect(frame).not.toBeNull();
  await expect(cell).toHaveCount(1);
  for (const locator of content) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function capture(page: Page, info: TestInfo, stage: string, width: number, target?: Locator) {
  // Scroll the bounded reading context, not its potentially wider table cell.
  if (target) await target.locator(":scope > div").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`outbox-history-journey-${stage}-${width}.png`), animations: "disabled" });
}

for (const width of [1440, 390]) {
  test(`controlled populated outbox history preserves retry and terminal meaning at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const audit = await setup(page, baseURL);
    const retry = context(page, "Provider allowance reminder", "等待重试", "邮件");
    const recovery = retry.getByText("请在“提醒与渠道”检查该渠道的目标地址、凭据和 TLS 设置。");
    const retryTime = retry.getByText("2026/11/07 18:03（北京时间）", { exact: true });
    await expect(retryTime).toHaveAttribute("datetime", nextAttemptAt);
    await expect(retry.getByText("接收方是否已接收尚未确认。")).toBeVisible();
    await expect(retry.getByText(transportFailure, { exact: true })).not.toBeVisible();
    await fitsContext(page, retry, [retry.getByText("Provider allowance reminder", { exact: true }), retry.getByText("邮件", { exact: true }), retry.getByText("等待重试", { exact: true }), retryTime, recovery]);
    await capture(page, info, "retry", width, retry);

    const queued = context(page, "Provider allowance reminder", "等待发送", "Webhook");
    await expect(queued.getByText("2026/11/07 18:00（北京时间）")).toBeVisible();
    const sending = context(page, testTitle, "发送中", "Webhook");
    await expect(sending.getByText("接收结果尚未确认。")).toBeVisible();
    await expect(sending.getByText(/下次尝试/)).toHaveCount(0);
    await expect(sending.getByText(/检查该渠道的目标地址/)).toHaveCount(0);
    await fitsContext(page, sending, [sending.getByText(testTitle, { exact: true }), sending.getByText("Webhook", { exact: true }), sending.getByText("发送中", { exact: true }), sending.getByText("接收结果尚未确认。")]);
    await capture(page, info, "sending", width, sending);

    const failed = context(page, testTitle, "发送失败", "邮件");
    const consequence = failed.getByText("已停止自动重试。接收方是否已接收尚未确认。");
    const nextStep = failed.getByText("请先核对接收方记录，再决定是否在“提醒与渠道”发送新的测试。");
    await fitsContext(page, failed, [failed.getByText(testTitle, { exact: true }), failed.getByText("邮件", { exact: true }), failed.getByText("发送失败", { exact: true }), consequence, nextStep]);
    await expect(failed.getByText(/下次尝试/)).toHaveCount(0);
    await expect(failed.getByText(exhausted, { exact: true })).not.toBeVisible();
    await capture(page, info, "terminal", width, failed);
    const summary = failed.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(failed.getByText(exhausted, { exact: true })).toBeVisible();
    await fitsContext(page, failed, [consequence, nextStep, failed.getByText(exhausted, { exact: true })]);
    await capture(page, info, "technical-detail", width, failed);
    await page.keyboard.press("Space");
    await expect(failed.getByText(exhausted, { exact: true })).not.toBeVisible();
    await expect(summary).toBeFocused();

    const cancelled = context(page, testTitle, "已取消", "邮件");
    const cancellation = cancelled.getByText("渠道设置或发送许可已变更。请在“提醒与渠道”核对设置，需要验证时另行发送测试。");
    await expect(cancellation).toBeVisible();
    await expect(cancelled.getByText(/下次尝试/)).toHaveCount(0);
    const ineligibleNotice = context(page, announcementTitle, "已取消", "站内");
    const eligibility = ineligibleNotice.getByText("接收对象或有效期已不符合发送条件。请核对通知的接收对象与有效期。");
    await fitsContext(page, ineligibleNotice, [ineligibleNotice.getByText(announcementTitle, { exact: true }), ineligibleNotice.getByText("站内", { exact: true }), ineligibleNotice.getByText("已取消", { exact: true }), eligibility]);
    await capture(page, info, "cancelled", width, ineligibleNotice);

    const accepted = context(page, testTitle, "渠道已接收", "Webhook");
    const available = context(page, announcementTitle, "站内已可读", "站内");
    for (const completed of [accepted, available]) {
      await expect(completed).toHaveCount(1);
      await expect(completed.getByText(/下次尝试|已送达|已经阅读/)).toHaveCount(0);
    }
    const missingTime = context(page, "Provider expiry reminder", "等待重试", "邮件");
    await expect(missingTime.getByText("下次尝试时间未提供。")).toBeVisible();
    await expect(missingTime.getByText(/下次尝试不早于/)).toHaveCount(0);
    const unknown = context(page, testTitle, "未知状态", "push");
    await expect(unknown.getByText("原因尚未识别，请查看技术详情。")).toHaveCount(0);
    await expect(unknown.getByText("请刷新记录并查看技术详情。")).toBeVisible();
    await expect(unknown.getByText(/下次尝试|Webhook/)).toHaveCount(0);
    await fitsContext(page, unknown, [unknown.getByText(testTitle, { exact: true }), unknown.getByText("push", { exact: true }), unknown.getByText("未知状态", { exact: true }), unknown.getByText("请刷新记录并查看技术详情。")]);
    await capture(page, info, "unknown", width, unknown);
    await expect(page.getByRole("button", { name: /发送.*测试|重试/ })).toHaveCount(0);
    expect(audit.unexpected).toEqual([]);
    expect(audit.outboxReads()).toBeGreaterThan(0);
    await writeFile(info.outputPath(`outbox-history-journey-evidence-${width}.json`), JSON.stringify({
      width, controlledUIFixtures: true, realExternalDelivery: false,
      normalBackendStatuses: ["queued", "retrying", "sending", "failed", "cancelled", "accepted", "available"],
      defensiveCases: ["zero retry deadline", "unrecognized status/channel/reason"],
      fixtureRecords: deliveries.length, outboxReads: audit.outboxReads(),
      blockedUnexpectedRequests: audit.unexpected.length, writeRequests: 0,
      retryTimeZone: "Asia/Shanghai", terminalDeadlineNotShown: true,
      receiverAcceptanceUncertaintyVisible: true, technicalDetailKeyboardToggle: true,
      contextFitsVisibleTableWidth: true,
      limits: ["No real delivery or receiver acceptance", "No recipient or destination lookup", "No backend state transition or persistence", "No credentials or live settings"],
    }, null, 2));
  });
}


for (const width of [1440, 390]) {
  test(`controlled outbox refresh preserves records and open detail through recovery at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    // Freeze browser timers after initial render. Explicit short advances flush
    // query notifications while staying below the 15-second polling interval.
    const time = new Date("2026-11-07T10:00:00Z");
    await page.clock.install({ time });
    let pending: Route | undefined;
    const audit = await setup(page, baseURL, async (route) => { pending = route; });
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
    expect(audit.outboxReads()).toBe(1);
    const failed = context(page, testTitle, "发送失败", "邮件");
    const detail = failed.locator("details");
    await failed.locator("summary").click();
    await expect(detail).toHaveAttribute("open", "");
    const refresh = page.getByRole("button", { name: "刷新记录", exact: true });
    await refresh.click();
    await page.clock.runFor(100);
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status").filter({ hasText: "正在刷新记录" })).toBeVisible();
    await expect(detail).toHaveAttribute("open", "");
    await expect(failed.getByText(exhausted, { exact: true })).toBeVisible();
    // The focusable pending action must ignore repeated keyboard activation.
    await refresh.focus();
    await page.keyboard.press("Enter");
    await page.clock.runFor(100);
    expect(audit.outboxReads()).toBe(2);
    await expect.poll(() => pending !== undefined).toBe(true);
    await pending!.fulfill({ status: 503, json: { error: "Controlled read unavailable" } });
    pending = undefined;
    // The actual App retries failed reads once (main.tsx). Advance only
    // enough virtual time for that retry, never the 15-second polling interval.
    await expect.poll(async () => {
      await page.clock.runFor(100);
      return pending !== undefined;
    }, { timeout: 3000, intervals: [100] }).toBe(true);
    const retryRoute: Route = pending!;
    pending = undefined;
    await retryRoute.fulfill({ status: 503, json: { error: "Controlled read unavailable" } });
    await expect.poll(async () => {
      await page.clock.runFor(100);
      return refresh.getAttribute("aria-busy");
    }, { timeout: 3000, intervals: [100] }).not.toBe("true");
    expect(audit.outboxReads()).toBe(3);
    const failure = page.getByText("未能刷新发送记录，仍显示上次读取的记录。请重试刷新。", { exact: true });
    await expect(failure).toBeVisible();
    await expect(refresh).not.toHaveAttribute("aria-busy", "true");
    await expect(detail).toHaveAttribute("open", "");
    await expect(failed.getByText(exhausted, { exact: true })).toBeVisible();
    await expect(page.getByText("暂无发送记录", { exact: true })).toHaveCount(0);
    await failure.scrollIntoViewIfNeeded();
    await capture(page, info, "refresh-failure", width);
    await fitsContext(page, failed, [failed.getByText(testTitle, { exact: true }), failed.getByText("发送失败", { exact: true }), failed.getByText(exhausted, { exact: true })]);
    await capture(page, info, "refresh-failure-detail", width, failed);
    const readsBeforeRecovery = audit.outboxReads();
    await refresh.click();
    await page.clock.runFor(100);
    await expect.poll(() => pending !== undefined).toBe(true);
    await pending!.fulfill({ json: deliveries.map((record) => record.eventId === "failed" ? { ...record, attempts: 6 } : record) });
    pending = undefined;
    await expect.poll(async () => {
      await page.clock.runFor(100);
      return refresh.getAttribute("aria-busy");
    }, { timeout: 3000, intervals: [100] }).not.toBe("true");
    await expect(failure).toHaveCount(0);
    await expect(detail).toHaveAttribute("open", "");
    await expect(failed.locator("..").getByRole("cell", { name: "6", exact: true })).toHaveCount(1);
    await fitsContext(page, failed, [failed.getByText(testTitle, { exact: true }), failed.getByText("发送失败", { exact: true }), failed.getByText(exhausted, { exact: true })]);
    await capture(page, info, "refresh-recovered-detail", width, failed);
    await refresh.scrollIntoViewIfNeeded();
    await capture(page, info, "refresh-recovered", width);
    expect(audit.outboxReads()).toBe(readsBeforeRecovery + 1);
    expect(audit.unexpected).toEqual([]);
    await expect(page.getByRole("button", { name: /发送.*测试|标为已读/ })).toHaveCount(0);
  });
}
