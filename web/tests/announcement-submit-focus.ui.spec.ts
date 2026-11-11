import type { Locator } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

// Production-built App/provider composition, synthetic authenticated GETs only.
// Native browser acceptance, not backend persistence or announcement delivery.
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
  const box = await field.boundingBox();
  expect(box).not.toBeNull();
  return { mode, rail, field: box! };
}

for (const width of [1440, 390]) {
  test(`announcement invalid footer submit returns to correction at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: {
          id: "announcement-admin",
          name: "Announcement admin",
          role: "admin",
        },
        csrfToken: "synthetic-announcement-csrf",
      },
      "/api/admin/announcements": [],
      "/api/state": { users: [] },
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
    const inventory = new Inventory(page, info, "admin", "notifications");
    const measurements: unknown[] = [];
    const traversals: unknown[] = [];
    const tabTo = async (surface: Locator, target: Locator) => {
      const controls = surface.locator(
        "a[href],button,input,select,textarea,[tabindex]",
      );
      // A datetime-local host is not one Tab stop: Chromium's native editor
      // contains date/time segments. Use a conservative bound for the possible year,
      // month, day, hour, minute, second, fraction, AM/PM and picker stops (9).
      // Optional segments need not appear. Ordinary controls still count once.
      const budget = await controls.evaluateAll((elements) =>
        elements.reduce(
          (total, element) =>
            total +
            (element instanceof HTMLInputElement &&
            element.type === "datetime-local"
              ? 9
              : 1),
          0,
        ),
      );
      const sequence: unknown[] = [];
      const traversal = {
        target:
          (await target.getAttribute("aria-label")) ??
          (await target.innerText()),
        budget,
        sequence,
        reached: false,
      };
      traversals.push(traversal);
      for (let presses = 0; presses <= budget; presses++) {
        const state = await surface.evaluate((element) => {
          const active = document.activeElement;
          const input = active instanceof HTMLInputElement ? active : null;
          return {
            contained: element.contains(active),
            tag: active?.tagName ?? null,
            type: input?.type ?? null,
            id: active?.id ?? null,
            label:
              active?.getAttribute("aria-label") ??
              (input
                ? Array.from(input.labels ?? [])
                    .map((label) => label.textContent)
                    .join(" ")
                : null),
          };
        });
        // Repeated datetime host entries are meaningful: document.activeElement
        // does not expose which native shadow-editor segment currently has focus.
        sequence.push({ presses, ...state });
        expect(state.contained, "Native Tab remains in the current task").toBe(
          true,
        );
        if (
          await target.evaluate((element) => element === document.activeElement)
        ) {
          traversal.reached = true;
          break;
        }
        if (presses < budget) await page.keyboard.press("Tab");
      }
      expect(
        traversal.reached,
        `Target reached within native control budget: ${JSON.stringify(traversal)}`,
      ).toBe(true);
      await expect(target).toBeFocused();
      await inventory.stable(surface);
      await inventory.inView(target);
    };
    const screenshot = async (stage: string) => {
      if (process.env.CI)
        await info.attach(`announcement-${width}-${stage}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
    };
    try {
      await page.goto("/#notifications");
      const opener = page.getByRole("button", {
        name: "创建公告",
        exact: true,
      });
      await expect(opener).toBeVisible();
      await inventory.stable();
      for (let opening = 1; opening <= 2; opening++) {
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "创建公告",
          exact: true,
        });
        await inventory.stable(dialog);
        const title = dialog.getByRole("textbox", {
          name: "公告标题",
          exact: true,
        });
        const body = dialog.getByRole("textbox", {
          name: "公告正文",
          exact: true,
        });
        const save = dialog.getByRole("button", {
          name: "保存并安排发布",
          exact: true,
        });
        const cancel = dialog.getByRole("button", {
          name: "取消",
          exact: true,
        });
        await expect(title).toHaveValue("");
        await expect(body).toHaveValue("");
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
        // Nonempty whitespace passes native required validation. Every submit
        // remains custom-invalid, so publication is never requested or scheduled.
        await title.fill("   ");
        await body.fill("Retained maintenance announcement");
        const dates = dialog.locator('input[type="datetime-local"]');
        const originalDates = await dates.evaluateAll((fields) =>
          fields.map((field) => (field as HTMLInputElement).value),
        );
        expect(originalDates).toHaveLength(2);
        expect(originalDates.every(Boolean)).toBe(true);
        const retained = async (
          expectedTitle: string,
          expectedBody: string,
        ) => {
          await expect(title).toHaveValue(expectedTitle);
          await expect(body).toHaveValue(expectedBody);
          expect(
            await dates.evaluateAll((fields) =>
              fields.map((field) => (field as HTMLInputElement).value),
            ),
          ).toEqual(originalDates);
          await expect(
            dialog.getByRole("combobox", { name: "通知谁", exact: true }),
          ).toHaveText("全部用户");
          await expect(
            dialog.getByRole("switch", { name: "启用公告", exact: true }),
          ).toBeChecked();
        };
        const recover = async (
          field: Locator,
          label: string,
          stage: string,
        ) => {
          expect(
            await save.evaluate((element) =>
              (element as HTMLButtonElement).form!.checkValidity(),
            ),
          ).toBe(true);
          await tabTo(dialog, save);
          const before = await geometry(dialog, field);
          expect(
            before.rail.max,
            "Short announcement task has a real scroll rail",
          ).toBeGreaterThan(0);
          expect(
            before.rail.offset,
            "Native Tab reached the lower footer",
          ).toBeGreaterThan(0);
          const clippedAbove = before.field.y < before.rail.top - 1;
          const clippedBelow =
            before.field.y + before.field.height > before.rail.bottom + 1;
          // Keep an explicit offscreen recovery exercise, not just a branch
          // that can silently stop exercising scroll restoration.
          if (label === "标题") expect(clippedAbove).toBe(true);
          await screenshot(`${opening}-${stage}-before`);
          await page.keyboard.press("Enter");
          await expect(field).toBeFocused();
          await expect(field).toHaveAttribute("aria-invalid", "true");
          const error = dialog
            .getByRole("alert")
            .filter({ hasText: `请填写${label}，不能只包含空白。` });
          await expect(error).toHaveText(`请填写${label}，不能只包含空白。`);
          const errorId = await error.getAttribute("id");
          expect(errorId).toBeTruthy();
          expect(
            (await field.getAttribute("aria-describedby"))?.split(/\s+/),
          ).toContain(errorId);
          // Read natural recovery only: no focus(), scrolling or input actions
          // intervene between submitting and clip/scroll assertions.
          await inventory.stable(dialog);
          await expect(field).toBeFocused();
          await inventory.inView(field);
          await inventory.inView(error);
          const after = await geometry(dialog, field);
          expect(blocked).toEqual([]);
          measurements.push({
            opening,
            stage,
            before,
            after,
            focusedField: label,
            clippedAbove,
            clippedBelow,
          });
          await screenshot(`${opening}-${stage}-recovered`);
          // A desktop body can already fit in the rail at footer focus. It must
          // receive focus with the complete field/error visible, not scroll just
          // to satisfy the test. A clipped field must still be revealed naturally.
          if (clippedAbove)
            expect(after.rail.offset).toBeLessThan(before.rail.offset);
          if (clippedBelow)
            expect(after.rail.offset).toBeGreaterThan(before.rail.offset);
        };
        await recover(title, "标题", "title");
        await retained("   ", "Retained maintenance announcement");
        if (opening === 1) {
          await recover(title, "标题", "title-repeated");
          await retained("   ", "Retained maintenance announcement");
          // Both are custom-invalid, then correct title: visible field order
          // chooses title first, and the remaining body receives recovery next.
          await body.fill("   ");
          await recover(title, "标题", "both-invalid");
          await expect(
            dialog
              .getByRole("alert")
              .filter({ hasText: "请填写正文，不能只包含空白。" }),
          ).toBeVisible();
          await retained("   ", "   ");
          await title.fill("Retained title");
          await recover(body, "正文", "body");
          await retained("Retained title", "   ");
          await tabTo(dialog, cancel);
          await page.keyboard.press("Enter");
          const review = page.getByRole("alertdialog", {
            name: "放弃未保存的公告修改？",
            exact: true,
          });
          await inventory.stable(review);
          await tabTo(
            review,
            review.getByRole("button", { name: "继续编辑", exact: true }),
          );
          await page.keyboard.press("Enter");
          await expect(review).toBeHidden();
          await inventory.stable(dialog);
          await retained("Retained title", "   ");
          await recover(body, "正文", "continued-body");
          await retained("Retained title", "   ");
        }
        await tabTo(dialog, cancel);
        await page.keyboard.press("Enter");
        const discard = page.getByRole("alertdialog", {
          name: "放弃未保存的公告修改？",
          exact: true,
        });
        await inventory.stable(discard);
        await tabTo(
          discard,
          discard.getByRole("button", { name: "放弃修改", exact: true }),
        );
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        await inventory.stable();
        await expect(opener).toBeFocused();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
      }
      for (const path of [
        "/api/auth/me",
        "/api/admin/announcements",
        "/api/state",
      ])
        expect(reads).toContain(path);
      inventory.finish();
    } finally {
      await info.attach("announcement-submit-focus-measurements", {
        contentType: "application/json",
        body: JSON.stringify(
          {
            viewport: page.viewportSize(),
            measurements,
            traversals,
            reads,
            blocked,
            scope:
              "Production-built App with synthetic authenticated reads; invalid native footer submits, field ordering, retained draft, continue editing, discard and clean reopen. No successful save, announcement scheduling, delivery, live data or screen-reader acceptance.",
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
