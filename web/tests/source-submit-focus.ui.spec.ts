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
  test(`source invalid footer Import returns to correction at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "source-user", name: "Source user", role: "user" },
        csrfToken: "synthetic-source-csrf",
      },
      "/api/me/sources": [],
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
    const inventory = new Inventory(page, info, "user", "sources");
    const measurements: unknown[] = [];
    const failures: unknown[] = [];
    let failureGeometry: unknown;
    const screenshot = async (stage: string) => {
      if (process.env.CI)
        await info.attach(`source-${width}-${stage}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
    };
    try {
      await page.goto("/#sources");
      const opener = page
        .getByRole("button", {
          name: "添加来源",
          exact: true,
        })
        .first();
      await expect(opener).toBeVisible();
      await inventory.stable();
      for (let opening = 1; opening <= 2; opening++) {
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "添加订阅来源",
          exact: true,
        });
        await inventory.stable(dialog);
        const name = dialog.getByRole("textbox", {
          name: "来源名称",
          exact: true,
        });
        const content = dialog.getByRole("textbox", {
          name: "节点链接或配置内容",
          exact: true,
        });
        await expect(
          dialog.getByText("订阅信息由平台解析并加密保存，仅供你的账号使用。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "导入选项", exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
        const save = dialog.getByRole("button", {
          name: "导入来源",
          exact: true,
        });
        const cancel = dialog.getByRole("button", {
          name: "取消",
          exact: true,
        });
        await expect(name).toHaveValue("");
        await expect(content).toHaveValue("");
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
        // Synthetic text is input only: a valid import is never activated.
        if (opening === 1)
          await content.fill("socks5://example.test:1080#Retained");
        for (let attempt = 1; attempt <= (opening === 1 ? 2 : 1); attempt++) {
          const measurement: {
            opening: number;
            attempt: number;
            before?: Awaited<ReturnType<typeof geometry>>;
            after?: Awaited<ReturnType<typeof geometry>>;
            focusedField?: string;
          } = { opening, attempt };
          measurements.push(measurement);
          await inventory.tabTo(dialog, save);
          const before = await geometry(dialog, name);
          measurement.before = before;
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
            .filter({ hasText: "给来源取一个名称" });
          await expect(error).toHaveText("给来源取一个名称");
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
          measurement.after = after;
          measurement.focusedField = "来源名称";
          expect(after.rail.offset).toBeLessThan(before.rail.offset);
          await expect(content).toHaveValue(
            opening === 1 ? "socks5://example.test:1080#Retained" : "",
          );
          await expect(name).toHaveValue("");
          expect(blocked).toEqual([]);
          await screenshot(`${opening}-${attempt}-recovered`);
        }
        await inventory.tabTo(dialog, cancel);
        await page.keyboard.press("Enter");
        if (opening === 1) {
          const discard = page.getByRole("alertdialog", {
            name: "放弃尚未保存的来源修改？",
            exact: true,
          });
          await inventory.stable(discard);
          // Confirmation starts on Cancel, which precedes Confirm in DOM order.
          await expect(
            discard.getByRole("button", { name: "继续编辑", exact: true }),
          ).toBeFocused();
          await page.keyboard.press("Tab");
          const confirm = discard.getByRole("button", {
            name: "放弃修改",
            exact: true,
          });
          await expect(confirm).toBeFocused();
          await inventory.inView(confirm);
          await page.keyboard.press("Enter");
        }
        await expect(dialog).toBeHidden();
        await inventory.stable();
        await expect(opener).toBeFocused();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
      }
      expect(reads).toContain("/api/auth/me");
      expect(reads).toContain("/api/me/sources");
      inventory.finish();
    } catch (error) {
      failures.push(error);
      // Read the failed viewport without attempting recovery or changing focus.
      try {
        const dialog = page.getByRole("dialog", {
          name: "添加订阅来源",
          exact: true,
        });
        failureGeometry = await dialog.evaluate(
          (element) => {
            const mode = element.getAttribute("data-task-scroll");
            const scroller =
              mode === "task"
                ? element
                : element.querySelector<HTMLElement>(
                    "[data-task-overlay-body]",
                  );
            const label = Array.from(element.querySelectorAll("label")).find(
              (node) => node.textContent?.trim() === "来源名称",
            );
            const field = label?.htmlFor
              ? element.ownerDocument.getElementById(label.htmlFor)
              : null;
            const railBox = scroller?.getBoundingClientRect();
            return {
              mode,
              rail:
                scroller && railBox
                  ? {
                      top: railBox.top + scroller.clientTop,
                      bottom:
                        railBox.top +
                        scroller.clientTop +
                        scroller.clientHeight,
                      offset: scroller.scrollTop,
                      max: scroller.scrollHeight - scroller.clientHeight,
                    }
                  : null,
              field:
                field && element.contains(field)
                  ? field.getBoundingClientRect().toJSON()
                  : null,
            };
          },
          undefined,
          { timeout: 500 },
        );
      } catch (evidenceError) {
        failures.push(evidenceError);
      }
    } finally {
      // Preserve the primary task error; evidence failures must not hide it.
      try {
        await screenshot("final-state");
      } catch (error) {
        failures.push(error);
      }
      try {
        if (process.env.CI)
          await info.attach("source-submit-focus-measurements", {
            contentType: "application/json",
            body: JSON.stringify(
              {
                viewport: page.viewportSize(),
                measurements,
                failureGeometry,
                reads,
                blocked,
                scope:
                  "Built App with synthetic authenticated reads; invalid native footer submits, retained text, discard and clean reopen only. No remote fetch, upload, successful save or live data.",
              },
              null,
              2,
            ),
          });
      } catch (error) {
        failures.push(error);
      }
      try {
        expect(
          blocked,
          "No writes, unexpected API reads or external requests, even on assertion failure",
        ).toEqual([]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Source recovery assertions and evidence failed",
      );
  });
}
