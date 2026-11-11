import { expect, test } from "./isolated-control-plane-fixture";
import { inviteSyntheticAccount, requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";

test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

for (const width of [390, 1440]) {
  test(`collection name prerequisite permits saving without sources at ${width}px`, async ({ page, playwright, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const origin = new URL(baseURL!).origin;
    const reads: string[] = [], writes: string[] = [], blocked: string[] = [];
    const measurements: unknown[] = [], failures: unknown[] = [];
    let allowedCreation = false;
    let collectionID: string | undefined;
    await page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const refuse = () => {
        blocked.push(`${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}`);
        return route.abort("blockedbyclient");
      };
      if (url.origin !== origin || url.search) return refuse();
      if (request.method() === "GET") {
        if (["/api/auth/me", "/api/me/collections", "/api/me/sources", "/api/me/inbox"].includes(url.pathname)) {
          reads.push(url.pathname);
          return route.continue();
        }
        if (url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") return route.continue();
        return refuse();
      }
      if (allowedCreation && writes.length === 0 && request.method() === "POST" && url.pathname === "/api/me/collections") {
        let body;
        try { body = request.postDataJSON(); } catch { return refuse(); }
        if (!body || typeof body.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(body.id) ||
          body.name !== "稍后添加来源" || !Array.isArray(body.sources) || body.sources.length ||
          !Array.isArray(body.steps) || body.steps.length) return refuse();
        collectionID = body.id;
        writes.push("POST /api/me/collections");
        return route.continue();
      }
      return refuse();
    });
    const admin = await playwright.request.newContext({ baseURL });
    const editor = page.getByRole("dialog", { name: "新建集合", exact: true });
    const name = editor.getByRole("textbox", { name: "集合名称", exact: true });
    const save = editor.getByRole("button", { name: "保存集合", exact: true });
    const capture = async (stage: string) => {
      // Original viewport only: never focus, scroll, hide chrome or mask controls.
      await info.attach(`collection-name-${width}-${stage}`, { body: await page.screenshot({ fullPage: false }), contentType: "image/png" });
    };
    const measure = async (stage: string) => {
      measurements.push({ stage, state: await editor.evaluate((element) => {
        const input = element.querySelector("input");
        const save = element.querySelector<HTMLButtonElement>('[aria-label="保存集合"]');
        return {
          fieldRequired: input?.getAttribute("aria-required"),
          fieldDescription: input?.getAttribute("aria-describedby"),
          saveDescription: save?.getAttribute("aria-describedby"),
          saveDisabled: save?.disabled,
          saveFocused: save === document.activeElement,
          focusInTask: element.contains(document.activeElement),
          fieldBounds: input?.getBoundingClientRect().toJSON(),
          saveBounds: save?.getBoundingClientRect().toJSON(),
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      }) });
    };
    try {
      // Fixed synthetic setup through the existing isolated normal-server helper.
      // APIRequestContext is not intercepted by browser routing; no arbitrary URL is used.
      await inviteSyntheticAccount(admin, page.request);
      await page.goto("/#collections");
      await page.getByRole("button", { name: "新建集合", exact: true }).first().click();
      await settledTask(editor);
      await capture("empty-original");
      await measure("empty-original");
      await expect(save).toBeDisabled();
      await expect(name).toHaveAttribute("aria-required", "true");
      await expect(name).toHaveAccessibleDescription("集合名称为必填项");
      await expect(save).toHaveAccessibleDescription("集合名称为必填项");
      await expect(editor.getByText("集合名称为必填项", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await name.fill("   ");
      await measure("whitespace");
      await expect(save).toBeDisabled();
      await expect(name).toHaveAccessibleDescription("集合名称为必填项");
      await name.fill("稍后添加来源");
      await measure("named-without-sources");
      await expect(editor.getByText("集合名称为必填项", { exact: true })).toHaveCount(0);
      await expect(editor.getByText("尚未选择来源", { exact: true })).toBeVisible();
      await expect(save).toBeEnabled();
      // Continue from real input focus using native Tab, never target.focus().
      const stops = await editor.locator('a[href],button,input,select,textarea,[tabindex]').count();
      for (let step = 0; step <= stops; step++) {
        if (await save.evaluate((element) => element === document.activeElement)) break;
        expect(await editor.evaluate((element) => element.contains(document.activeElement)), "Native Tab remains in task; no browser-chrome wrap").toBe(true);
        await page.keyboard.press("Tab");
      }
      await capture("before-keyboard-save");
      await measure("before-keyboard-save");
      await expect(save).toBeFocused();
      await expect(save).toBeInViewport({ ratio: 1 });
      allowedCreation = true;
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).origin === origin && new URL(response.url()).pathname === "/api/me/collections"),
        page.keyboard.press("Enter"),
      ]);
      allowedCreation = false;
      expect(response.status()).toBe(200);
      const saved = await response.json();
      expect(saved).toMatchObject({ id: collectionID, name: "稍后添加来源", sources: [], steps: [] });
      await expect(editor).toBeHidden();
      expect(collectionID).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
      // Exact guarded request ID, not a server-provided URL or arbitrary account.
      const persisted = await page.request.get(`/api/me/collections/${encodeURIComponent(collectionID!)}`, { maxRedirects: 0 });
      expect(persisted.status()).toBe(200);
      expect(await persisted.json()).toMatchObject({ id: collectionID, name: "稍后添加来源", sources: [], steps: [] });
      reads.push("GET created synthetic collection");
      expect(writes).toEqual(["POST /api/me/collections"]);
    } catch (error) {
      failures.push(error);
      // Preserve primary failure and its original viewport before diagnostics.
      try { await capture("failure-original"); } catch (error) { failures.push(error); }
      try { if (await editor.count()) await measure("failure-state"); } catch (error) { failures.push(error); }
    } finally {
      try { await capture("final-state"); } catch (error) { failures.push(error); }
      try {
        await info.attach("collection-name-ledger", { contentType: "application/json", body: JSON.stringify({
          viewport: page.viewportSize(), measurements, reads, writes, blocked,
          scope: "Isolated synthetic account; native keyboard creates one named collection with zero sources, then exact-ID API read. No external requests, source imports or live accounts.",
        }, null, 2) });
      } catch (error) { failures.push(error); }
      try { expect(blocked, "No external requests or unexpected reads/mutations, including failure paths").toEqual([]); } catch (error) { failures.push(error); }
      try { await admin.dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Collection prerequisite assertions and evidence failed");
  });
}
