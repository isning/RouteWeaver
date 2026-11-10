import { expect, test } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Synthetic HTTP, actual App/nested-overlay focus. No diagnostic is executed.
for (const width of [320, 390, 1440]) {
  test(`server diagnostic cancellation retains target, receipt and recovery at ${width}px`, async ({
    page,
  }, info) => {
    const base = info.project.use.baseURL;
    if (
      !base ||
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
    )
      throw new Error("Controlled diagnostic review requires loopback");
    const origin = new URL(base).origin;
    const target = {
      id: "target",
      name: "跨区域协作授权测试目标",
      nodeId: "host",
      url: "https://probe.example.test/owned",
      methods: ["download"],
    };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "admin", name: "Admin", role: "admin" },
        csrfToken: "synthetic",
      },
      "/api/hosts": [
        { id: "host", name: "Tokyo", address: "tokyo.example.test" },
      ],
      "/api/core-instances": [
        {
          id: "core",
          hostId: "host",
          name: "Tokyo core",
          adapterId: "routeweaver/xray",
          version: "26.10.31",
        },
      ],
      "/api/agent/instances/core/state": {
        instanceId: "core",
        phase: "unregistered",
      },
      "/api/managed-endpoints": [],
      "/api/links": [],
      "/api/server-deployments": [],
      "/api/admin/nodes/host/observability": { config: {} },
      "/api/admin/diagnostic-targets": [target],
      "/api/admin/diagnostic-jobs": [
        {
          id: "job-selected",
          instanceId: "core",
          targetId: "target",
          kind: "download",
          maxBytes: 1048576,
          timeoutSeconds: 10,
          scope: { nodeId: "host", instanceId: "core" },
          target,
          requestedAt: "2026-11-02T04:00:00Z",
          expiresAt: "2026-11-02T04:02:00Z",
          direction: "target_to_node",
          estimatedMaxBytes: 1048576,
          costBasis: "application_payload_not_wire_or_provider_billing",
          status: "running",
        },
      ],
    };
    const unexpected: string[] = [];
    const writes: string[] = [];
    let refreshState: "initial" | "failed" | "stale" | "completed" = "initial";
    const selectedJob = (
      fixtures["/api/admin/diagnostic-jobs"] as { status: string }[]
    )[0];
    await page.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) {
        if (request.method() === "GET") return route.continue();
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      if (
        request.method() === "POST" &&
        url.pathname === "/api/admin/diagnostic-jobs/job-selected/cancel"
      ) {
        writes.push(`${request.method()} ${url.pathname}`);
        refreshState = "failed";
        return route.fulfill({
          json: { ...selectedJob, status: "cancel_requested" },
        });
      }
      if (
        request.method() === "GET" &&
        url.pathname === "/api/admin/diagnostic-jobs"
      ) {
        if (refreshState === "failed")
          return route.fulfill({
            status: 503,
            json: { error: "List temporarily unavailable" },
          });
        return route.fulfill({
          json: [
            {
              ...selectedJob,
              status: refreshState === "completed" ? "succeeded" : "running",
            },
          ],
        });
      }
      if (request.method() === "GET" && url.pathname in fixtures)
        return route.fulfill({ json: fixtures[url.pathname] });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({
        status: 503,
        json: { error: "Unexpected controlled request" },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#servers");
    await page.getByRole("button", { name: "Tokyo", exact: true }).click();
    const host = page.getByRole("region", { name: "Tokyo", exact: true });
    await host.getByRole("tab", { name: "诊断", exact: true }).click();
    await host.getByRole("tab", { name: "连接诊断", exact: true }).click();
    await host
      .getByRole("button", { name: "查看测试结果", exact: true })
      .click();
    const detail = page.getByRole("dialog", { name: "测试详情", exact: true });
    const opener = detail.getByRole("button", {
      name: "取消测试",
      exact: true,
    });
    for (let n = 0; n < 2; n++) {
      await opener.click();
      const decision = page.getByRole("alertdialog");
      await expect(decision).toContainText(target.name);
      await expect(decision).toContainText("取消请求不等于已停止");
      await settledTask(decision);
      const box = await decision.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      const cancel = decision.getByRole("button", {
        name: "继续测试",
        exact: true,
      });
      await expect(cancel).toBeInViewport();
      await expect(
        decision.getByRole("button", { name: "请求取消", exact: true }),
      ).toBeInViewport();
      if (!n)
        await page.screenshot({
          path: info.outputPath(`diagnostic-cancel-target-${width}.png`),
        });
      await page.keyboard.press("Escape");
      await expect(decision).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(detail).toContainText(target.name);
      await expect(detail.getByText("正在测试", { exact: true })).toBeVisible();
    }
    expect(writes).toEqual([]);
    await opener.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "请求取消", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(detail.getByText("已请求取消", { exact: true })).toBeVisible();
    await expect(
      detail.getByText("测试状态刷新失败，以下保留上次确认的记录。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(opener).toHaveCount(0);
    await expect(detail.getByText("已取消", { exact: true })).toHaveCount(0);
    await settledTask(detail);
    await page.screenshot({
      path: info.outputPath(`diagnostic-cancel-refresh-failed-${width}.png`),
    });
    refreshState = "stale";
    await detail.getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(
      detail.getByText(
        "最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(detail.getByText("已请求取消", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await host
      .getByRole("button", { name: "查看测试结果", exact: true })
      .click();
    await expect(detail.getByText("已请求取消", { exact: true })).toBeVisible();
    refreshState = "completed";
    await detail.getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(detail.getByText("测试完成", { exact: true })).toBeVisible();
    await expect(opener).toHaveCount(0);
    await expect(detail).toContainText(target.name);
    await settledTask(detail);
    await page.screenshot({
      path: info.outputPath(`diagnostic-cancel-recovered-${width}.png`),
    });
    expect(writes).toEqual([
      "POST /api/admin/diagnostic-jobs/job-selected/cancel",
    ]);
    expect(unexpected).toEqual([]);
  });
}
