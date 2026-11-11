import { writeFile } from "node:fs/promises";
import {
  test,
  expect,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { historyLegacyFixtures } from "./history-legacy-fixture";
import { settledTask } from "./ui-settled-task";

// Actual App with synthetic HTTP only, not backend validation or deployment proof.
test.use({ trace: "off", screenshot: "off", video: "off" });
const diagnostic = "当前链路需要补充端点";
const names = { a: "先前链路", b: "当前链路" };
const fixtures = {
  ...historyLegacyFixtures,
  "/state": {
    nodes: [],
    users: [],
    capabilities: [],
    revisions: [],
    routes: Object.entries(names).map(([id, name]) => ({
      id,
      name,
      engine: "xray",
      hops: [],
      userIds: [],
    })),
  },
};
type Entry = { method: string; target: string; outcome: string };

async function capture(page: Page, info: TestInfo, phase: string) {
  const png = info.outputPath(`${phase}.png`);
  const json = info.outputPath(`${phase}.json`);
  const deadline = Date.now() + 2000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Capture exceeded 2 seconds");
    return ms;
  };
  // Save the original current viewport before observation; never scroll/focus to repair it.
  await page.screenshot({ path: png, timeout: remaining() });
  const geometry = await page.locator("body").evaluate(
    (_body, diagnostic) => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
        visible,
      );
      const targets = dialogs.flatMap((el) => [
        el,
        ...[...el.querySelectorAll("*")].filter(
          (child) =>
            child.textContent === diagnostic &&
            ![...child.children].some((c) => c.textContent === diagnostic) &&
            visible(child),
        ),
      ]);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        targets: targets.map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return {
            kind:
              el.getAttribute("role") === "dialog" ? "result" : "diagnostic",
            box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            inViewport:
              r.top >= 0 &&
              r.left >= 0 &&
              r.right <= innerWidth + 1 &&
              r.bottom <= innerHeight + 1,
            unobscured: !!hit && el.contains(hit),
          };
        }),
      };
    },
    diagnostic,
    { timeout: remaining() },
  );
  await writeFile(json, JSON.stringify(geometry, null, 2));
  // Both original files exist before attachments or geometry assertions.
  await info.attach(phase, { path: png, contentType: "image/png" });
  await info.attach(`${phase}-geometry`, {
    path: json,
    contentType: "application/json",
  });
  return geometry;
}

for (const width of [1440, 390]) {
  test(`latest requested validation owns its result at ${width}x560`, async ({
    page,
    baseURL,
  }, info) => {
    const requests: Entry[] = [];
    const phases: string[] = [];
    const held = new Map<string, { route: Route; entry: Entry }>();
    let stateReads = 0;
    let failed = false;
    let originalError: unknown;
    let captureError: unknown;
    try {
      if (
        !baseURL ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
      )
        throw new Error("Controlled validation requires loopback");
      const origin = new URL(baseURL).origin;
      await page.setViewportSize({ width, height: 560 });
      await page.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const entry: Entry = {
          method: request.method(),
          target: "unexpected",
          outcome: "blocked",
        };
        if (url.origin !== origin) {
          requests.push(entry);
          return route.abort();
        }
        if (request.method() === "GET" && !url.pathname.startsWith("/api/"))
          return route.continue();
        requests.push(entry);
        const key = url.pathname.slice(4);
        if (
          !url.search &&
          request.method() === "GET" &&
          Object.hasOwn(fixtures, key)
        ) {
          entry.target = key;
          entry.outcome = "fixture";
          if (key === "/state") stateReads++;
          return route.fulfill({
            json: fixtures[key as keyof typeof fixtures],
          });
        }
        const id = ["a", "b"].find(
          (id) => url.pathname === `/api/routes/${id}/validate`,
        );
        if (!url.search && request.method() === "POST" && id && !held.has(id)) {
          entry.target = `validation-${id}`;
          entry.outcome = "held";
          held.set(id, { route, entry });
          return;
        }
        return route.abort();
      });
      await page.goto("/#legacy-routes");
      phases.push("loaded");
      const result = page.getByRole("dialog", {
        name: "当前链路的配置检查",
        exact: true,
      });
      const finish = async (id: string) => {
        const pending = held.get(id)!;
        const reads = stateReads;
        await pending.route.fulfill({
          json: {
            valid: id === "a",
            diagnostics: id === "b" ? [diagnostic] : [],
            artifacts: [],
          },
        });
        pending.entry.outcome = "synthetic-success";
        held.delete(id);
        // Every successful response must refresh state, including the stale one.
        await expect.poll(() => stateReads).toBeGreaterThan(reads);
      };
      const assertCurrent = async (phase: string) => {
        await expect(result).toBeVisible();
        await expect(
          result.getByText(diagnostic, { exact: true }).first(),
        ).toBeVisible();
        await expect(
          page.getByText("配置结构校验完成", { exact: true }),
        ).not.toBeVisible();
        await settledTask(result);
        const observation = await capture(page, info, phase);
        phases.push(phase);
        expect(observation.overflow).toBe(false);
        for (const kind of ["result", "diagnostic"]) {
          expect(
            observation.targets.some(
              (target) =>
                target.kind === kind && target.inViewport && target.unobscured,
            ),
          ).toBe(true);
        }
      };
      for (let cycle = 0; cycle < 2; cycle++) {
        for (const id of ["a", "b"] as const) {
          await page
            .getByRole("button", { name: `校验 ${names[id]}`, exact: true })
            .click();
          await expect.poll(() => held.has(id)).toBe(true);
          phases.push(`${cycle}-requested-${id}`);
        }
        await finish("b");
        await assertCurrent(`${cycle}-latest-result`);
        if (cycle === 1) {
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          phases.push("latest-dismissed");
        }
        await finish("a");
        phases.push(`${cycle}-older-completed`);
        if (cycle === 0) {
          await assertCurrent("older-did-not-replace");
          await page.keyboard.press("Escape");
        }
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      expect(
        requests.filter((entry) => entry.target.startsWith("validation-")),
      ).toHaveLength(4);
      expect(requests.filter((entry) => entry.outcome === "blocked")).toEqual(
        [],
      );
      phases.push("complete");
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
                "synthetic HTTP UI only, not backend validation or deployment proof",
              width,
              phases,
              stateReads,
              requests,
              finalCapture: captureError ? "failed-or-timed-out" : "saved",
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
      for (const pending of held.values())
        await pending.route.abort().catch(() => {});
    }
    if (failed) throw originalError;
    if (captureError) throw captureError;
  });
}
