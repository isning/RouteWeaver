import { writeFile } from "node:fs/promises";
import {
  test,
  expect,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { settledTask } from "./ui-settled-task";
import {
  historyLegacyFixtures,
  historyLegacyName as name,
} from "./history-legacy-fixture";

// Actual App, synthetic HTTP faults only: not backend validation or deployment proof.
test.use({ trace: "off", screenshot: "off", video: "off" });
const checkFailure = "检查服务暂时不可用";
const removalFailure = "此链路仍被服务方案引用";

async function capture(page: Page, info: TestInfo, stage: string) {
  const png = info.outputPath(`${stage}.png`);
  const json = info.outputPath(`${stage}.json`);
  // Bound browser capture work without racing an uncancelled evidence promise.
  const deadline = Date.now() + 2000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Capture exceeded 2 seconds");
    return ms;
  };
  // Observe the current viewport without scrolling or moving focus to repair it.
  await page.screenshot({ path: png, timeout: remaining() });
  const observation = await page.locator("body").evaluate(
    (_body, { checkFailure, removalFailure }) => {
      const targets = [
        ...document.querySelectorAll('button, [role="dialog"], [role="alert"]'),
      ];
      const controls = targets
        .filter((el) => {
          const label = el.getAttribute("aria-label") || el.textContent || "";
          return (
            label.includes("校验") ||
            el.getAttribute("role") === "dialog" ||
            label.includes(checkFailure) ||
            label.includes(removalFailure)
          );
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return {
            role: el.getAttribute("role") || "button",
            kind:
              el.getAttribute("role") === "dialog"
                ? "result"
                : (el.textContent || "").includes("配置结构校验完成")
                  ? "result-copy"
                  : (el.textContent || "").includes(removalFailure)
                    ? "removal-error"
                    : (el.textContent || "").includes(checkFailure)
                      ? "validation-error"
                      : "validation-control",
            box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            inViewport:
              r.width > 0 &&
              r.height > 0 &&
              r.top >= 0 &&
              r.left >= 0 &&
              r.right <= innerWidth + 1 &&
              r.bottom <= innerHeight + 1,
            unobscured: !!hit && el.contains(hit),
            focused: el === document.activeElement,
            busy: el.getAttribute("aria-busy"),
          };
        });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        controls,
      };
    },
    { checkFailure, removalFailure },
    { timeout: remaining() },
  );
  await writeFile(json, JSON.stringify(observation, null, 2));
  // Both originals are persisted before any attachment or geometry assertion.
  await info.attach(stage, { path: png, contentType: "image/png" });
  await info.attach(`${stage}-geometry`, {
    path: json,
    contentType: "application/json",
  });
  return observation;
}

