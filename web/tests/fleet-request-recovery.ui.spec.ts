import { test, expect, type Route, type Locator } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Actual App with loopback-only synthetic batch responses. No operation reaches
// the backend, node, runtime or external service; request IDs stay in memory.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`fleet same-request recovery retains pending focus and idempotency at ${width}px`, async ({ page, baseURL }, info) => {
    if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
      throw new Error("Fleet recovery requires loopback");
    const origin = new URL(baseURL).origin;
    const batch = { id: "batch", action: "configure", deploymentId: "path", createdAt: "2026-11-11T10:00:00Z",
      leaseSeconds: 300, status: "planned", affectedUsers: 0, supported: true, diagnostics: [],
      targets: [{ instanceId: "core", name: "办公核心", stage: 0, supported: true, status: "planned",
        affectedUsers: 0, attempts: [], changes: [], diagnostics: [], affectedRouteIds: [] }],
    };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "reviewer", name: "审查管理员", role: "admin" }, csrfToken: "synthetic-only" },
      "/api/admin/fleet-batches": [batch], "/api/admin/fleet-batches/batch": batch,
      "/api/hosts": [], "/api/core-instances": [], "/api/managed-endpoints": [], "/api/links": [],
      "/api/server-deployments": [{ id: "path", name: "办公路径", ir: { programs: [] } }],
    };
    const writes: unknown[] = [], blocked: string[] = [];
    let held: Route | undefined, heldRefresh: Route | undefined;
    let holdRefresh = false, refreshUnavailable = false;
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (!url.search && request.method() === "GET" && url.pathname === "/api/admin/fleet-batches/batch") {
        if (holdRefresh) { holdRefresh = false; heldRefresh = route; return; }
        if (refreshUnavailable) return route.fulfill({ status: 503, json: { error: "进度读取暂时不可用" } });
      }
      if (!url.search && request.method() === "GET" && url.pathname in fixtures)
        return route.fulfill({ json: fixtures[url.pathname] });
      if (!url.search && request.method() === "POST" && url.pathname === "/api/admin/fleet-batches/batch/execute") {
        writes.push(request.postDataJSON());
        if (writes.length === 1) return route.fulfill({ status: 503, json: { error: "执行服务暂时不可用" } });
        if (held) { blocked.push("duplicate pending operation"); return route.abort(); }
        held = route;
        return;
      }
      blocked.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    const focusEvidence: { phase: string; focused: boolean; focusVisible: boolean; shadow: string; inViewport: boolean }[] = [];
    const capture = async (phase: string, control?: Locator) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      if (control) {
        // Observe this control's finite CSS transitions, not the pending spinner.
        // Do not disable motion or synthesize focus for a passing screenshot.
        await control.evaluate(async element => {
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          await Promise.all(element.getAnimations().filter(animation =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
          ).map(animation => animation.finished.catch(() => undefined)));
        });
        const observation = await control.evaluate(element => {
          const box = element.getBoundingClientRect();
          return { focused: document.activeElement === element, focusVisible: element.matches(":focus-visible"),
            shadow: getComputedStyle(element).boxShadow,
            inViewport: box.left >= 3 && box.top >= 3 && box.right <= innerWidth - 3 && box.bottom <= innerHeight - 3 };
        });
        focusEvidence.push({ phase, ...observation });
        expect(observation.focused).toBe(true);
        expect(observation.focusVisible).toBe(true);
        expect(observation.inViewport).toBe(true);
      }
      await info.attach(`fleet-retry-${width}-${phase}`, { body: await page.screenshot(), contentType: "image/png" });
    };
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/#fleet");
      await page.getByRole("button", { name: "应用配置", exact: true }).click();
      const detail = page.getByRole("dialog", { name: "批量变更进度", exact: true });
      await settledTask(detail);
      await detail.getByRole("button", { name: "执行第 1 阶段", exact: true }).click();
      await page.getByRole("button", { name: "确认执行", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      const retry = detail.getByRole("button", { name: "重新提交同一请求", exact: true });
      await expect(retry).toBeVisible();
      // Reach the recovery action through ordinary keyboard navigation.
      const focusRetry = async () => {
        await page.keyboard.press("Tab");
        for (let step = 0; step < 30 && !await retry.evaluate(element => document.activeElement === element); step++)
          await page.keyboard.press("Tab");
        await expect(retry).toBeFocused();
      };
      await focusRetry();
      await capture("initial-failure", retry);
      holdRefresh = true;
      await detail.getByRole("button", { name: "刷新进度", exact: true }).click();
      await expect.poll(() => Boolean(heldRefresh)).toBe(true);
      await focusRetry();
      await page.keyboard.press("Enter");
      await expect.poll(() => writes.length).toBe(2);
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).not.toHaveAttribute("disabled");
      await expect(retry).toBeFocused();
      await capture("pending", retry);
      refreshUnavailable = true;
      const failedRefresh = heldRefresh!; heldRefresh = undefined;
      await failedRefresh.fulfill({ status: 503, json: { error: "进度读取暂时不可用" } });
      await expect(detail.getByText("批次进度刷新失败，以下为上次读取的记录。请刷新进度后再开始新的执行或目标重试。", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "执行第 1 阶段", exact: true })).toBeDisabled();
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await capture("stale-pending", retry);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      expect(writes.length).toBe(2);
      const failing = held!; held = undefined;
      await failing.fulfill({ status: 503, json: { error: "执行服务仍不可用" } });
      await expect(detail.getByText("执行服务仍不可用", { exact: true })).toBeVisible();
      await expect(retry).toBeFocused();
      await capture("failed", retry);
      await page.keyboard.press("Enter");
      await expect.poll(() => writes.length).toBe(3);
      expect(JSON.stringify(writes[1]) === JSON.stringify(writes[0])).toBe(true);
      expect(JSON.stringify(writes[2]) === JSON.stringify(writes[0])).toBe(true);
      const succeeding = held!; held = undefined;
      const submitted = { ...batch, status: "queued", targets: batch.targets.map(target => ({ ...target, status: "queued" })) };
      fixtures["/api/admin/fleet-batches/batch"] = submitted;
      await succeeding.fulfill({ json: submitted });
      await expect(retry).toHaveCount(0);
      await expect(detail.getByText("已提交，等待节点", { exact: true }).first()).toBeVisible();
      await expect(detail.getByRole("button", { name: "执行第 1 阶段", exact: true })).toBeDisabled();
      await capture("submitted");
      expect(blocked).toEqual([]);
    } finally {
      if (held) await held.abort();
      if (heldRefresh) await heldRefresh.abort();
      await info.attach("fleet-retry-ledger", { body: JSON.stringify({ focusEvidence, count: writes.length, sameRequest: writes.length === 3 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && JSON.stringify(writes[1]) === JSON.stringify(writes[2]), blocked }), contentType: "application/json" });
    }
  });
}
