import { test, expect } from "@playwright/test";
import type { NodeObservationView } from "../src/observability-model";

// Actual App/NodeObservation/ObservationConfigForm, synthetic read-only HTTP.
// This checks narrow decision context and focus, not provider enforcement or persistence.
test.use({ trace: "off", screenshot: "off", video: "off" });
test("managed provider suspension opt-in preserves complete consequences and safe cancel focus at 320", async ({
  page,
}, info) => {
  const base = info.project.use.baseURL;
  if (
    !base ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
  )
    throw new Error("Controlled provider decision QA requires loopback");
  const hostId = "host-provider-europe-asia";
  const hostName = "欧洲与亚太跨区域供应商主机";
  const observation: NodeObservationView = {
    nodeId: hostId,
    latest: null,
    provider: {
      source: "none",
      coverage: "none",
      statusReason: "provider_statement_required",
      fresh: false,
      observedAt: null,
      observedSince: null,
      observedNicBytes: 0,
      totalBytes: null,
      usedBytes: null,
      remainingBytes: null,
      exhaustionAction: "advisory",
      notificationEligible: false,
    },
    config: {
      revision: 1,
      observerInstanceId: "",
      billedInterfaces: [],
      provider: {
        name: "跨区域供应商",
        mode: "limited",
        allowance: 100,
        unit: "GB",
        cycleId: "fixture-cycle",
        cycleStart: "2026-10-01T00:00:00Z",
        cycleEnd: "2026-11-01T00:00:00Z",
        notificationSource: "provider_statement",
        exhaustionAction: "advisory",
      },
    },
  };
  const fixtures: Record<string, unknown> = {
    "/auth/me": {
      user: { id: "review-admin", name: "Review admin", role: "admin" },
      csrfToken: "fixture",
    },
    "/hosts": [
      { id: hostId, name: hostName, address: "provider.example.test" },
    ],
    "/core-instances": [
      {
        id: "managed-core",
        hostId,
        name: "Managed core",
        adapterId: "routeweaver/managed-xray",
        version: "26.3.27-rw1",
      },
    ],
    "/agent/instances/managed-core/state": { instanceId: "managed-core", phase: "unregistered" },
    "/managed-endpoints": [],
    "/links": [],
    "/server-deployments": [],
    [`/admin/nodes/${hostId}/observability`]: observation,
      [`/admin/nodes/${hostId}/observability/history`]: { nodeId: hostId, available: true, intervalSeconds: 300, windowStart: new Date(Date.now() - 86400000).toISOString(), windowEnd: new Date().toISOString(), points: [] },
  };
  const unexpected: string[] = [];
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== new URL(base).origin) {
      unexpected.push("external request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = url.pathname.slice(4);
    if (request.method() !== "GET" || !(key in fixtures)) {
      unexpected.push(`${request.method()} ${key}`);
      return route.fulfill({
        status: 503,
        json: { message: "Unexpected controlled provider request" },
      });
    }
    return route.fulfill({ json: fixtures[key] });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/#servers");
  await page.getByRole("button", { name: hostName, exact: true }).click();
  const host = page.getByRole("region", { name: hostName, exact: true });
  await host
    .getByRole("tab", { name: "诊断", exact: true })
    .click();
  await host
    .getByRole("button", { name: "设置采集与额度", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "采集与供应商额度",
    exact: true,
  });
  const policy = editor.getByRole("combobox", {
    name: "额度耗尽行为",
    exact: true,
  });
  await policy.click();
  await page
    .getByRole("option", { name: "暂停托管连接及续期", exact: true })
    .click();
  const submit = editor
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "保存采集与额度设置", exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await submit.click();
    const decision = page.getByRole("alertdialog", {
      name: `启用 ${hostId} 的托管连接暂停策略？`,
      exact: true,
    });
    const title = decision.getByRole("heading", {
      name: `启用 ${hostId} 的托管连接暂停策略？`,
      exact: true,
    });
    const description = decision.locator(
      '[data-slot="alert-dialog-description"]',
    );
    await expect(description).toContainText(
      "所选依据缺失或超过 15 分钟、周期失效时拒绝新连接及续期；现有连接按短租约结束",
    );
    await expect(description).toContainText("手工账单记录不会自动刷新");
    await expect(description).toContainText(
      "stock 内核和已导出的外部代理凭据不受此策略控制，不自动切换出口",
    );
    await expect(description).toContainText(
      "更新有效用量或改回仅提醒可恢复后续准入",
    );
    await expect(description).toContainText(
      "回退旧版本需启用前备份，关闭策略不会降级数据",
    );
    const footer = decision.locator('[data-slot="alert-dialog-footer"]');
    const cancel = footer.getByRole("button", {
      name: "返回修改",
      exact: true,
    });
    await expect(cancel).toBeFocused();
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(description).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await expect(
      footer.getByRole("button", { name: "确认启用并保存", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const box = await decision.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    expect(
      await decision.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    if (attempt === 0)
      await page.screenshot({
        path: info.outputPath("provider-suspension-opt-in-320.png"),
      });
    await cancel.click();
    await expect(decision).not.toBeVisible();
    await expect(submit).toBeFocused();
    await expect(policy).toHaveText("暂停托管连接及续期");
    await expect(
      editor.getByRole("textbox", { name: "供应商或服务名称", exact: true }),
    ).toHaveValue("跨区域供应商");
    expect(unexpected).toEqual([]);
  }
});

