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
}, info) => {
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
  const readControlState = () =>
    control.evaluate((element) => ({
      // Keep null distinct from an existing empty attribute. The original native
      // failure recorded only the latter, not the fixture's actual initial state.
      style: element.getAttribute("style"),
      pointerEvents: getComputedStyle(element).pointerEvents,
      disabled: (element as HTMLButtonElement).disabled,
      busy: element.getAttribute("aria-busy"),
      bodyFocused: document.activeElement === document.body,
    }));
  type ControlState = Awaited<ReturnType<typeof readControlState>>;
  type Geometry = ReturnType<
    typeof observeValidationGeometry
  >["controls"][number];
  const probes: Array<{
    stage: string;
    before: ControlState;
    geometry?: Geometry;
    after?: ControlState;
  }> = [];
  const initial = await readControlState();
  const observe = async (stage: string) => {
    const probe: (typeof probes)[number] = {
      stage,
      before: await readControlState(),
    };
    probes.push(probe);
    probe.geometry = (
      await page
        .locator("body")
        .evaluate(observeValidationGeometry, { checkFailure, removalFailure })
    ).controls[0];
    probe.after = await readControlState();
    // Exact restoration, not null/empty equivalence. Repeat at every geometry
    // boundary so a failure cannot skip the overlay/clipping evidence silently.
    expect(probe.before).toEqual(initial);
    expect(probe.after).toEqual(probe.before);
    return probe.geometry;
  };
  let taskFailed = false;
  let taskError: unknown;
  let evidenceError: unknown;
  const serializeEvidence = () =>
    JSON.stringify(
      {
        scope:
          "native evidence-helper fixture; not application or deployment proof",
        initial,
        probes,
      },
      null,
      2,
    );
  try {
    expect(initial).toMatchObject({
      pointerEvents: "none",
      disabled: true,
      busy: "true",
      bodyFocused: true,
    });
    expect(await observe("unobscured")).toMatchObject({
      inViewport: true,
      unobscured: true,
      busy: "true",
      occlusionProbe: "temporary-pointer-events-auto",
    });

    await page.locator("#cover").evaluate((element) => {
      element.style.display = "block";
    });
    expect(await observe("covered")).toMatchObject({
      inViewport: true,
      unobscured: false,
    });
    await page.locator("#cover").evaluate((element) => {
      element.style.display = "none";
    });

    await page.locator("#clip").evaluate((element) => {
      element.style.width = "20px";
    });
    expect(await observe("ancestor-clipped")).toMatchObject({
      inViewport: true,
      unobscured: false,
    });
    await page.locator("#clip").evaluate((element) => {
      element.style.width = "120px";
      element.style.left = "-10px";
    });
    expect(await observe("viewport-clipped")).toMatchObject({
      inViewport: false,
      unobscured: true,
    });
  } catch (error) {
    taskFailed = true;
    taskError = error;
  } finally {
    // Synthetic fixture data only. This path is already retained by the CI
    // artifact allowlist, including when exact restoration fails before later probes.
    try {
      await writeFile(info.outputPath("final-state.json"), serializeEvidence());
    } catch (error) {
      evidenceError = error;
    }
    // Attach the bytes independently, even if persisting the original failed.
    // Evidence errors must never replace the original assertion failure.
    try {
      await info.attach("measurement-restoration", {
        body: serializeEvidence(),
        contentType: "application/json",
      });
    } catch (error) {
      evidenceError ??= error;
    }
  }
  if (taskFailed) throw taskError;
  if (evidenceError) throw evidenceError;
});

