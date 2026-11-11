import type { Locator } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

// Production-built App/provider composition, synthetic authenticated GETs only.
// Native browser acceptance, not backend persistence or remote-file acceptance.
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
  test(`public reference invalid footer Save returns to correction at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "resource-user", name: "Resource user", role: "user" },
        csrfToken: "synthetic-resource-csrf",
      },
      "/api/me/resources": [],
      "/api/me/inbox": [],
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
    const inventory = new Inventory(page, info, "user", "resources");
    const measurements: unknown[] = [];
    const screenshot = async (stage: string) => {
      if (process.env.CI)
        await info.attach(`resource-${width}-${stage}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
    };
    try {
      await page.goto("/#resources");
      const opener = page.getByRole("button", {
        name: "添加公开引用",
        exact: true,
      });
      await expect(opener).toBeVisible();
      await inventory.stable();
      for (let opening = 1; opening <= 2; opening++) {
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "添加公开规则引用",
          exact: true,
        });
        await inventory.stable(dialog);
        const name = dialog.getByRole("textbox", {
          name: "资源名称",
          exact: true,
        });
        const url = dialog.getByRole("textbox", {
          name: "规则文件 URL",
          exact: true,
        });
        const save = dialog.getByRole("button", {
          name: "保存公开引用",
          exact: true,
        });
        const cancel = dialog.getByRole("button", {
          name: "取消",
          exact: true,
        });
        await expect(name).toHaveValue("");
        await expect(url).toHaveValue("");
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        expect(
          await save.evaluate((element) => {
            const button = element as HTMLButtonElement;
            return {
              external: button.closest("form") === null,
              sameDialog:
                button.form?.closest('[role="dialog"]') ===
                button.closest('[role="dialog"]'),
              type: button.type,
            };
          }),
        ).toEqual({ external: true, sameDialog: true, type: "submit" });
        // This URL is input only: neither inspect nor a valid save is activated.
        if (opening === 1) await url.fill("https://example.test/retained.yaml");
        for (let attempt = 1; attempt <= (opening === 1 ? 2 : 1); attempt++) {
          await inventory.tabTo(dialog, save);
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
            .filter({ hasText: "给规则资源起一个名称" });
          await expect(error).toHaveText("给规则资源起一个名称");
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
          await expect(url).toHaveValue(
            opening === 1 ? "https://example.test/retained.yaml" : "",
          );
          await expect(name).toHaveValue("");
          expect(blocked).toEqual([]);
          measurements.push({
            opening,
            attempt,
            before,
            after,
            focusedField: "资源名称",
          });
          await screenshot(`${opening}-${attempt}-recovered`);
        }
        await inventory.tabTo(dialog, cancel);
        await page.keyboard.press("Enter");
        if (opening === 1) {
          const discard = page.getByRole("alertdialog", {
            name: "放弃未保存的规则资源修改？",
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
      expect(reads).toContain("/api/me/resources");
      inventory.finish();
    } finally {
      if (process.env.CI)
        await info.attach("resource-submit-focus-measurements", {
          contentType: "application/json",
          body: JSON.stringify(
            {
              viewport: page.viewportSize(),
              measurements,
              reads,
              blocked,
              scope:
                "Built App with synthetic authenticated reads; invalid native footer submits, retained URL, discard and clean reopen only. No remote fetch, upload, successful save or live data.",
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
