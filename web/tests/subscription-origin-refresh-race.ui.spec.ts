import type { Locator, Page, Route } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { settledTask } from "./ui-settled-task";

// Built App/session seam; every API response and the one draft PUT are synthetic.
// No verification, activation, external request or API write reaches a server.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
const path = "/api/admin/subscription-origin";
const old = {
  revision: 4, configuredRevision: 2, effectiveRevision: 2,
  draftOrigin: "https://old.example", effectiveOrigin: "https://old.example", defaultOrigin: "",
  verificationStatus: "expired", tokensUnchanged: true,
  currentLinkExample: "https://old.example/feed/{existing-token}",
  proposedLinkExample: "https://old.example/feed/{existing-token}",
};
const saved = { ...old, revision: 5, configuredRevision: 5,
  draftOrigin: "https://new.example", verificationStatus: "unverified",
  proposedLinkExample: "https://new.example/feed/{existing-token}" };
const fresh = { ...saved, revision: 6, verificationStatus: "failed",
  lastFailure: "Could not verify this instance. Check public DNS, the HTTPS certificate and /feed routing, then verify again." };
async function tabTo(page: Page, target: Locator, direction: "forward" | "backward" = "forward") {
  await expect(target).toBeVisible();
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press(direction === "backward" ? "Shift+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}
for (const width of [390, 1440]) {
  test(`saved origin survives an older pending Refresh at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Synthetic origin recovery requires a loopback origin");
    const origin = new URL(baseURL).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "synthetic-admin", name: "Admin", role: "admin" }, csrfToken: "synthetic-origin" },
      "/api/settings": { name: "Origin fixture", timezone: "UTC+8", registration: "invite" },
      "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
      "/api/published-routes": [], "/api/services": [], "/api/rates": [],
    };
    const unexpected: string[] = [];
    const writes: { method: string; path: string; matchesExpectedDraft: boolean }[] = [];
    const responses: { method: string; path: string; status: number }[] = [];
    let reads = 0, errors = 0;
    let failed = false;
    let phase = "initial";
    const requests: { method: string; phase: string; read?: number }[] = [];
    const draftChecks: { expectedKeys: boolean; expectedOrigin: boolean; expectedRevision: boolean }[] = [];
    const checkpoints: { phase: string; reads: number; writes: number; documentFocused: boolean; inputFocused: boolean; saveFocused: boolean }[] = [];
    const section = page.getByRole("region", { name: "订阅域名设置", exact: true });
    const input = section.getByRole("textbox", { name: "订阅域名草稿", exact: true });
    const save = section.getByRole("button", { name: "保存域名草稿", exact: true });
    const checkpoint = async (next: string) => {
      phase = next;
      checkpoints.push({ phase, reads, writes: writes.length,
        documentFocused: await page.evaluate(() => document.hasFocus()),
        inputFocused: await input.evaluate(node => node === document.activeElement),
        saveFocused: await save.evaluate(node => node === document.activeElement),
      });
    };
    let held: Route | undefined;
    page.on("pageerror", () => errors++);
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname === path)
        responses.push({ method: response.request().method(), path, status: response.status() });
    });
    await page.context().route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      // Never record bodies, credentials, query values or external URLs.
      const label = `${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}${url.search ? "?redacted" : ""}`;
      const refuse = () => { unexpected.push(label); return route.abort("blockedbyclient"); };
      if (url.origin !== origin || url.search) return refuse();
      if (request.method() === "PUT" && url.pathname === path) {
        const body: unknown = request.postDataJSON();
        const check = {
          expectedKeys: !!body && typeof body === "object" && Object.keys(body).sort().join(",") === "expectedRevision,origin",
          expectedOrigin: !!body && typeof body === "object" && (body as { origin?: unknown }).origin === "https://new.example",
          expectedRevision: !!body && typeof body === "object" && (body as { expectedRevision?: unknown }).expectedRevision === 4,
        };
        draftChecks.push(check);
        requests.push({ method: "PUT", phase });
        const matchesExpectedDraft = check.expectedKeys && check.expectedOrigin && check.expectedRevision;
        writes.push({ method: "PUT", path, matchesExpectedDraft });
        if (!matchesExpectedDraft || writes.length !== 1) return refuse();
        return route.fulfill({ json: saved });
      }
      if (request.method() !== "GET") return refuse();
      if (url.pathname === path) {
        reads++;
        requests.push({ method: "GET", phase, read: reads });
        if (reads === 2) { held = route; return; }
        if (reads === 1) return route.fulfill({ json: old });
        if (reads === 3 && phase === "start-fresh-refresh") return route.fulfill({ json: fresh });
        return refuse();
      }
      if (Object.hasOwn(fixtures, url.pathname)) return route.fulfill({ json: fixtures[url.pathname] });
      if (url.pathname === "/" || url.pathname.startsWith("/assets/")) return route.continue();
      return refuse();
    });
    await page.setViewportSize({ width, height: 900 });
    try {
      await page.goto("/#settings");
      const refresh = section.getByRole("button", { name: "刷新状态", exact: true });
      const verify = section.getByRole("button", { name: "验证 HTTPS 与实例", exact: true });
      const activate = section.getByRole("button", { name: "启用已保存草稿", exact: true });
      const status = section.getByRole("status");
      const current = section.getByRole("term").filter({ hasText: /^当前链接示例$/ }).locator("xpath=following-sibling::dd");
      await expect(input).toHaveValue("https://old.example");
      await page.evaluate(() => {
        const events: { type: string; focused: boolean; visible: boolean; inputFocused: boolean }[] = [];
        (window as Window & { originFocusEvents?: typeof events }).originFocusEvents = events;
        const record = (event: Event) => events.push({ type: event.type,
          focused: document.hasFocus(), visible: document.visibilityState === "visible",
          inputFocused: document.activeElement?.getAttribute("aria-label") === "订阅域名草稿",
        });
        window.addEventListener("focus", record);
        window.addEventListener("blur", record);
        document.addEventListener("visibilitychange", record);
        document.addEventListener("focusin", record);
        document.addEventListener("focusout", record);
      });
      await tabTo(page, refresh);
      await checkpoint("start-old-refresh");
      await page.keyboard.press("Enter");
      await expect.poll(() => reads).toBe(2);
      expect(held).toBeDefined();
      // Input precedes Refresh. Reverse-tab within the form instead of wrapping
      // through browser chrome, which can trigger session revalidation.
      await tabTo(page, input, "backward");
      await checkpoint("edit-draft");
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("https://new.example");
      await expect(input).toHaveValue("https://new.example");
      await tabTo(page, save);
      await checkpoint("submit-draft");
      await page.keyboard.press("Space");
      await expect(status).toHaveText("域名草稿已保存，当前订阅地址未改变");
      expect(writes).toEqual([{ method: "PUT", path, matchesExpectedDraft: true }]);
      await checkpoint("release-old-refresh");
      // Release the old read only after saved-result UI has committed.
      const delivered = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === "GET");
      await held!.fulfill({ json: old });
      held = undefined;
      expect(await (await delivered).finished()).toBeNull();
      // Drain fetch notifications and React paint before asserting absence.
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0)));
      await settledTask(section);
      await expect(input).toHaveValue("https://new.example");
      await expect(section.getByText("尚未保存", { exact: true })).toHaveCount(0);
      await expect(section.getByText(saved.proposedLinkExample, { exact: true })).toBeVisible();
      await expect(section.getByText("尚未验证草稿", { exact: true })).toBeVisible();
      await expect(status).toHaveText("域名草稿已保存，当前订阅地址未改变");
      await expect(verify).toBeEnabled();
      await expect(activate).toBeDisabled();
      await expect(current).toHaveText(old.currentLinkExample);
      await info.attach(`synthetic-origin-retained-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      // The fence must not prevent later deliberate authoritative reads.
      await tabTo(page, refresh);
      await checkpoint("start-fresh-refresh");
      await page.keyboard.press("Enter");
      await expect(section.getByText("草稿验证未通过", { exact: true })).toBeVisible();
      await expect(section.getByText("无法确认此地址指向当前实例", { exact: true })).toBeVisible();
      await expect(section.getByText("请检查公开 DNS、HTTPS 证书和 /feed 路由，然后重新验证。", { exact: true })).toBeVisible();
      await expect(section.getByText(saved.proposedLinkExample, { exact: true })).toBeVisible();
      await expect(status).toHaveCount(0);
      await expect(input).toHaveValue("https://new.example");
      await expect(section.getByText("尚未保存", { exact: true })).toHaveCount(0);
      await expect(verify).toBeEnabled();
      await expect(activate).toBeDisabled();
      await expect(current).toHaveText(old.currentLinkExample);
      await expect(page.getByRole("dialog", { name: "启用订阅地址", exact: true })).toHaveCount(0);
      expect(reads).toBe(3);
      expect(writes).toHaveLength(1);
      expect(unexpected).toEqual([]);
      expect(errors).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await settledTask(section);
      await info.attach(`synthetic-origin-fresh-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Persist the failing phase before aborting the held read changes the UI.
      if (failed && !page.isClosed()) {
        try {
          await info.attach(`synthetic-origin-failure-${width}`, {
            body: await page.screenshot({ fullPage: true }), contentType: "image/png",
          });
        } catch {
          // Diagnostic capture must not replace the original assertion failure.
        }
      }
      const focusEvents = page.isClosed() ? [] : await page.evaluate(() =>
        (window as Window & { originFocusEvents?: unknown[] }).originFocusEvents || []);
      await info.attach("synthetic-origin-request-metadata", {
        body: JSON.stringify({ phase, reads, writes, draftChecks, requests, checkpoints, focusEvents, responses, unexpected, pageErrors: errors }), contentType: "application/json",
      });
      if (held) await held.abort("blockedbyclient");
    }
  });
}