// These are unverified native task requirements, not observed failures. Keep the
// existing pointer journeys and observation fixture above unchanged. jsdom keeps
// focus on newly disabled buttons, so it cannot establish this browser behavior.
test.describe("keyboard validation recovery", () => {
  test.use({ serviceWorkers: "block" });
  for (const width of [1440, 390]) {
    test(`admin validation keeps keyboard retry ownership at ${width}x560`, async ({
      page,
      baseURL,
    }, info) => {
      if (
        !baseURL ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
      )
        throw new Error("Controlled keyboard validation requires loopback");
      const origin = new URL(baseURL).origin;
      const preserveRemoval = width === 390;
      const ledger: { method: string; target: string; outcome: string }[] = [];
      const stages: string[] = [];
      const focusStates: {
        stage: string;
        checkFocused: boolean;
        bodyFocused: boolean;
        insideResult: boolean;
        focusVisible: boolean;
        disabled: boolean;
        busy: string | null;
      }[] = [];
      // Retain every held request so an accidental duplicate cannot overwrite
      // evidence or survive teardown. Only synthetic responses are released.
      const held = new Map<
        number,
        { route: Route; entry: (typeof ledger)[number] }
      >();
      let attempts = 0;
      let retryCommands = 0;
      let failed = false;
      let originalError: unknown;
      let captureError: unknown;
      const check = page.getByRole("button", {
        name: `校验 ${name}`,
        exact: true,
      });
      const capturePhase = async (stage: string) => {
        const observation = await capture(page, info, stage);
        stages.push(stage);
        // Observe only public focus/state booleans. Never persist DOM text,
        // inputs, credentials, raw request bodies or private response payloads.
        focusStates.push({
          stage,
          ...(await check.evaluate(
            (element) => ({
              checkFocused: document.activeElement === element,
              bodyFocused: document.activeElement === document.body,
              insideResult:
                !!document.activeElement?.closest('[role="dialog"]'),
              focusVisible: element.matches(":focus-visible"),
              disabled: (element as HTMLButtonElement).disabled,
              busy: element.getAttribute("aria-busy"),
            }),
            undefined,
            { timeout: 1000 },
          )),
        });
        return observation;
      };
      const assertIndependentError = async () => {
        if (preserveRemoval)
          await expect(
            page.getByText(removalFailure, { exact: true }),
          ).toHaveCount(1);
      };
      try {
        await page.setViewportSize({ width, height: 560 });
        await page.route("**/*", async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          const entry = {
            method: request.method(),
            target: "unexpected",
            outcome: "blocked",
          };
          if (url.origin !== origin) {
            ledger.push(entry);
            return route.abort();
          }
          if (request.method() === "GET" && !url.pathname.startsWith("/api/"))
            return route.continue();
          ledger.push(entry);
          if (
            !url.search &&
            request.method() === "POST" &&
            url.pathname === "/api/routes/route/validate"
          ) {
            entry.target = "validation";
            entry.outcome = "held";
            held.set(++attempts, { route, entry });
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
          const key = url.pathname.slice(4);
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
        if (preserveRemoval) {
          // Independent failure setup uses the existing public removal task.
          // Validation itself is keyboard-only from initial navigation onward.
          await page
            .getByRole("button", { name: `更多操作 ${name}`, exact: true })
            .click();
          await page
            .getByRole("menuitem", {
              name: `删除链路配置 ${name}`,
              exact: true,
            })
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
        await expect(check).toBeVisible();
        for (let step = 0; step < 60; step++) {
          if (
            await check.evaluate(
              (element) => element === document.activeElement,
            )
          )
            break;
          await page.keyboard.press("Tab");
        }
        await expect(
          check,
          "Initial check is reachable by ordinary Tab",
        ).toBeFocused();
        for (let cycle = 0; cycle < 2; cycle++) {
          const failingAttempt = cycle * 2 + 1;
          const retryAttempt = failingAttempt + 1;
          // No locator.press, focus(), scrolling or pointer repair after entry.
          await page.keyboard.press("Enter");
          await expect.poll(() => held.has(failingAttempt)).toBe(true);
          await expect(check).toHaveAttribute("aria-busy", "true");
          const pendingFailure = await capturePhase(`pending-failure-${cycle}`);
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
          expect(
            attempts,
            "Pending keyboard repeats do not issue another check",
          ).toBe(failingAttempt);
          const first = held.get(failingAttempt)!;
          await first.route.fulfill({
            status: 503,
            json: { error: checkFailure },
          });
          first.entry.outcome = "held-then-synthetic-503";
          held.delete(failingAttempt);
          await expect(
            page.getByText(checkFailure, { exact: true }),
          ).toBeVisible();
          await expect(check).toBeEnabled();
          await expect(check).not.toHaveAttribute("aria-busy", "true");
          await assertIndependentError();
          // Save both pending and failed originals before judging focus. A
          // partially offscreen failed control alone is not a failure assertion.
          const failedState = await capturePhase(`failed-${cycle}`);
          // Exercise the ordinary retry command before any focus expectation;
          // even a failing ownership assertion therefore retains its request evidence.
          await page.keyboard.press("Enter");
          retryCommands++;
          expect(
            pendingFailure.controls.find(
              (control) => control.kind === "validation-control",
            )?.focused,
            "Pending check retains the keyboard action owner",
          ).toBe(true);
          expect(
            failedState.controls.find(
              (control) => control.kind === "validation-control",
            )?.focused,
            "Failed check retains the keyboard retry owner without focus repair",
          ).toBe(true);
          await expect.poll(() => held.has(retryAttempt)).toBe(true);
          await expect(check).toHaveAttribute("aria-busy", "true");
          await expect(
            page.getByText(checkFailure, { exact: true }),
          ).toHaveCount(0);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(
            page.getByText("配置结构校验完成", { exact: true }),
          ).not.toBeVisible();
          await assertIndependentError();
          const pendingRetry = await capturePhase(`pending-retry-${cycle}`);
          const retryControl = pendingRetry.controls.find(
            (control) => control.kind === "validation-control",
          );
          expect(
            retryControl?.focused,
            "Keyboard retry keeps the same action owner",
          ).toBe(true);
          expect(pendingRetry.overflow).toBe(false);
          expect(retryControl?.inViewport && retryControl.unobscured).toBe(
            true,
          );
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
          expect(
            attempts,
            "Pending retry blocks duplicate keyboard requests",
          ).toBe(retryAttempt);
          const retry = held.get(retryAttempt)!;
          await retry.route.fulfill({
            json: { valid: true, diagnostics: [], artifacts: [] },
          });
          retry.entry.outcome = "held-then-synthetic-success";
          held.delete(retryAttempt);
          const result = page.getByRole("dialog", {
            name: `${name}的配置检查`,
            exact: true,
          });
          await expect(
            result.getByText("配置结构校验完成", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(checkFailure, { exact: true }),
          ).toHaveCount(0);
          await assertIndependentError();
          await settledTask(result);
          const ready = await capturePhase(`result-${cycle}`);
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
          await expect(
            check,
            "Escape returns to the same check for the next keyboard cycle",
          ).toBeFocused();
          await assertIndependentError();
          await capturePhase(`result-return-${cycle}`);
        }
        expect(attempts).toBe(4);
        expect(retryCommands).toBe(2);
        expect(ledger.filter((entry) => entry.outcome === "blocked")).toEqual(
          [],
        );
      } catch (error) {
        failed = true;
        originalError = error;
      } finally {
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
                  "synthetic HTTP keyboard UI faults, not backend or deployment proof",
                width,
                stages,
                focusStates,
                attempts,
                retryCommands,
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
        for (const request of held.values())
          await request.route.abort().catch(() => {});
      }
      if (failed) throw originalError;
      if (captureError) throw captureError;
    });
  }
});
