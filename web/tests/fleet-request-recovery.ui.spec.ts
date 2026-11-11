import { test, expect, type Route } from "@playwright/test";
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
    let held: Route | undefined;
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { blocked.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
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
    const capture = async (phase: string) => {
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
      await retry.click();
      await expect.poll(() => writes.length).toBe(2);
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).not.toHaveAttribute("disabled");
      await expect(retry).toBeFocused();
      await capture("pending");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      expect(writes.length).toBe(2);
      const failing = held!; held = undefined;
      await failing.fulfill({ status: 503, json: { error: "执行服务仍不可用" } });
      await expect(detail.getByText("执行服务仍不可用", { exact: true })).toBeVisible();
      await expect(retry).toBeFocused();
      await capture("failed");
      await page.keyboard.press("Enter");
      await expect.poll(() => writes.length).toBe(3);
      expect(JSON.stringify(writes[1]) === JSON.stringify(writes[0])).toBe(true);
      expect(JSON.stringify(writes[2]) === JSON.stringify(writes[0])).toBe(true);
      const succeeding = held!; held = undefined;
      await succeeding.fulfill({ json: { ...batch, status: "queued" } });
      await expect(retry).toHaveCount(0);
      await expect(detail.getByText("已提交，等待节点", { exact: true })).toBeVisible();
      await capture("submitted");
      expect(blocked).toEqual([]);
    } finally {
      if (held) await held.abort();
      await info.attach("fleet-retry-ledger", { body: JSON.stringify({ count: writes.length, sameRequest: writes.length === 3 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && JSON.stringify(writes[1]) === JSON.stringify(writes[2]), blocked }), contentType: "application/json" });
    }
  });
}
