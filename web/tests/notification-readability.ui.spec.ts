import { test, expect, type Page } from "@playwright/test";

// Actual production views with explicit API-boundary fixtures, not backend acceptance.
// No messages are sent, read receipts persisted, or credentials exercised.
test.use({ trace: "off", screenshot: "off", video: "off" });
const title = "服务维护通知：东京与伦敦线路的维护安排和恢复时间";
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "visual-admin", name: "本地审查管理员", role: "admin" },
    csrfToken: "local-fixture",
  },
  "/state": {
    users: [],
    nodes: [],
    routes: [],
    revisions: [],
    capabilities: [],
  },
  "/services": [],
  "/settings": {},
  "/published-routes": [],
  "/rates": [],
  "/user-groups": [],
  "/me/notifications": [
    {
      eventId: "read",
      title,
      body: "请在维护结束后检查连接；这条消息保留完整内容供打开后阅读。",
      createdAt: "2026-10-25T10:00:00Z",
      readAt: "2026-10-25T11:00:00Z",
    },
    {
      eventId: "unread",
      title: "额度提醒",
      body: "当月流量已使用 80%。",
      createdAt: "2026-10-26T09:00:00Z",
    },
  ],
  "/admin/announcements": [
    {
      id: "announcement",
      title: "服务维护通知",
      body: "本地审查公告",
      audience: "all",
      userIds: [],
      startsAt: "2026-10-25T10:00:00Z",
      expiresAt: "2026-11-01T10:00:00Z",
      enabled: true,
    },
  ],
  "/admin/notifications/outbox": [
    {
      eventId: "delivery",
      title: "额度提醒",
      channel: "email",
      status: "failed",
      attempts: 3,
      lastError: "无法连接邮件服务器",
      createdAt: "2026-10-26T09:00:00Z",
    },
  ],
};
async function setup(page: Page) {
  const unexpected: string[] = [];
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Controlled readability QA requires a loopback base URL");
  const origin = new URL(baseURL).origin;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push(`external ${route.request().resourceType()}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    if (route.request().method() !== "GET" || !(path in fixtures)) {
      unexpected.push(`${route.request().method()} ${path}`);
      return route.fulfill({
        status: 503,
        json: { message: "Unexpected controlled readability request" },
      });
    }
    return route.fulfill({ json: fixtures[path] });
  });
  return unexpected;
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

for (const width of [1440, 390])
  test(`inbox read state and full-width narrow content at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const unexpected = await setup(page);
    await page.goto("/#inbox");
    const row = page.getByRole("button", {
      name: new RegExp(`${title}.*已读`),
    });
    await expect(row.getByText("已读", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: /额度提醒.*未读/ })
        .getByText("未读", { exact: true }),
    ).toBeVisible();
    const content = row.getByText(
        "请在维护结束后检查连接；这条消息保留完整内容供打开后阅读。",
        { exact: true },
      ),
      metadata = row.getByText("已读", { exact: true });
    await expect(row.getByText(title, { exact: true })).toBeVisible();
    if (width === 390) {
      const bodyBox = await content.boundingBox(),
        metadataBox = await metadata.boundingBox();
      expect(bodyBox!.width).toBeGreaterThan(250);
      expect(metadataBox!.y).toBeGreaterThanOrEqual(
        bodyBox!.y + bodyBox!.height,
      );
    }
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`inbox-read-state-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await row.click();
    await expect(
      page
        .getByRole("dialog", { name: title })
        .getByText(
          "请在维护结束后检查连接；这条消息保留完整内容供打开后阅读。",
          { exact: true },
        ),
    ).toBeVisible();
    expect(unexpected).toEqual([]);
  });

test("narrow announcement and delivery tables disclose scrolling and retain actions and failure reasons", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpected = await setup(page);
  await page.goto("/#notifications");
  await expect(
    page.getByText("向左右滚动查看完整表格", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("announcements-scroll-hint-390.png"),
    fullPage: true,
    animations: "disabled",
  });
  const edit = page.getByRole("button", { name: /编\s*辑/ });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "编辑公告" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "编辑公告" }),
  ).not.toBeVisible();
  await page.getByRole("tab", { name: "发送记录", exact: true }).click();
  await expect(
    page.getByText("向左右滚动查看完整表格", { exact: true }),
  ).toBeVisible();
  const reason = page.getByRole("cell", {
    name: "无法连接邮件服务器",
    exact: true,
  });
  await reason.scrollIntoViewIfNeeded();
  await expect(reason).toBeInViewport();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("delivery-failure-reason-390.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(unexpected).toEqual([]);
});

test("default rate policy remains readable as active information, not disabled text", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpected = await setup(page);
  await page.goto("/#services");
  const policy = page.getByText("未设置倍率版本的线路按 1× 扣量", {
    exact: true,
  });
  await expect(policy).toBeVisible();
  const observed = await policy.evaluate((element) => {
    const style = getComputedStyle(element);
    let background = "rgb(255, 255, 255)";
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        background = color;
        break;
      }
    }
    // shadcn semantic tokens compute to oklch in modern Chromium. Convert
    // through the browser color pipeline rather than interpreting L/C/H as RGB.
    const rgba = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data);
      return [...channels.slice(0, 3), channels[3] / 255];
    };
    return {
      foreground: style.color,
      background,
      fontSize: style.fontSize,
      foregroundRGBA: rgba(style.color),
      backgroundRGBA: rgba(background),
    };
  });
  const bg = observed.backgroundRGBA,
    fg = observed.foregroundRGBA;
  const alpha = fg[3] ?? 1;
  const luminance = (channels: number[]) =>
    channels
      .slice(0, 3)
      .map((value) => {
        const n = value / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      })
      .reduce(
        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
        0,
      );
  const a = luminance(
      fg.map((value, index) => value * alpha + bg[index] * (1 - alpha)),
    ),
    b = luminance(bg);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  await info.attach("rate-policy-contrast", {
    body: JSON.stringify({ ...observed, ratio }),
    contentType: "application/json",
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("rate-policy-readable-390.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(unexpected).toEqual([]);
});