for (const width of [1440, 390]) {
  test(`admin validation failure owns its retry state at ${width}x560`, async ({
    page,
    baseURL,
  }, info) => {
    if (
      !baseURL ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    )
      throw new Error("Controlled validation requires loopback");
    const origin = new URL(baseURL).origin;
    const preserveRemoval = width === 390;
    const ledger: { method: string; target: string; outcome: string }[] = [];
    const stages: string[] = [];
    let attempts = 0;
    let held: Route | undefined;
    let failed = false;
    let originalError: unknown;
    let captureError: unknown;
    try {
      await page.setViewportSize({ width, height: 560 });
      await page.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const sameOrigin = url.origin === origin;
        const entry = {
          method: request.method(),
          target: "unexpected",
          outcome: "blocked",
        };
        if (!sameOrigin) {
          ledger.push(entry);
          return route.abort();
        }
        const key = url.pathname.slice(4);
        if (request.method() === "GET" && !url.pathname.startsWith("/api/"))
          return route.continue();
        ledger.push(entry);
        if (
          !url.search &&
          request.method() === "POST" &&
          url.pathname === "/api/routes/route/validate"
        ) {
          entry.target = "validation";
          attempts++;
          if (attempts % 2 === 1) {
            entry.outcome = "synthetic-503";
            return route.fulfill({
              status: 503,
              json: { error: checkFailure },
            });
          }
          entry.outcome = "held";
          held = route;
          return;
        }
        if (
          !url.search &&
          preserveRemoval &&
          request.method() === "DELETE" &&
          url.pathname === "/api/routes/route"
        ) {
          entry.target = "removal";
          entry.outcome = "synthetic-409";
          return route.fulfill({
            status: 409,
            json: { error: removalFailure },
          });
        }
        if (
          !url.search &&
          request.method() === "GET" &&
          Object.hasOwn(historyLegacyFixtures, key)
        ) {
          entry.target = key;
          entry.outcome = "fixture";
          return route.fulfill({ json: historyLegacyFixtures[key] });
        }
        return route.abort();
      });
      await page.goto("/#legacy-routes");
      const check = page.getByRole("button", {
        name: `校验 ${name}`,
        exact: true,
      });
      if (preserveRemoval) {
        await page
          .getByRole("button", { name: `更多操作 ${name}`, exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: `删除链路配置 ${name}`, exact: true })
          .click();
        const removal = page.getByRole("alertdialog");
        await removal
          .getByRole("button", { name: "删除", exact: true })
          .click();
        await expect(
          removal.getByText(removalFailure, { exact: true }),
        ).toBeVisible();
        await removal
          .getByRole("button", { name: "保留", exact: true })
          .click();
        await expect(removal).toBeHidden();
        await expect(
          page.getByText(removalFailure, { exact: true }),
        ).toBeVisible();
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        await check.click();
        await expect(
          page.getByText(checkFailure, { exact: true }),
        ).toBeVisible();
        await expect(check).toBeEnabled();
        await expect(check).not.toHaveAttribute("aria-busy", "true");
        await capture(page, info, `failed-${cycle}`);
        stages.push(`failed-${cycle}`);
        // Pointer invocation is ordinary and lets the browser reveal the action.
        await check.click();
        await expect.poll(() => !!held).toBe(true);
        await expect(check).toHaveAttribute("aria-busy", "true");
        await expect(check).toBeDisabled();
        await expect(page.getByText(checkFailure, { exact: true })).toHaveCount(
          0,
        );
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(
          page.getByText("配置结构校验完成", { exact: true }),
        ).not.toBeVisible();
        if (preserveRemoval)
          await expect(
            page.getByText(removalFailure, { exact: true }),
          ).toBeVisible();
        const pending = await capture(page, info, `pending-${cycle}`);
        stages.push(`pending-${cycle}`);
        expect(pending.overflow).toBe(false);
        const busy = pending.controls.find(
          (control) => control.busy === "true",
        );
        expect(busy?.inViewport && busy.unobscured).toBe(true);
        await held!.fulfill({
          json: { valid: true, diagnostics: [], artifacts: [] },
        });
        held = undefined;
        ledger.findLast((entry) => entry.target === "validation")!.outcome =
          "held-then-synthetic-success";
        const result = page.getByRole("dialog", {
          name: `${name}的配置检查`,
          exact: true,
        });
        await expect(
          result.getByText("配置结构校验完成", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(checkFailure, { exact: true })).toHaveCount(
          0,
        );
        if (preserveRemoval)
          await expect(
            page.getByText(removalFailure, { exact: true }),
          ).toHaveCount(1);
        await settledTask(result);
        const ready = await capture(page, info, `result-${cycle}`);
        stages.push(`result-${cycle}`);
        expect(ready.overflow).toBe(false);
        expect(
          ready.controls.find((control) => control.kind === "result")
            ?.inViewport,
        ).toBe(true);
        const resultCopy = ready.controls.find(
          (control) => control.kind === "result-copy",
        );
        expect(resultCopy?.inViewport && resultCopy.unobscured).toBe(true);
        await page.keyboard.press("Escape");
        await expect(result).toBeHidden();
        await expect(check).toBeEnabled();
        if (preserveRemoval)
          await expect(
            page.getByText(removalFailure, { exact: true }),
          ).toBeVisible();
      }
      expect(attempts).toBe(4);
      expect(ledger.filter((entry) => entry.outcome === "blocked")).toEqual([]);
    } catch (error) {
      failed = true;
      originalError = error;
    } finally {
      // Capture even after an earlier assertion failed; await every operation so
      // no background evidence task survives teardown. Browser calls share 2s.
      try {
        await capture(page, info, "final-state");
      } catch (error) {
        captureError = error;
      }
      try {
        const path = info.outputPath("request-ledger.json");
        await writeFile(
          path,
          JSON.stringify(
            {
              scope:
                "synthetic HTTP UI faults, not backend or deployment proof",
              width,
              stages,
              attempts,
              finalCapture: captureError ? "failed-or-timed-out" : "saved",
              requests: ledger,
            },
            null,
            2,
          ),
        );
        await info.attach("request-ledger", {
          path,
          contentType: "application/json",
        });
      } catch (error) {
        captureError ??= error;
      }
      if (held) await held.abort().catch(() => {});
    }
    if (failed) throw originalError;
    if (captureError) throw captureError;
  });
}
