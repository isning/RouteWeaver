import { writeFile } from "node:fs/promises";
import {
  test,
  expect,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { settledTask } from "./ui-settled-task";
import { observeValidationGeometry } from "./admin-validation-evidence";
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
  // Screenshot precedes the synchronous pointer-events-only occlusion probe.
  await page.screenshot({ path: png, timeout: remaining() });
  const observation = await page
    .locator("body")
    .evaluate(
      observeValidationGeometry,
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

// A native browser checks the observation helper itself, independently of App
// fixtures. DOM-unit measurements cannot establish actual hit testing/clipping.
test("validation evidence distinguishes pointer suppression from overlays and clips", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 560 });
  await page.setContent(`
    <style>
      body { margin: 0; }
      #clip { position: fixed; left: 20px; top: 20px; width: 120px; height: 100px; overflow: hidden; }
      button { width: 44px; height: 44px; padding: 0; border: 0; }
      button:disabled { pointer-events: none; }
      #cover { display: none; position: fixed; inset: 0; z-index: 10; background: white; }
    </style>
    <div id="clip"><button aria-label="校验链路" aria-busy="true" disabled>等待</button></div>
    <div id="cover"></div>
  `);
  const control = page.getByRole("button", { name: "校验链路", exact: true });
  const observe = async () =>
    (
      await page
        .locator("body")
        .evaluate(observeValidationGeometry, { checkFailure, removalFailure })
    ).controls[0];
  expect(await observe()).toMatchObject({
    inViewport: true,
    unobscured: true,
    busy: "true",
    occlusionProbe: "temporary-pointer-events-auto",
  });
  await expect(control).toBeDisabled();
  expect(await control.getAttribute("style")).toBeNull();
  expect(
    await control.evaluate(
      (element) => getComputedStyle(element).pointerEvents,
    ),
  ).toBe("none");
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);

  await page.locator("#cover").evaluate((element) => {
    element.style.display = "block";
  });
  expect(await observe()).toMatchObject({
    inViewport: true,
    unobscured: false,
  });
  await page.locator("#cover").evaluate((element) => {
    element.style.display = "none";
  });

  await page.locator("#clip").evaluate((element) => {
    element.style.width = "20px";
  });
  expect(await observe()).toMatchObject({
    inViewport: true,
    unobscured: false,
  });
  await page.locator("#clip").evaluate((element) => {
    element.style.width = "120px";
    element.style.left = "-10px";
  });
  expect(await observe()).toMatchObject({
    inViewport: false,
    unobscured: true,
  });
  await expect(control).toBeDisabled();
  expect(await control.getAttribute("style")).toBeNull();
});
