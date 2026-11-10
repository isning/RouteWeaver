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
  "/admin/notification-settings": {
    revision: 1,
    inApp: true,
    quotaPercent: [80, 95],
    expiryHours: [24, 72],
    providerRemainingPercent: [10],
    repeatHours: 24,
    email: {
      enabled: false,
      automatic: false,
      host: "",
      port: 587,
      tlsMode: "starttls",
      username: "",
      from: "",
      to: [],
    },
    webhook: { enabled: false, automatic: false, url: "" },
    smtpPasswordSet: false,
    webhookSecretSet: false,
  },
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
      kind: "test",
      title: "RouteWeaver notification test",
      channel: "email",
      status: "failed",
      attempts: 5,
      nextAttemptAt: "2026-10-26T09:31:00Z",
      lastError: "channel delivery failed; verify destination, credentials and TLS, then test again",
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
// An exact origin-qualified URL prevents a later route handler from shadowing
// setup's external-origin denial for the same pathname on another host.
function announcementURL() {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("Controlled notification QA requires baseURL");
  return new URL("/api/admin/announcements", baseURL).href;
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
  const viewport = page.getByRole("region", {
    name: "表格滚动区域",
    exact: true,
  });
  await expect(viewport).toHaveAttribute("tabindex", "0");
  expect(await viewport.evaluate((element) => element.scrollWidth)).toBeGreaterThanOrEqual(760);
  await viewport.focus();
  await expect(viewport).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const reason = page.getByText("已停止自动重试。接收方是否已接收尚未确认。", {
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

// Public UI/API boundary regression. This complements the real, unmapped empty
// outbox in the route inventory; fixture responses do not establish delivery.
for (const width of [1440, 390, 320])
  test(`outbox loading and failure stay distinct from a viewport-visible empty result at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const unexpected = await setup(page);
    const outboxURL = new URL(
      "/api/admin/notifications/outbox",
      test.info().project.use.baseURL,
    ).href;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let failed = true;
    let reads = 0;
    await page.route(outboxURL, async (route) => {
      if (route.request().method() !== "GET") {
        unexpected.push("unexpected outbox write");
        return route.abort();
      }
      reads++;
      await gate;
      return route.fulfill(failed
        ? { status: 503, json: { message: "发送记录暂时无法读取，请重试" } }
        : { json: [] });
    });
    const empty = page.getByText("暂无发送记录", { exact: true });
    const count = page.getByText("已加载 0 项", { exact: true });
    try {
      await page.goto("/#notifications");
      await page.getByRole("tab", { name: "发送记录", exact: true }).click();
      await expect.poll(() => reads).toBeGreaterThan(0);
      const loading = page.getByRole("status", { name: "正在加载", exact: true });
      await expect(loading).toBeVisible();
      await expect(empty).toHaveCount(0);
      await expect(count).toHaveCount(0);
      release();
      await expect(page.getByText("发送记录暂时无法读取，请重试", { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(loading).toHaveCount(0);
      await expect(empty).toHaveCount(0);
      await expect(count).toHaveCount(0);
      failed = false;
      const priorReads = reads;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(empty).toBeInViewport({ ratio: 1 });
      await expect(count).toBeInViewport({ ratio: 1 });
      expect(reads).toBeGreaterThan(priorReads);
      await expect(page.getByText("发送记录暂时无法读取，请重试", { exact: true })).toHaveCount(0);
      await expect(page.getByText("向左右滚动查看完整表格", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "表格滚动区域", exact: true })).toHaveCount(0);
      await noOverflow(page);
      await page.screenshot({
        path: info.outputPath(`outbox-authoritative-empty-fixture-${width}.png`),
        fullPage: true,
      });
      // Touch/trackpad scrolling is possible without a keyboard scroll region.
      // The empty fact must remain visible at the right edge too.
      const viewport = page.locator('[data-slot="table-container"]');
      if (width === 1440) {
        expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      }
      await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      if (width < 1440) {
        expect(await viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      await expect(empty).toBeInViewport({ ratio: 1 });
      await expect(count).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath(`outbox-authoritative-empty-scrolled-fixture-${width}.png`),
        fullPage: true,
      });
      // Keep the authoritative message visible after both narrow and wide resizes.
      for (const resizedWidth of [width < 1440 ? 1440 : 390, width]) {
        await page.setViewportSize({ width: resizedWidth, height: 900 });
        await expect(empty).toBeInViewport({ ratio: 1 });
        await expect(count).toBeInViewport({ ratio: 1 });
        if (resizedWidth === 1440) {
          expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        }
        await noOverflow(page);
      }
      expect(pageErrors, "Empty-state resizes must not trigger rendering or ResizeObserver errors").toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      release();
    }
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

test("inbox failure stays with its message across repeated keyboard close at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const unexpected = await setup(page);
  const markReadURL = new URL("/api/me/notifications/unread/read", test.info().project.use.baseURL).href;
  await page.route(markReadURL, (route) => {
    if (route.request().method() !== "POST") {
      unexpected.push(`${route.request().method()} /me/notifications/unread/read`);
      return route.abort();
    }
    return route.fulfill({ status: 503, json: { message: "额度提醒未能标记已读" } });
  });
  await page.goto("/#inbox");
  const unread = page.getByRole("button", { name: /额度提醒.*未读/ });
  await unread.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("dialog", { name: "额度提醒" })
      .getByText("额度提醒未能标记已读"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(unread).toBeFocused();
  const read = page.getByRole("button", { name: new RegExp(`${title}.*已读`) });
  for (let attempt = 0; attempt < 2; attempt++) {
    await read.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("额度提醒未能标记已读")).toHaveCount(0);
    await expect(
      dialog.getByText(
        "请在维护结束后检查连接；这条消息保留完整内容供打开后阅读。",
      ),
    ).toBeVisible();
    await noOverflow(page);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(read).toBeFocused();
  }
  expect(unexpected).toEqual([]);
});

// Actual App/session defaults remain active. Start a visible list refresh before
// opening a cached, already-read message; no offline switch or hidden control is
// needed. Both failed GET attempts are distinct from any mark-read mutation.
for (const width of [1440, 390]) {
  test(`open inbox preserves content and keyboard focus through list refresh recovery at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const unexpected = await setup(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const inboxURL = new URL("/api/me/notifications", info.project.use.baseURL).href;
    const cachedBody = "请在维护结束后检查连接；这条消息保留完整内容供打开后阅读。";
    const recoveredBody = "维护已结束。东京与伦敦线路已恢复，请重新检查连接。完整维护消息仍可在这里阅读。";
    let reads = 0;
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    await page.route(inboxURL, async (route) => {
      if (route.request().method() !== "GET") {
        unexpected.push(`${route.request().method()} /me/notifications`);
        return route.abort();
      }
      reads++;
      if (reads === 1) return route.fulfill({ json: fixtures["/me/notifications"] });
      if (reads <= 3) {
        await failureGate;
        return route.fulfill({ status: 503, json: { message: "消息列表暂时无法读取" } });
      }
      if (reads === 4) {
        await recoveryGate;
        return route.fulfill({ json: [
          { eventId: "read", title, body: recoveredBody, createdAt: "2026-10-25T10:00:00Z", readAt: "2026-10-25T11:00:00Z" },
          { eventId: "unread", title: "额度提醒", body: "当月流量已使用 80%。", createdAt: "2026-10-26T09:00:00Z" },
        ] });
      }
      unexpected.push("extra inbox GET");
      return route.abort();
    });
    try {
      await page.goto("/#inbox");
      const row = page.getByRole("button", { name: new RegExp(`${title}.*已读`) });
      await expect(row).toBeVisible();
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await expect.poll(() => reads).toBe(2);
      await expect(page.getByText("正在刷新消息，列表仍为上次读取结果。", { exact: true })).toBeVisible();
      await row.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog.getByText(cachedBody, { exact: true })).toBeVisible();
      await expect(dialog.getByText("正在核对消息，当前显示上次读取内容。", { exact: true })).toBeVisible();
      releaseFailure();
      const failure = dialog.getByText("消息刷新失败，当前显示上次读取内容。", { exact: true });
      await expect(failure).toBeInViewport({ ratio: 1 });
      expect(reads, "The production query performs one automatic read retry").toBe(3);
      const retry = dialog.getByRole("button", { name: "重试刷新", exact: true });
      const close = dialog.getByRole("button", { name: "关闭", exact: true });
      await expect(close).toBeFocused();
      for (let step = 0; step < 4 && !(await retry.evaluate((element) => element === document.activeElement)); step++) {
        await page.keyboard.press("Tab");
      }
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByText(cachedBody, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: /标记已读/ })).toHaveCount(0);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath(`inbox-list-refresh-failed-controlled-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Enter");
      await expect.poll(() => reads).toBe(4);
      await expect(dialog.getByText("正在核对消息，当前显示上次读取内容。", { exact: true })).toBeVisible();
      await expect(dialog.getByText(cachedBody, { exact: true })).toBeVisible();
      releaseRecovery();
      await expect(dialog.getByText(recoveredBody, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(failure).toHaveCount(0);
      await expect(retry).toHaveCount(0);
      // Do not repair focus from the test after the focused retry disappears.
      // The sheet itself is a meaningful reading context; its Close is also a
      // valid destination. Body/background focus would fail this contract.
      await expect.poll(() => dialog.evaluate((element) => {
        const active = document.activeElement;
        return active === element || (active instanceof HTMLElement && element.contains(active) && !active.matches(":disabled,[aria-disabled=true]"));
      })).toBe(true);
      await expect(page.locator(":focus")).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: /标记已读/ })).toHaveCount(0);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath(`inbox-list-refresh-recovered-controlled-${width}.png`), animations: "disabled" });
      // Continued keyboard navigation remains trapped inside the open message.
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(row.getByText("已读", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /额度提醒.*未读/ })).toBeVisible();
      expect(reads).toBe(4);
      expect(unexpected, "All writes (including mark-read POSTs) and unexpected reads are denied").toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      releaseFailure();
      releaseRecovery();
    }
  });
}

// Rendering evidence only: every API read is fulfilled with the bounded fixture
// above. No save, send, delivery or backend persistence is inferred from pixels.
for (const width of [1440, 390]) {
  test(`notification settings and delivery hierarchy at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const unexpected = await setup(page);
    await page.goto("/#notifications");
    await page.getByRole("tab", { name: "提醒与渠道", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "保存通知设置", exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`notification-reminders-fixture-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "邮件通知", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "发送邮件测试", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Webhook 通知", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "发送 Webhook 测试", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("HTTPS Webhook 地址", { exact: true }),
    ).toHaveValue("");
    // Wait for finite accordion expansion before recording its final layout.
    await expect
      .poll(() =>
        page
          .locator('[data-slot="accordion-content"]')
          .evaluateAll((elements) =>
            elements.every((element) =>
              element.getAnimations().every((a) => a.playState !== "running"),
            ),
          ),
      )
      .toBe(true);
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(
        `notification-channels-expanded-fixture-${width}.png`,
      ),
      fullPage: true,
    });
    await page.getByRole("tab", { name: "发送记录", exact: true }).click();
    await expect(
      page.getByText("已停止自动重试。接收方是否已接收尚未确认。", { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(
        `notification-delivery-failed-fixture-${width}.png`,
      ),
    });
    expect(unexpected).toEqual([]);
  });

  test(`notification list loading failure and retry at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const unexpected = await setup(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = true;
    let reads = 0;
    await page.route(announcementURL(), async (route) => {
      if (route.request().method() !== "GET") {
        unexpected.push("unexpected announcement write");
        return route.abort();
      }
      reads++;
      await gate;
      return route.fulfill(
        failed
          ? { status: 503, json: { message: "公告暂时无法读取，请重试" } }
          : { json: fixtures["/admin/announcements"] },
      );
    });
    try {
      await page.goto("/#notifications");
      await expect.poll(() => reads).toBeGreaterThan(0);
      const loading = page.getByRole("status", {
        name: "正在加载",
        exact: true,
      });
      await expect(loading).toBeVisible();
      await expect(loading).toHaveAttribute("aria-busy", "true");
      await expect(page.getByText("服务维护通知", { exact: true })).toHaveCount(
        0,
      );
      await noOverflow(page);
      await page.screenshot({
        path: info.outputPath(`announcements-loading-controlled-${width}.png`),
      });
      release();
      await expect(
        page.getByText("公告暂时无法读取，请重试", { exact: true }),
      ).toBeVisible();
      await expect(loading).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(
          `announcements-read-error-controlled-${width}.png`,
        ),
      });
      failed = false;
      const priorReads = reads;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(
        page.getByRole("cell", { name: "服务维护通知", exact: true }),
      ).toBeVisible();
      expect(reads).toBeGreaterThan(priorReads);
      await expect(
        page.getByText("公告暂时无法读取，请重试", { exact: true }),
      ).toHaveCount(0);
      await noOverflow(page);
      await page.screenshot({
        path: info.outputPath(
          `announcements-recovered-controlled-${width}.png`,
        ),
      });
      expect(unexpected).toEqual([]);
    } finally {
      release();
    }
  });
}


test("announcement override cannot bypass external-origin denial", async ({ page }) => {
  const unexpected = await setup(page);
  let overriddenReads = 0;
  await page.route(announcementURL(), route => {
    overriddenReads++;
    return route.fulfill({ json: fixtures["/admin/announcements"] });
  });
  await page.goto("/#notifications");
  await expect(page.getByRole("cell", { name: "服务维护通知", exact: true })).toBeVisible();
  expect(overriddenReads).toBeGreaterThan(0);
  expect(unexpected).toEqual([]);
  const before = overriddenReads;
  // Deliberate blocked negative probe: setup aborts before network transmission.
  const result = await page.evaluate(async () => {
    try {
      await fetch("https://external-fixture.invalid/api/admin/announcements");
      return "fulfilled";
    } catch { return "blocked"; }
  });
  expect(result).toBe("blocked");
  expect(overriddenReads).toBe(before);
  expect(unexpected).toEqual(["external fetch"]);
});
