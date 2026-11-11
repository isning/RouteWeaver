import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

// Built App and native controls; all API traffic is synthetic and intercepted.
// No accounts, private source material, backend publication or deployment.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const reviewLabel = "我已检查内容，确认可以供工作空间用户使用";
const invalidMessage = "模板结构不是有效的 JSON，请先修正。";
const corrected = '{"steps":[]}';

async function tabTo(page: Page, dialog: Locator, target: Locator) {
  for (let step = 0; step < 30; step++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    const backwards = await target.evaluate(el => !!(document.activeElement?.compareDocumentPosition(el)! & Node.DOCUMENT_POSITION_PRECEDING));
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await expect(target).toBeFocused();
}

for (const width of [1440, 390]) {
  test(`template malformed JSON recovers to editing and renews review at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "admin", name: "Template admin", role: "admin" }, csrfToken: "synthetic-template-csrf" },
      "/api/templates": [],
      "/api/me/template-bindings": [],
      "/api/me/profiles": [],
      "/api/me/collections": [{ id: "saved-collection", name: "Saved collection", sources: [], pipeline: [] }],
      "/api/me/inbox": [],
    };
    const blocked: string[] = [];
    const reads: string[] = [];
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("requestfailed", request => browserErrors.push(`transport-failed ${new URL(request.url()).origin === origin ? new URL(request.url()).pathname : "external-origin"}`));
    const writes: { path: string; body: unknown }[] = [];
    await page.context().route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const refuse = () => {
        blocked.push(`${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}`);
        return route.abort("blockedbyclient");
      };
      if (url.origin !== origin || url.search) return refuse();
      if (request.method() === "POST") {
        const body: unknown = request.postDataJSON();
        if (url.pathname === "/api/admin/templates/sanitize" && JSON.stringify(body) === JSON.stringify({ kind: "processing-preset", targetId: "saved-collection" })) {
          writes.push({ path: url.pathname, body });
          return route.fulfill({ json: { spec: { steps: [] } } });
        }
        if (url.pathname === "/api/admin/templates" && body && typeof body === "object") {
          const input = body as Record<string, unknown>;
          if (Object.keys(input).sort().join(",") === "expectedVersion,id,kind,name,spec" &&
              typeof input.id === "string" && /^template_[a-zA-Z0-9_-]+$/.test(input.id) &&
              input.name === "Retained template" && input.kind === "processing-preset" && input.expectedVersion === 0 && JSON.stringify(input.spec) === corrected) {
            writes.push({ path: url.pathname, body });
            return route.fulfill({ status: 503, json: { detail: "Synthetic publication unavailable" } });
          }
        }
        return refuse();
      }
      if (request.method() !== "GET") return refuse();
      if (/^\/api(?:\/|$)/.test(url.pathname)) {
        if (!Object.hasOwn(fixtures, url.pathname)) return refuse();
        reads.push(url.pathname);
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      if (!(url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico")) return refuse();
      return route.continue();
    });
    const inventory = new Inventory(page, info, "admin", "templates");
    const failures: unknown[] = [];
    const measurements: unknown[] = [];
    const dialog = page.getByRole("dialog", { name: "发布共享模板", exact: true });
    const shared = dialog.getByRole("textbox", { name: "共享结构", exact: true });
    // Capture original viewport and geometry before recovery assertions. These
    // independent evidence failures cannot replace the primary task failure.
    const capture = async (stage: string) => {
      try {
        if (process.env.CI) await info.attach(`template-json-${width}-${stage}.png`, { body: await page.screenshot(), contentType: "image/png" });
      } catch (error) { failures.push(error); }
      try {
        measurements.push({ stage, geometry: await dialog.evaluate(element => {
          const mode = element.getAttribute("data-task-scroll");
          const scroller = mode === "task" ? element : element.querySelector<HTMLElement>("[data-task-overlay-body]");
          const field = element.querySelector("textarea");
          const error = element.querySelector("#template-structure-error");
          return {
            mode,
            dialog: element.getBoundingClientRect().toJSON(),
            rail: scroller ? { box: scroller.getBoundingClientRect().toJSON(), top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null,
            field: field?.getBoundingClientRect().toJSON(),
            error: error?.getBoundingClientRect().toJSON(),
            focused: field === document.activeElement,
          };
        }, undefined, { timeout: 500 }) });
      } catch (error) { failures.push(error); }
    };
    try {
      await page.goto("/#templates");
      await page.getByRole("button", { name: "发布模板", exact: true }).click();
      await inventory.stable(dialog);
      const name = dialog.getByRole("textbox", { name: "模板名称", exact: true });
      await name.fill("Retained template");
      const source = dialog.getByRole("combobox", { name: "从自己的已保存配置提取", exact: true });
      await tabTo(page, dialog, source);
      await page.keyboard.press("Enter");
      const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
      await expect(search).toBeFocused();
      await search.fill("Saved collection");
      await expect(page.getByRole("option", { name: "Saved collection", exact: true })).toHaveCount(1);
      await page.keyboard.press("Enter");
      // Selection closes a portaled focus scope only after its exit motion.
      // Observe detachment and natural focus return before the next Tab journey.
      await expect(source).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
      await expect(source).toBeFocused();
      const extract = dialog.getByRole("button", { name: "提取可共享结构", exact: true });
      await tabTo(page, dialog, extract);
      await page.keyboard.press("Enter");
      await expect(shared).toHaveValue(JSON.stringify({ steps: [] }, null, 2));
      const review = dialog.getByRole("checkbox", { name: reviewLabel, exact: true });
      const publish = dialog.getByRole("button", { name: "发布 v1", exact: true });
      await shared.fill("{");
      await tabTo(page, dialog, review);
      await page.keyboard.press("Space");
      for (let attempt = 1; attempt <= 2; attempt++) {
        await tabTo(page, dialog, publish);
        await inventory.stable(dialog);
        await capture(`invalid-${attempt}-before`);
        await page.keyboard.press("Enter");
        await capture(`invalid-${attempt}-after`);
        await expect(shared).toBeFocused();
        await expect(shared).toHaveAttribute("aria-invalid", "true");
        const error = dialog.getByRole("alert").filter({ hasText: invalidMessage });
        await expect(error).toHaveText(invalidMessage);
        expect((await shared.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(await error.getAttribute("id"));
        await inventory.stable(dialog);
        await inventory.inView(shared);
        await inventory.inView(error);
        await expect(shared).toHaveValue("{");
        await expect(name).toHaveValue("Retained template");
        await expect(source).toContainText("Saved collection");
        expect(writes.filter(w => w.path === "/api/admin/templates")).toHaveLength(0);
      }
      await shared.fill(corrected);
      await expect(dialog.getByText(invalidMessage, { exact: true })).toHaveCount(0);
      await expect(shared).not.toHaveAttribute("aria-invalid", "true");
      await expect(review).not.toBeChecked();
      await expect(publish).toBeDisabled();
      await tabTo(page, dialog, review);
      await page.keyboard.press("Space");
      await expect(publish).toBeEnabled();
      // Reverse native traversal from review to extraction, without a focus shim.
      await page.keyboard.press("Shift+Tab");
      await expect(shared).toBeFocused();
      await tabTo(page, dialog, extract);
      await page.keyboard.press("Enter");
      await expect(shared).toHaveValue(JSON.stringify({ steps: [] }, null, 2));
      await expect(review).not.toBeChecked();
      await expect(publish).toBeDisabled();
      await expect(name).toHaveValue("Retained template");
      await expect(source).toContainText("Saved collection");
      await capture("replacement-unreviewed");
      expect(writes.filter(w => w.path === "/api/admin/templates")).toHaveLength(0);
      await tabTo(page, dialog, review);
      await page.keyboard.press("Space");
      await tabTo(page, dialog, publish);
      await page.keyboard.press("Enter");
      await expect(dialog.getByText("Synthetic publication unavailable", { exact: true })).toBeVisible();
      await expect(shared).toHaveValue(JSON.stringify({ steps: [] }, null, 2));
      await expect(name).toHaveValue("Retained template");
      expect(writes.filter(w => w.path === "/api/admin/templates")).toHaveLength(1);
      expect(writes.filter(w => w.path.endsWith("/sanitize"))).toHaveLength(2);
      await capture("retained-after-server-failure");
    } catch (error) { failures.push(error); }
    finally {
      await capture("final-state");
      try {
        if (process.env.CI) await info.attach("template-json-recovery-evidence", {
          contentType: "application/json",
          body: JSON.stringify({ viewport: page.viewportSize(), measurements, reads, writes, blocked, browserErrors,
            scope: "Built App, synthetic API boundaries, native keyboard correction and renewed review. No real publication or account data." }, null, 2),
        });
      } catch (error) { failures.push(error); }
      try { expect(blocked, "No unexpected requests, even after a failed assertion").toEqual([]); }
      catch (error) { failures.push(error); }
      // Inventory.finish is deliberately read-only; this task instead checks
      // its exact intercepted write contract and independent browser ledger.
      try { expect(browserErrors, "No browser errors or failed transports").toEqual([]); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Template JSON recovery and evidence failed");
  });
}
