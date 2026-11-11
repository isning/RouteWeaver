import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
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
  test(`route JSON recovery retains local intent at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "admin", name: "Route admin", role: "admin" }, csrfToken: "synthetic-route-csrf" },
      "/api/hosts": [], "/api/core-instances": [], "/api/managed-endpoints": [],
      "/api/links": [], "/api/server-deployments": [], "/api/me/inbox": [],
    };
    const reads: string[] = [], blocked: string[] = [], browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("requestfailed", request => browserErrors.push(`transport-failed ${new URL(request.url()).origin === origin ? new URL(request.url()).pathname : "external-origin"}`));
    await page.context().route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      const refuse = () => { blocked.push(`${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}`); return route.abort("blockedbyclient"); };
      if (url.origin !== origin || url.search || request.method() !== "GET") return refuse();
      if (/^\/api(?:\/|$)/.test(url.pathname)) {
        if (!Object.hasOwn(fixtures, url.pathname)) return refuse();
        reads.push(url.pathname);
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      if (!(url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico")) return refuse();
      return route.continue();
    });
    const inventory = new Inventory(page, info, "admin", "routes");
    const failures: unknown[] = [], measurements: unknown[] = [];
    const dialog = page.getByRole("dialog", { name: "服务端配置意图", exact: true });
    const field = dialog.getByRole("textbox", { name: "服务端配置意图 JSON 文本", exact: true });
    const capture = async (stage: string) => {
      try { if (process.env.CI) await info.attach(`route-json-${width}-${stage}.png`, { body: await page.screenshot({ timeout: 2000 }), contentType: "image/png" }); }
      catch (error) { failures.push(error); }
      try {
        if (await dialog.count()) measurements.push({ stage, geometry: await dialog.evaluate(el => {
          const scroller = el.getAttribute("data-task-scroll") === "task" ? el : el.querySelector<HTMLElement>("[data-task-overlay-body]");
          const field = el.querySelector("textarea");
          const error = el.querySelector('[role="alert"]');
          return { dialog: el.getBoundingClientRect().toJSON(), field: field?.getBoundingClientRect().toJSON(), error: error?.getBoundingClientRect().toJSON(),
            rail: scroller ? { box: scroller.getBoundingClientRect().toJSON(), top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight } : null,
            focused: document.activeElement === field };
        }, undefined, { timeout: 500 }) });
      } catch (error) { failures.push(error); }
    };
    try {
      await page.goto("/#routes", { timeout: 10000 });
      const heading = page.getByRole("heading", { name: "转发路径", level: 1, exact: true });
      await expect(heading).toBeVisible({ timeout: 5000 });
      // PageHeader puts title and actions in sibling wrappers. Scope to the
      // actual header, not the heading's immediate title-only parent.
      const header = page.getByRole("main").locator("header").filter({ has: heading });
      const opener = header.getByRole("button", { name: "新建转发路径", exact: true });
      await capture("route-page-before-open");
      await expect(opener).toBeVisible({ timeout: 5000 });
      await opener.click({ timeout: 5000 });
      const route = page.getByRole("dialog", { name: "新建转发路径", exact: true });
      await inventory.stable(route);
      const name = route.getByRole("textbox", { name: "转发路径名称", exact: true });
      await name.fill("Retained route");
      await route.getByRole("button", { name: "高级：完整服务端意图", exact: true }).click();
      await route.getByRole("button", { name: "编辑服务端意图", exact: true }).click();
      await inventory.stable(dialog);
      const corrected = JSON.stringify({ ...JSON.parse(await field.inputValue()), topologyRevision: "corrected-local-revision" }, null, 2);
      const apply = dialog.getByRole("button", { name: "应用到草稿", exact: true });
      for (const [stage, input, message] of [
        ["syntax-first", "invalid JSON", "请输入有效的 JSON，再应用到草稿。"],
        ["syntax-repeat", "invalid JSON", "请输入有效的 JSON，再应用到草稿。"],
        ["missing-programs", '{"schemaVersion":"1.0"}', "缺少 programs 数组"],
      ]) {
        await field.fill(input);
        await tabTo(page, dialog, apply);
        await capture(`${stage}-before`);
        const underlyingPosition = await route.evaluate(el => ({
          pageX: window.scrollX, pageY: window.scrollY,
          taskTop: el.scrollTop,
          bodyTop: el.querySelector<HTMLElement>("[data-task-overlay-body]")?.scrollTop,
        }));
        await page.keyboard.press("Enter");
        await capture(`${stage}-after`);
        await expect(field).toBeFocused();
        await expect(field).toHaveValue(input);
        await expect(field).toHaveAttribute("aria-invalid", "true");
        const error = dialog.getByRole("alert");
        await expect(error).toHaveText(message);
        await inventory.inView(error);
        expect(await route.evaluate(el => ({
          pageX: window.scrollX, pageY: window.scrollY,
          taskTop: el.scrollTop,
          bodyTop: el.querySelector<HTMLElement>("[data-task-overlay-body]")?.scrollTop,
        }))).toEqual(underlyingPosition);
        expect((await field.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(await error.getAttribute("id"));
        // The 22-row editor can exceed the viewport. Require usable visible
        // editing area inside its actual scroll rail, not the entire textarea.
        expect(await field.evaluate(el => {
          const dialog = el.closest('[role="dialog"]')!;
          const rail = dialog.getAttribute("data-task-scroll") === "task" ? dialog : dialog.querySelector("[data-task-overlay-body]")!;
          const box = el.getBoundingClientRect(), clip = rail.getBoundingClientRect();
          return Math.min(box.bottom, clip.bottom, innerHeight) - Math.max(box.top, clip.top, 0);
        })).toBeGreaterThanOrEqual(44);
        expect(blocked).toEqual([]);
      }
      await field.fill(corrected);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await tabTo(page, dialog, apply);
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(name).toHaveValue("Retained route");
      await route.getByRole("button", { name: "编辑服务端意图", exact: true }).click();
      await expect(field).toHaveValue(corrected);
      await field.fill("abandoned JSON");
      const cancel = dialog.getByRole("button", { name: "取消", exact: true });
      await tabTo(page, dialog, cancel);
      await page.keyboard.press("Enter");
      const discard = page.getByRole("alertdialog", { name: "放弃尚未应用的 JSON 修改？", exact: true });
      await tabTo(page, discard, discard.getByRole("button", { name: "放弃 JSON 修改", exact: true }));
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await route.getByRole("button", { name: "编辑服务端意图", exact: true }).click();
      await expect(field).toHaveValue(corrected);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await inventory.stable(dialog);
      await capture("reopened-retained-draft");
    } catch (error) { failures.push(error); }
    finally {
      await capture("final-state");
      try { if (process.env.CI) await info.attach("route-json-recovery-evidence", { contentType: "application/json", body: JSON.stringify({ viewport: page.viewportSize(), measurements, reads, blocked, browserErrors, scope: "Synthetic read-only API; native keyboard and local JSON draft only. No saved configuration or deployment." }, null, 2) }); }
      catch (error) { failures.push(error); }
      try { expect(blocked, "No unexpected requests, including writes").toEqual([]); } catch (error) { failures.push(error); }
      try { expect(browserErrors).toEqual([]); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Route JSON recovery and evidence failed");
  });
}
