import { writeFile } from "node:fs/promises";
import { type Locator, type Page, type TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback, signInAPI } from "./account-security-backend";

// Normal production HTTP + isolated encrypted repository. Only the first two
// browser saves fail at the transport boundary. No notification test is sent:
// every test-delivery request and every off-origin browser request is denied.
// The fresh repository has no events, and automatic channels stay off in every
// seed/browser write, so its ordinary worker has nothing external to dispatch.
// Synthetic values live only in memory/source, never in evidence or assertion
// diffs. Presence flags and nonsensitive settings prove public read persistence;
// this does not claim decrypted-secret inspection or external deliverability.
test.use({ trace: "off", screenshot: "off", video: "off" });
const firstSMTP = "synthetic-original-smtp-password";
const firstWebhook = "synthetic-original-webhook-signing-secret";
const nextSMTP = "synthetic-replacement-smtp-password";
const nextWebhook = "synthetic-replacement-webhook-signing-secret";
const channels = [
  {
    title: "邮件通知", replacement: "更新 SMTP 密码（留空保留已保存值）",
    clear: "清除已保存的 SMTP 密码", enabled: "启用邮件渠道",
    empty: "SMTP 密码", secret: nextSMTP,
    error: "请选择更新或清除 SMTP 密码，不能同时操作。",
  },
  {
    title: "Webhook 通知", replacement: "更新签名密钥（留空保留已保存值）",
    clear: "清除已保存的签名密钥", enabled: "启用 Webhook 渠道",
    empty: "签名密钥", secret: nextWebhook,
    error: "请选择更新或清除签名密钥，不能同时操作。",
  },
];
async function capture(page: Page, info: TestInfo, stage: string, width: number, fullPage = true) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({
    path: info.outputPath(`notification-channel-journey-${stage}-${width}.png`),
    fullPage,
    animations: "disabled",
    mask: [page.locator('input[autocomplete="new-password"], input[type="password"]')],
  });
}
// Read-only geometry at the current scroll position. Never focuses, scrolls or
// serializes input values/HTML. Five hit tests detect foreground obstruction.
async function visibility(target: Locator, outset = 0) {
  return target.evaluate((element, margin) => {
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + node.clientLeft);
        right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + node.clientTop);
        bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    const points = [[0.5, 0.5], [0.18, 0.18], [0.82, 0.18], [0.18, 0.82], [0.82, 0.82]].map(([x, y]) => {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      return !!hit && element.contains(hit);
    });
    return {
      box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      clip: { left, top, right, bottom }, viewport: { width: innerWidth, height: innerHeight },
      fullyInside: rect.width > 0 && rect.height > 0 &&
        rect.left - margin >= left - 0.5 && rect.right + margin <= right + 0.5 &&
        rect.top - margin >= top - 0.5 && rect.bottom + margin <= bottom + 0.5,
      unobscured: points.every(Boolean), points,
      focused: element === document.activeElement,
      focusVisible: element.matches(":focus-visible"), shadow: getComputedStyle(element).boxShadow,
    };
  }, outset);
}
async function captureTestConfirmation(dialog: Locator, info: TestInfo, width: number) {
  // A dialog-only original excludes masked background inputs that otherwise
  // paint magenta over the footer. Verify the entire cropped surface is safe.
  expect(await dialog.locator("input, textarea").count()).toBe(0);
  const text = await dialog.innerText();
  expect([firstSMTP, firstWebhook, nextSMTP, nextWebhook].some(secret => text.includes(secret))).toBe(false);
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().every(animation => animation.playState !== "running"))).toBe(true);
  const geometry = {
    dialog: await visibility(dialog),
    cancel: await visibility(dialog.getByRole("button", { name: "取消", exact: true })),
    send: await visibility(dialog.getByRole("button", { name: "发送测试", exact: true })),
  };
  expect(Object.values(geometry).every(target => target.fullyInside && target.unobscured)).toBe(true);
  await dialog.screenshot({ path: info.outputPath(`notification-channel-journey-cancel-test-dialog-${width}.png`), animations: "disabled" });
  await writeFile(info.outputPath(`notification-channel-journey-cancel-test-dialog-${width}.json`), JSON.stringify({ geometry, containsSecretInputs: false, savedDestination: true }, null, 2));
}
async function captureRecovery(page: Page, info: TestInfo, clear: Locator, error: Locator, index: number, width: number) {
  await expect.poll(() => clear.evaluate(element => element.getAnimations().every(animation => animation.playState !== "running"))).toBe(true);
  const geometry = {
    field: await visibility(clear.locator('xpath=ancestor::*[@role="group"][1]')),
    // Independent official-checkbox contract: a three-pixel outer focus ring.
    control: await visibility(clear, 3),
    error: await visibility(error),
  };
  // Save the actual current viewport even if the geometric acceptance fails.
  await capture(page, info, `conflict-${index}`, width, false);
  await writeFile(info.outputPath(`notification-channel-journey-conflict-${index}-${width}.json`), JSON.stringify({ geometry, sampled: "After production-owned focus and expansion; no test scrolling" }, null, 2));
  expect(geometry.control.focused && geometry.control.focusVisible).toBe(true);
  expect(geometry.control.shadow).toMatch(/(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/);
  expect(Object.values(geometry).every(target => target.fullyInside && target.unobscured)).toBe(true);
}
async function expand(page: Page, name: string) {
  const trigger = page.getByRole("button", { name, exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}
async function retained(input: Locator, secret: string) {
  // Boolean assertions deliberately avoid printing a secret on regression.
  expect((await input.inputValue()) === secret).toBe(true);
}
async function login(page: Page) {
  await page.goto("/#notifications");
  await page.getByLabel("账号", { exact: true }).fill("routeweaver");
  await page.getByLabel("密码", { exact: true }).fill(demoPassword);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "公告与通知", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "提醒与渠道", exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`notification channel secret choices retain drafts through cancellation and repeated save failures at ${width}px`, async ({
    page, request, baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const origin = new URL(baseURL!).origin;
    const blocked: string[] = [];
    const writes: Record<string, any>[] = [];
    let remainingFailures = 2;
    let releaseFirst: (() => void) | undefined;
    const firstFailure = new Promise<void>(resolve => { releaseFirst = resolve; });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        blocked.push("external request");
        return route.abort();
      }
      if (url.pathname === "/api/admin/notifications/test") {
        blocked.push("test delivery");
        return route.abort();
      }
      if (url.pathname === "/api/admin/notification-settings" && route.request().method() === "PUT") {
        const payload = route.request().postDataJSON();
        if (payload.email.automatic !== false || payload.webhook.automatic !== false) {
          blocked.push("automatic delivery settings");
          return route.abort();
        }
        writes.push(payload);
        if (remainingFailures > 0) {
          remainingFailures--;
          if (writes.length === 1) await firstFailure;
          return route.fulfill({ status: 503, json: { message: "通知设置暂时未保存，请重试。" } });
        }
      }
      return route.continue();
    });
    const session = await signInAPI(request, "routeweaver", demoPassword);
    const headers = { "X-CSRF-Token": session.csrfToken };
    const readSettings = async () => {
      const response = await request.get("/api/admin/notification-settings");
      expect(response.status()).toBe(200);
      const raw = await response.text();
      expect([firstSMTP, firstWebhook, nextSMTP, nextWebhook].some(secret => raw.includes(secret))).toBe(false);
      return JSON.parse(raw);
    };
    const initial = await readSettings();
    const seeded = await request.put("/api/admin/notification-settings", {
      headers,
      data: {
        ...initial,
        email: {
          enabled: true, automatic: false, host: "smtp.notifications.example.com", port: 587,
          tlsMode: "starttls", username: "fixture-user", from: "operator@example.test", to: ["reviewer@example.test"],
        },
        webhook: { enabled: true, automatic: false, url: "https://notifications.example.com/original" },
        smtpPassword: firstSMTP, webhookSecret: firstWebhook,
      },
    });
    expect(seeded.status()).toBe(200);
    const baseline = await readSettings();
    expect(baseline.smtpPasswordSet && baseline.webhookSecretSet).toBe(true);
    try {
      await login(page);
      for (const channel of channels) {
        await expand(page, channel.title);
        await retained(page.getByLabel(channel.replacement, { exact: true }), "");
      }
      await capture(page, info, "expanded", width);
      await page.getByLabel("SMTP 主机", { exact: true }).fill("smtp.updated.example.com");
      await page.getByLabel("HTTPS Webhook 地址", { exact: true }).fill("https://notifications.example.com/updated");
      for (const channel of channels) await page.getByLabel(channel.replacement, { exact: true }).fill(channel.secret);

      // An unsaved destination never changes the confirmed saved test target.
      // Cancel restores this editor without queuing even an in-app test.
      const testWebhook = page.getByRole("button", { name: "发送 Webhook 测试", exact: true });
      await testWebhook.click();
      const confirmation = page.getByRole("alertdialog", { name: "发送一条测试通知？", exact: true });
      await expect(confirmation.getByText("将向已保存的 Webhook https://notifications.example.com/original 发送测试内容。", { exact: true })).toBeVisible();
      await captureTestConfirmation(confirmation, info, width);
      await confirmation.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(testWebhook).toBeFocused();
      expect(writes.length).toBe(0);
      expect(blocked).toEqual([]);
      expect((await readSettings()).revision).toBe(baseline.revision);

      const save = page.getByRole("button", { name: "保存通知设置", exact: true });
      for (const [index, channel] of channels.entries()) {
        await page.getByRole("checkbox", { name: channel.clear, exact: true }).check();
        await page.getByRole("button", { name: channel.title, exact: true }).click();
        await save.focus();
        await page.keyboard.press("Enter");
        const clear = page.getByRole("checkbox", { name: channel.clear, exact: true });
        const recoveryError = page.getByText(channel.error, { exact: true });
        await expect(recoveryError).toBeVisible();
        await expect(clear).toBeFocused();
        await expect(clear).toHaveAttribute("aria-invalid", "true");
        await expect(clear).toBeInViewport();
        await retained(page.getByLabel(channel.replacement, { exact: true }), channel.secret);
        expect(writes.length).toBe(0);
        await captureRecovery(page, info, clear, recoveryError, index, width);
        // Retain the replacement by removing only the competing clear decision.
        await page.keyboard.press("Space");
        await expect(clear).not.toBeChecked();
      }
      await page.getByRole("tab", { name: "发送记录", exact: true }).click();
      await page.getByRole("tab", { name: "提醒与渠道", exact: true }).click();
      for (const channel of channels) await retained(page.getByLabel(channel.replacement, { exact: true }), channel.secret);
      await save.click();
      await expect.poll(() => writes.length).toBe(1);
      await expect(save).toBeDisabled();
      await expect(page.getByLabel("SMTP 主机", { exact: true })).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(writes.length).toBe(1);
      releaseFirst!();
      const saveError = page.getByText("通知设置暂时未保存，请重试。", { exact: true });
      await expect(saveError).toBeVisible();
      // Diagnostic evidence, not a viewport-visibility pass. Capture the user's
      // actual failure view before any test scroll or full-document screenshot.
      const saveFailureViewport = { error: await visibility(saveError), save: await visibility(save) };
      await capture(page, info, "save-error-current-viewport", width, false);
      await writeFile(info.outputPath(`notification-channel-journey-save-error-current-viewport-${width}.json`), JSON.stringify({
        sampled: "Immediately after held failure rendered; no test scrolling",
        geometry: saveFailureViewport,
        noticeFullyVisible: saveFailureViewport.error.fullyInside && saveFailureViewport.error.unobscured,
        requiresPixelReview: true,
      }, null, 2));
      for (const channel of channels) await retained(page.getByLabel(channel.replacement, { exact: true }), channel.secret);
      expect((await readSettings()).revision).toBe(baseline.revision);
      await capture(page, info, "save-error", width);
      await save.click();
      await expect.poll(() => writes.length).toBe(2);
      await expect(save).toBeEnabled();
      expect(JSON.stringify(writes[1]) === JSON.stringify(writes[0])).toBe(true);
      expect((await readSettings()).revision).toBe(baseline.revision);
      for (const channel of channels) await retained(page.getByLabel(channel.replacement, { exact: true }), channel.secret);
      const saved = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/notification-settings" && r.request().method() === "PUT" && r.status() === 200);
      await save.click();
      expect((await saved).status()).toBe(200);
      await expect(save).toBeEnabled();
      expect(writes.length).toBe(3);
      expect(writes.every(payload => JSON.stringify(payload) === JSON.stringify(writes[0]))).toBe(true);
      expect(writes[2].smtpPassword === nextSMTP && writes[2].webhookSecret === nextWebhook).toBe(true);
      expect("smtpPasswordSet" in writes[2] || "webhookSecretSet" in writes[2]).toBe(false);
      const replaced = await readSettings();
      expect(replaced.revision).toBe(baseline.revision + 1);
      expect(replaced.email.host).toBe("smtp.updated.example.com");
      expect(replaced.webhook.url).toBe("https://notifications.example.com/updated");
      expect(replaced.smtpPasswordSet && replaced.webhookSecretSet).toBe(true);
      for (const channel of channels) await retained(page.getByLabel(channel.replacement, { exact: true }), "");
      await page.reload();
      await page.getByRole("tab", { name: "提醒与渠道", exact: true }).click();
      for (const channel of channels) {
        await expand(page, channel.title);
        await retained(page.getByLabel(channel.replacement, { exact: true }), "");
      }
      await capture(page, info, "replacement-saved", width);

      // Blank replacements preserve saved secrets. Explicit removal requires
      // disabling both channels first, as the real server validates credentials.
      for (const channel of channels) {
        await page.getByRole("switch", { name: channel.enabled, exact: true }).uncheck();
        await page.getByRole("checkbox", { name: channel.clear, exact: true }).check();
      }
      const clearedResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/notification-settings" && r.request().method() === "PUT");
      await save.click();
      expect((await clearedResponse).status()).toBe(200);
      await expect(save).toBeEnabled();
      const cleared = await readSettings();
      expect(cleared.smtpPasswordSet || cleared.webhookSecretSet || cleared.email.enabled || cleared.webhook.enabled).toBe(false);
      expect(cleared.revision).toBe(replaced.revision + 1);
      expect(writes[3].smtpPassword === "" && writes[3].webhookSecret === "").toBe(true);
      await page.reload();
      await page.getByRole("tab", { name: "提醒与渠道", exact: true }).click();
      for (const channel of channels) {
        await expand(page, channel.title);
        await retained(page.getByLabel(channel.empty, { exact: true }), "");
        await expect(page.getByRole("checkbox", { name: channel.clear, exact: true })).toHaveCount(0);
      }
      await capture(page, info, "cleared-saved", width);
      const outbox = await request.get("/api/admin/notifications/outbox");
      expect(outbox.status()).toBe(200);
      const deliveries = await outbox.json();
      expect(Array.isArray(deliveries) && deliveries.length === 0).toBe(true);
      expect(blocked).toEqual([]);
      expect(writes.length).toBe(4);
      await writeFile(info.outputPath(`notification-channel-journey-evidence-${width}.json`), JSON.stringify({
        width, screenshotsMasked: true, isolatedRepository: true,
        conflictChoicesBlocked: 2, cancelledTestRequests: 0, externalRequests: 0,
        heldFailure: true, repeatedFailure: true, exactRetryPayload: true,
        saveFailureNoticeInViewport: saveFailureViewport.error.fullyInside && saveFailureViewport.error.unobscured,
        successfulBrowserWrites: 2, replacementPresenceReloaded: true,
        clearPresenceReloaded: true, finalOutboxCount: 0,
        limits: ["No external delivery", "No decrypted-secret inspection", "No process restart", "Populated outbox belongs to a separate fixture review"],
      }, null, 2));
    } finally {
      releaseFirst?.();
    }
  });
}
