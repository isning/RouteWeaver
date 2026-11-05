import { expect, test, type Locator, type Page } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Production lists with isolated synthetic API fixtures. Every write is either
// explicitly fulfilled here or refused; none reaches a backend. This verifies
// browser task behavior and layout, not resource delivery or persistence.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
const deliveryTitle =
  "跨区域线路维护与恢复安排：请核对东京、伦敦及法兰克福入口的当前状态。" +
  "MaintenanceNoticeWithoutWordSeparators".repeat(3);
const deliveryReason =
  "邮件服务器暂时无法连接，请检查渠道配置后重试。" +
  "SyntheticTransportFailureWithoutWordSeparators".repeat(4);
const resourceFailure =
  "刷新失败，保留已接纳文件。新发布前请重试或替换。";

const refreshRequestFailure = "远程文件暂时无法读取，请稍后重试。";

async function setup(page: Page, refreshJourney = false) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Controlled list layout review requires loopback");
  const origin = new URL(baseURL).origin;
  const unexpected: string[] = [];
  const refreshRequests: string[] = [];
  const responses: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "list-review", name: "列表审查管理员", role: "admin" },
      csrfToken: "synthetic",
    },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/admin/announcements": [],
    "/api/admin/notifications/outbox": [{
      eventId: "long-delivery", title: deliveryTitle, channel: "email",
      status: "failed", attempts: 3, lastError: deliveryReason,
      createdAt: "2026-11-04T10:00:00Z",
    }],
    "/api/me/resources": [{
      id: "retained-rules", name: "已接纳的规则文件", revision: "1",
      format: "mihomo-yaml", behavior: "domain", location: "inline",
      updatePolicy: "pinned", acceptedVersion: "accepted-1",
      sizeBytes: 2450, canRefresh: true, refreshStatus: refreshJourney ? "accepted" : "failed",
      visibility: "private",
    }],
  };
  await page.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`external ${request.resourceType()}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (refreshJourney && request.method() === "POST" && url.pathname === "/api/me/resources/retained-rules/refresh") {
      refreshRequests.push(url.pathname);
      const failed = refreshRequests.length === 1;
      const resources = responses["/api/me/resources"] as { refreshStatus: string }[];
      resources[0].refreshStatus = failed ? "failed" : "accepted";
      return route.fulfill({ status: failed ? 503 : 200, json: failed ? { error: refreshRequestFailure } : {} });
    }
    if (request.method() !== "GET" || !(url.pathname in responses)) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 503, json: { message: "Unexpected controlled list request" } });
    }
    return route.fulfill({ json: responses[url.pathname] });
  });
  return { unexpected, refreshRequests };
}

async function completeWrappedText(element: Locator, text: string) {
  await expect(element).toHaveText(text);
  await element.scrollIntoViewIfNeeded();
  await expect(element).toBeInViewport();
  const layout = await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const style = getComputedStyle(node);
    return {
      width: node.getBoundingClientRect().width,
      lines: new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size,
      fits: node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
      overflow: style.overflow,
      ellipsis: style.textOverflow,
    };
  });
  // Enough space for readable lines, but no single prose column monopolizes
  // the list. A visible multi-line block must retain its complete contents.
  expect(layout.width).toBeGreaterThanOrEqual(150);
  expect(layout.width).toBeLessThanOrEqual(384);
  expect(layout.lines).toBeGreaterThan(1);
  expect(layout.fits).toBe(true);
  expect(layout.overflow).not.toBe("hidden");
  expect(layout.ellipsis).not.toBe("ellipsis");
}

async function startsNearRowTop(row: Locator) {
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell")).toHaveCount(6);
  const offsets = await row.getByRole("cell").evaluateAll((cells) =>
    cells.map((cell) => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const bounds = range.getBoundingClientRect();
        if (!bounds.height) continue;
        return bounds.top - cell.getBoundingClientRect().top;
      }
      return 0;
    }),
  );
  // First-line metadata must not sink to the middle of a multi-line row.
  // This also allows the centered label inside a normal 44px action button.
  for (const offset of offsets) expect(offset).toBeLessThanOrEqual(32);
}

async function hasErrorTone(element: Locator) {
  const [red, green, blue] = await element.evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(node).color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
  // The failure must read as an error, not another neutral gray state.
  expect(red).toBeGreaterThan(green * 1.4);
  expect(red).toBeGreaterThan(blue * 1.4);
}

for (const width of [1440, 390]) {
  test(`delivery title and failure reason stay readable without widening the list at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { unexpected } = await setup(page);
    await page.goto("/#notifications");
    await page.getByRole("tab", { name: "发送记录", exact: true }).click();
    const row = page.getByRole("row").filter({ has: page.getByText(deliveryTitle, { exact: true }) });
    await startsNearRowTop(row);
    const failure = row.getByText("发送失败", { exact: true });
    await expect(failure).toBeVisible();
    await hasErrorTone(failure);
    await completeWrappedText(page.getByText(deliveryTitle, { exact: true }), deliveryTitle);
    await page.screenshot({ path: info.outputPath(`delivery-long-title-${width}.png`), fullPage: true });
    await completeWrappedText(page.getByText(deliveryReason, { exact: true }), deliveryReason);
    await expect(page.getByRole("cell", { name: "发送失败", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`delivery-long-content-${width}.png`), fullPage: true });
    expect(unexpected).toEqual([]);
  });

  test(`resource refresh failure remains complete beside usable row actions at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { unexpected } = await setup(page);
    await page.goto("/#resources");
    const fullReason = page.getByText(resourceFailure, { exact: true });
    await completeWrappedText(fullReason, resourceFailure);
    await hasErrorTone(fullReason);
    await expect(page.getByText("随配置打包", { exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ has: page.getByText("已接纳的规则文件", { exact: true }) });
    await startsNearRowTop(row);
    await expect(page.getByRole("columnheader", { name: "操作", exact: true })).toBeVisible();
    const refresh = row.getByRole("button", { name: "刷新文件", exact: true });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await expect(refresh).toBeInViewport();
    const actions = row.getByRole("group", { name: "已接纳的规则文件 的操作", exact: true });
    const shortStatus = actions.getByText("刷新失败", { exact: true });
    // Persisted row state is read in context, not as a fresh live alert. The
    // visual reminder is hidden from speech; actions describe the full reason.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(fullReason).toHaveText(resourceFailure);
    await expect(refresh).toHaveAccessibleDescription(resourceFailure);
    await expect(actions.getByRole("button", { name: "替换文件", exact: true })).toHaveAccessibleDescription(resourceFailure);
    await expect(shortStatus).toHaveAttribute("aria-hidden", "true");
    if (width === 390) {
      await expect(shortStatus).toBeInViewport({ ratio: 1 });
      await hasErrorTone(shortStatus);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(shortStatus).not.toBeVisible();
      await expect(fullReason).toBeVisible();
      await page.setViewportSize({ width: 390, height: 1000 });
      await actions.getByRole("button", { name: "替换文件", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(shortStatus).toBeInViewport({ ratio: 1 });
      await expect(refresh).toBeFocused();
    } else await expect(shortStatus).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`resource-refresh-failure-${width}.png`), fullPage: true });
    expect(unexpected).toEqual([]);
  });

  test(`resource refresh hands failure back to its actions and recovers after retry at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { unexpected, refreshRequests } = await setup(page, true);
    await page.goto("/#resources");
    const actions = page.getByRole("group", { name: "已接纳的规则文件 的操作", exact: true });
    const refresh = actions.getByRole("button", { name: "刷新文件", exact: true });
    await expect(actions.getByText("刷新失败", { exact: true })).toHaveCount(0);
    await refresh.focus();
    await refresh.press("Enter");
    const decision = page.getByRole("alertdialog");
    await settledTask(decision);
    await decision.getByRole("button", { name: "读取并接纳", exact: true }).click();
    await expect(decision.getByRole("alert")).toHaveText(refreshRequestFailure);
    // Includes hidden background DOM: only the current decision owns a live error.
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`resource-refresh-request-failure-${width}.png`), fullPage: true });
    await decision.press("Escape");
    await expect(decision).toHaveCount(0);
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveAccessibleDescription(resourceFailure);
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText(refreshRequestFailure);
    const shortStatus = actions.getByText("刷新失败", { exact: true });
    const fullReason = page.getByText(resourceFailure, { exact: true });
    await expect(fullReason).toHaveAttribute("id", await refresh.getAttribute("aria-describedby") || "missing-description");
    await expect(fullReason).not.toHaveAttribute("role", "alert");
    if (width === 390) await expect(shortStatus).toBeInViewport({ ratio: 1 });
    else await expect(shortStatus).not.toBeVisible();
    await page.screenshot({ path: info.outputPath(`resource-refresh-recovery-actions-${width}.png`), fullPage: true });
    await refresh.press("Enter");
    await settledTask(decision);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await decision.getByRole("button", { name: "取消", exact: true }).click();
    await expect(decision).toHaveCount(0);
    await expect(refresh).toBeFocused();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText(refreshRequestFailure);
    expect(refreshRequests).toHaveLength(1);
    const replace = actions.getByRole("button", { name: "替换文件", exact: true });
    await expect(replace).toHaveAccessibleDescription(resourceFailure);
    await replace.click();
    const replacement = page.getByRole("dialog", { name: "替换 已接纳的规则文件", exact: true });
    await settledTask(replacement);
    await replacement.getByRole("button", { name: "取消", exact: true }).click();
    await expect(replacement).toHaveCount(0);
    await expect(replace).toBeFocused();
    await expect(page.getByRole("alert")).toContainText(refreshRequestFailure);
    await refresh.focus();
    await refresh.press("Enter");
    await settledTask(decision);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await decision.getByRole("button", { name: "读取并接纳", exact: true }).click();
    await expect(decision).toHaveCount(0);
    await expect(refresh).toBeFocused();
    await expect(shortStatus).toHaveCount(0);
    await expect(fullReason).toHaveCount(0);
    await expect(page.getByText(refreshRequestFailure, { exact: true })).toHaveCount(0);
    await expect(refresh).not.toHaveAttribute("aria-describedby");
    await expect(replace).not.toHaveAttribute("aria-describedby");
    expect(refreshRequests).toEqual([
      "/api/me/resources/retained-rules/refresh",
      "/api/me/resources/retained-rules/refresh",
    ]);
    expect(unexpected).toEqual([]);
  });

}
