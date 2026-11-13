import { test, expect, type Route } from "@playwright/test";
import type { NodeObservationView } from "../src/observability-model";
import { settledTask } from "./ui-settled-task";

// Actual workspace and baseline form with controlled read-only HTTP states.
// No supplier statements, accounting baselines, live nodes or credentials change.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [1440, 390]) {
  test(`baseline sample replacement preserves inputs and requires fresh consent at ${width}px`, async ({ page }, info) => {
    const base = info.project.use.baseURL;
    if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
      throw new Error("Controlled baseline review requires loopback");
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const hostId = "baseline-review-host";
    const hostName = "供应商用量核对服务器";
    const now = Date.now();
    const observation: NodeObservationView = {
      nodeId: hostId,
      config: { revision: 1, observerInstanceId: "review-core", billedInterfaces: ["eth0"], provider: {
        name: "测试供应商", mode: "limited", allowance: 2, unit: "TB", cycleId: "review-cycle",
        cycleStart: new Date(now - 3600000).toISOString(), cycleEnd: new Date(now + 3600000).toISOString(),
        notificationSource: "nic_estimate", exhaustionAction: "advisory",
      } },
      latest: { digest: "sample-one", observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), source: "linux_procfs", continuity: "initial",
        cpuPercent: null, receiveBytesPerSecond: null, transmitBytesPerSecond: null,
        metrics: { memoryTotalBytes: 4096, memoryAvailableBytes: 2048, load1: 0, load5: 0, load15: 0, interfaces: [{ name: "eth0", receiveBytes: 1000, transmitBytes: 2000 }] },
      },
      provider: { source: "nic_estimate", coverage: "partial", statusReason: "initial_observation_requires_baseline", fresh: true, observedAt: new Date(now).toISOString(), observedSince: null, observedNicBytes: 0, totalBytes: 2000000000000, usedBytes: null, remainingBytes: null, exhaustionAction: "advisory", notificationEligible: false },
    };
    const observationPath = `/admin/nodes/${hostId}/observability`;
    const fixtures: Record<string, unknown> = {
      "/auth/me": { user: { id: "review-admin", name: "Review admin", role: "admin" }, csrfToken: "synthetic" },
      "/hosts": [{ id: hostId, name: hostName, address: "baseline.example.test" }],
      "/core-instances": [{ id: "review-core", hostId, name: "采集核心", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" }],
      "/agent/instances/review-core/state": { instanceId: "review-core", phase: "unregistered" },
      "/managed-endpoints": [], "/links": [], "/server-deployments": [],
      [observationPath]: observation,
    };
    const unexpected: string[] = [];
    const pending: Route[] = [];
    let replaceSample = false;
    await page.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== new URL(base).origin) { unexpected.push("external request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const path = url.pathname.slice(4);
      if (request.method() !== "GET" || !(path in fixtures)) {
        unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 503, json: { error: "Unexpected controlled baseline request" } });
      }
      if (path === observationPath && replaceSample) { pending.push(route); return; }
      return route.fulfill({ json: fixtures[path] });
    });
    await page.goto("/#servers");
    await page.getByRole("button", { name: hostName, exact: true }).click();
    const host = page.getByRole("region", { name: hostName, exact: true });
    await host.getByRole("tab", { name: "诊断", exact: true }).click();
    await host.getByRole("button", { name: "核对网卡估算基线", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "核对网卡估算基线", exact: true });
    await settledTask(dialog);
    const amount = dialog.getByLabel("本周期实际已用", { exact: true });
    const reason = dialog.getByLabel("核对依据与说明", { exact: true });
    const confirmation = dialog.getByRole("checkbox");
    const save = dialog.getByRole("button", { name: "保存核对结果", exact: true });
    const refresh = dialog.getByRole("button", { name: "读取最新服务器数据", exact: true });
    await amount.fill("5");
    await reason.fill("已核对显示时点的供应商控制台用量");
    await confirmation.focus();
    await confirmation.press("Space");
    await expect(save).toBeEnabled();
    replaceSample = true;
    await refresh.click();
    await expect.poll(() => pending.length).toBe(1);
    await expect(confirmation).not.toBeChecked();
    await expect(confirmation).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(dialog.getByText("尚未读取最新的服务器数据。读取成功后，请重新核对输入用量。", { exact: true })).toBeVisible();
    await pending[0].fulfill({ status: 503, json: { error: "最新采样暂时读取失败，请重试" } });
    const error = dialog.getByText("最新采样暂时读取失败，请重试", { exact: true });
    await expect(error).toBeVisible();
    await expect(confirmation).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(amount).toHaveValue("5");
    await expect(reason).toHaveValue("已核对显示时点的供应商控制台用量");
    await settledTask(dialog);
    await info.attach(`provider-baseline-failed-read-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    await refresh.click();
    await expect.poll(() => pending.length).toBe(2);
    await pending[1].fulfill({ json: { ...observation, latest: { ...observation.latest!, digest: "sample-two", observedAt: new Date(now + 1000).toISOString() } } });
    await expect(confirmation).toBeEnabled();
    await expect(confirmation).not.toBeChecked();
    await expect(save).toBeDisabled();
    await expect(error).toHaveCount(0);
    await confirmation.focus();
    await confirmation.press("Space");
    await expect(confirmation).toBeChecked();
    await expect(confirmation).toBeFocused();
    await expect(save).toBeEnabled();
    await expect(amount).toHaveValue("5");
    await expect(reason).toHaveValue("已核对显示时点的供应商控制台用量");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await settledTask(dialog);
    await expect(save).toHaveCSS("opacity", "1");
    await info.attach(`provider-baseline-reviewed-replacement-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    expect(unexpected).toEqual([]);
    // Read/review is not authorization to publish a baseline; never activate Save.
  });
}
