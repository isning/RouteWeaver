import { test, expect } from "./isolated-control-plane-fixture";
import { signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Visual regression uses explicitly synthetic read responses. It exercises the
// actual workspace and controls, not live nodes, enrollment or application.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [1440, 390, 320]) {
  test(`server overview separates recorded states and resource freshness at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await signIn(page, baseURL, "admin");
    const host = { id: "dashboard-host", name: "Tokyo gateway", address: "tokyo.example.test" };
    const cores = [
      { id: "entry-core", hostId: host.id, name: "Public entry", adapterId: "routeweaver/xray", version: "26.3.27-rw1" },
      { id: "relay-core", hostId: host.id, name: "Regional relay", adapterId: "routeweaver/sing-box", version: "1.14.4" },
    ];
    const endpoint = { id: "entry", instanceId: cores[0].id, name: "TLS entry", connection: { protocol: "vless", host: "0.0.0.0", port: 443 } };
    const inventory: Record<string, unknown> = {
      "/api/hosts": [host], "/api/core-instances": cores,
      "/api/managed-endpoints": [endpoint], "/api/links": [],
      "/api/server-deployments": [{ id: "route", name: "Tokyo egress", status: "draft", diagnostics: [], ir: { schemaVersion: "1.0", id: "route", topologyRevision: "1", programs: [{ instance: cores[0], listener: endpoint, egress: [], rules: [], resources: [] }] } }],
      "/api/agent/instances/entry-core/state": { instanceId: "entry-core", phase: "observed_conformant", state: { phase: "observed_conformant", nativeChecked: true, recoveryRequired: false, observed: { known: true, observedAt: new Date().toISOString(), generation: "1", evidence: "fixture" } } },
      "/api/agent/instances/relay-core/state": { instanceId: "relay-core", phase: "validation_failed", state: { phase: "validation_failed", nativeChecked: false, recoveryRequired: false } },
      "/api/admin/nodes/dashboard-host/observability": {
        nodeId: host.id,
        config: { revision: 1, observerInstanceId: "entry-core", billedInterfaces: ["eth0"], provider: { name: "Example VPS", mode: "limited", allowance: 1, unit: "TB", cycleId: "fixture-month", cycleStart: "2026-11-01T00:00:00Z", cycleEnd: "2026-12-01T00:00:00Z", notificationSource: "provider_statement", exhaustionAction: "advisory" } },
        latest: { observedAt: new Date().toISOString(), cpuPercent: 23.4, receiveBytesPerSecond: 12500000, transmitBytesPerSecond: 2400000, metrics: { memoryTotalBytes: 8589934592, memoryAvailableBytes: 5368709120, load1: 0.82, load5: 0.71, load15: 0.64, interfaces: [] } },
        provider: { source: "provider_statement", coverage: "cycle", statusReason: "operator_entered_provider_statement", fresh: false, observedAt: "2026-11-07T09:00:00Z", totalBytes: 1000000000000, usedBytes: 240000000000, remainingBytes: 760000000000, exhaustionAction: "advisory" },
      },
    };
    const writes: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.url()); });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET" && path in inventory) await route.fulfill({ json: inventory[path] });
      else await route.continue();
    });
    await page.goto(`/#servers?host=${host.id}`);
    const workspace = page.getByRole("region", { name: host.name, exact: true });
    await expect(workspace.getByText("23.4%", { exact: true })).toBeVisible();
    await expect(workspace.getByText("核心校验失败", { exact: true })).toBeVisible();
    await expect(workspace.getByText("较早的用量记录", { exact: true })).toBeVisible();
    await expect(workspace.getByRole("status", { name: "服务器配置提示" })).toHaveCount(0);
    await expect(workspace.getByText("服务器在线", { exact: true })).toHaveCount(0);
    await settledTask(workspace);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const card of await workspace.getByRole("group").all()) {
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    const screenshot = info.outputPath(`server-dashboard-overview-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach(`server-dashboard-overview-${width}`, { path: screenshot, contentType: "image/png" });
    const failedCore = workspace.locator(".subscription-row").filter({ has: page.getByRole("heading", { name: "Regional relay", exact: true }) });
    await failedCore.getByRole("button", { name: "查看接入与配置", exact: true }).click();
    await expect(page).toHaveURL(/instance=relay-core/);
    await expect(page.getByRole("region", { name: "Tokyo gateway的Regional relay", exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
}
