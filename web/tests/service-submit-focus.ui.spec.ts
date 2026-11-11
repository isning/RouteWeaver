import type { Locator } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

// Production-built App/provider composition, synthetic authenticated GETs only.
// Native browser acceptance, not backend persistence or entitlement acceptance.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});

async function geometry(dialog: Locator, field: Locator) {
  const mode = await dialog.getAttribute("data-task-scroll");
  expect(["body", "task"]).toContain(mode);
  const scroller =
    mode === "task" ? dialog : dialog.locator("[data-task-overlay-body]");
  const rail = await scroller.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      top: box.top + element.clientTop,
      bottom: box.top + element.clientTop + element.clientHeight,
      offset: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    };
  });
  return { mode, rail, field: await field.boundingBox() };
}

for (const width of [1440, 390]) {
  test(`service plan invalid Preview returns to its name at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "service-admin", name: "Service admin", role: "admin" },
        csrfToken: "synthetic-service-csrf",
      },
      "/api/state": {
        nodes: [],
        users: [],
        routes: [],
        revisions: [],
        capabilities: [],
      },
      "/api/settings": { name: "Policy fixture", registration: "invite" },
      "/api/published-routes": [],
      "/api/services": [],
      "/api/rates": [],
    };
    const blocked: string[] = [];
    const reads: string[] = [];
    await page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const refuse = () => {
        // Do not capture request bodies, headers or external URLs.
        blocked.push(
          `${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}`,
        );
        return route.abort("blockedbyclient");
      };
      if (url.origin !== origin || request.method() !== "GET") return refuse();
      if (/^\/api(?:\/|$)/.test(url.pathname)) {
        const context = url.pathname.match(
          /^\/api\/access-policy\/edit-context\/service\/([^/]+)$/,
        );
        if (!url.search && context) {
          reads.push(url.pathname);
          return route.fulfill({
            json: {
              target: { kind: "service", id: decodeURIComponent(context[1]) },
              record: null,
              precondition: { exists: false, revision: "absent-plan" },
            },
          });
        }
        if (url.search || !Object.hasOwn(fixtures, url.pathname))
          return refuse();
        reads.push(url.pathname);
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      // Only the compiled document/assets can reach the local static server.
      if (
        url.search ||
        !(
          url.pathname === "/" ||
          url.pathname.startsWith("/assets/") ||
          url.pathname === "/favicon.ico"
        )
      )
        return refuse();
      return route.continue();
    });
    const inventory = new Inventory(page, info, "admin", "services");
    const measurements: unknown[] = [];
    const screenshot = async (stage: string) => {
      if (process.env.CI)
        await info.attach(`service-${width}-${stage}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
    };
    try {
      await page.goto("/#services");
      const opener = page.locator(".page-heading").getByRole("button", {
        name: "新建方案",
        exact: true,
      });
      await expect(opener).toBeVisible();
      await inventory.stable();
      for (let opening = 1; opening <= 2; opening++) {
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "新建服务方案",
          exact: true,
        });
        await inventory.stable(dialog);
        const name = dialog.getByRole("textbox", {
          name: "服务方案名称",
          exact: true,
        });
        const quota = dialog.getByRole("spinbutton", {
          name: "周期额度（GiB，0 为不限额）",
          exact: true,
        });
        const preview = dialog.getByRole("button", {
          name: "预览影响",
          exact: true,
        });
        const cancel = dialog.getByRole("button", {
          name: "取消",
          exact: true,
        });
        await expect(name).toHaveValue("");
        await expect(quota).toHaveValue("100");
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        expect(
          await preview.evaluate((element) => {
            const button = element as HTMLButtonElement;
            return {
              sameDialog:
                button.form?.closest('[role="dialog"]') ===
                button.closest('[role="dialog"]'),
              type: button.type,
            };
          }),
        ).toEqual({ sameDialog: true, type: "submit" });
        // No native required constraint: this is AppForm custom-validation recovery.
        expect(
          await name.evaluate(
            (element) => (element as HTMLInputElement).required,
          ),
        ).toBe(false);
        if (opening === 1) await quota.fill("75");
        const background = () =>
          page.locator(".route-content").evaluate((element) => {
            const offsets = [scrollX, scrollY];
            for (
              let node: HTMLElement | null = element as HTMLElement;
              node;
              node = node.parentElement
            )
              offsets.push(node.scrollLeft, node.scrollTop);
            return offsets;
          });
        const untouchedBackground = await background();
        for (let attempt = 1; attempt <= (opening === 1 ? 2 : 1); attempt++) {
          await inventory.tabTo(dialog, preview);
          expect(
            await preview.evaluate((element) =>
              (element as HTMLButtonElement).form?.checkValidity(),
            ),
            "Native validation must not intercept the custom-validation submit",
          ).toBe(true);
          const before = await geometry(dialog, name);
          expect(
            before.rail.max,
            "Short task has a real scroll rail",
          ).toBeGreaterThan(0);
          expect(
            before.rail.offset,
            "Native Tab reached the lower footer",
          ).toBeGreaterThan(0);
          await screenshot(`${opening}-${attempt}-before`);
          await page.keyboard.press("Enter");
          await expect(name).toBeFocused();
          await expect(name).toHaveAttribute("aria-invalid", "true");
          const error = dialog
            .getByRole("alert")
            .filter({ hasText: "请填写服务方案名称" });
          await expect(error).toHaveText("请填写服务方案名称");
          const errorId = await error.getAttribute("id");
          expect(errorId).toBeTruthy();
          expect(
            (await name.getAttribute("aria-describedby"))?.split(/\s+/),
          ).toContain(errorId);
          // Observe natural recovery before any further focus or scroll action.
          await inventory.stable(dialog);
          await expect(name).toBeFocused();
          await inventory.inView(name);
          await inventory.inView(error);
          const after = await geometry(dialog, name);
          expect(after.rail.offset).toBeLessThan(before.rail.offset);
          expect(await background()).toEqual(untouchedBackground);
          await expect(quota).toHaveValue(opening === 1 ? "75" : "100");
          await expect(
            page.getByRole("dialog", { name: "确认授权变更", exact: true }),
          ).toHaveCount(0);
          await expect(name).toHaveValue("");
          expect(blocked).toEqual([]);
          measurements.push({
            opening,
            attempt,
            before,
            after,
            focusedField: "服务方案名称",
          });
          await screenshot(`${opening}-${attempt}-recovered`);
        }
        await inventory.tabTo(dialog, cancel);
        await page.keyboard.press("Enter");
        if (opening === 1) {
          const discard = page.getByRole("alertdialog", {
            name: "放弃尚未保存的授权修改？",
            exact: true,
          });
          await inventory.stable(discard);
          await inventory.tabTo(
            discard,
            discard.getByRole("button", { name: "放弃修改", exact: true }),
          );
          await page.keyboard.press("Enter");
        }
        await expect(dialog).toBeHidden();
        await inventory.stable();
        await expect(opener).toBeFocused();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
      }
      expect(reads).toContain("/api/auth/me");
      expect(reads).toContain("/api/services");
      expect(reads).toContain("/api/published-routes");
      expect(
        reads.some((path) =>
          path.startsWith("/api/access-policy/edit-context/service/"),
        ),
      ).toBe(true);
      inventory.finish();
    } finally {
      if (process.env.CI)
        await info.attach("service-submit-focus-measurements", {
          contentType: "application/json",
          body: JSON.stringify(
            {
              viewport: page.viewportSize(),
              measurements,
              reads,
              blocked,
              scope:
                "Built App with synthetic admin/services/route reads; invalid native Preview submits, retained quota, discard and clean reopen only. No preview/save/entitlement writes, backend acceptance, live data or screen-reader acceptance.",
            },
            null,
            2,
          ),
        });
      expect(
        blocked,
        "No writes, unexpected API reads or external requests, even on assertion failure",
      ).toEqual([]);
    }
  });
}
