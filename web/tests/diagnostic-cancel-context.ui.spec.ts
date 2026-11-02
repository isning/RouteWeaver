import { expect, test } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Synthetic HTTP, actual App/nested-overlay focus. No diagnostic is executed.
test("server diagnostic cancellation retains its target and exact opener at 320px", async ({
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
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "GET" && url.pathname in fixtures)
      return route.fulfill({ json: fixtures[url.pathname] });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({
      status: 503,
      json: { error: "Unexpected controlled request" },
    });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/#servers");
  await page.getByRole("button", { name: "Tokyo", exact: true }).click();
  const host = page.getByRole("dialog", { name: "Tokyo", exact: true });
  await host.getByRole("button", { name: "资源、额度与连接诊断" }).click();
  await host.getByRole("tab", { name: "连接诊断", exact: true }).click();
  await host.getByRole("button", { name: "查看测试结果", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "测试详情", exact: true });
  const opener = detail.getByRole("button", { name: "取消测试", exact: true });
  for (let n = 0; n < 2; n++) {
    await opener.click();
    const decision = page.getByRole("alertdialog");
    await expect(decision).toContainText(target.name);
    await expect(decision).toContainText("取消请求不等于已停止");
    await settledTask(decision);
    const box = await decision.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
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
        path: info.outputPath("diagnostic-cancel-target-320.png"),
      });
    await page.keyboard.press("Escape");
    await expect(decision).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(detail).toContainText(target.name);
    await expect(detail.getByText("正在测试", { exact: true })).toBeVisible();
  }
  expect(unexpected).toEqual([]);
});
