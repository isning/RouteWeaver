import { expect, test } from "@playwright/test";
test("real provider settings and statement preserve unknown host observations and reject stale configuration", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await login.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36),
    nodeId = `obs-host-${suffix}`,
    instanceId = `obs-core-${suffix}`;
  expect(
    (
      await request.post("/api/hosts", {
        headers,
        data: {
          id: nodeId,
          name: "Provider observation fixture",
          address: "127.0.0.1",
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post("/api/core-instances", {
        headers,
        data: {
          id: instanceId,
          hostId: nodeId,
          adapterId: "routeweaver/xray",
          version: "26.3.27",
        },
      })
    ).ok(),
  ).toBeTruthy();
  const base = `/api/admin/nodes/${nodeId}/observability`;
  const initialResponse = await request.get(base);
  expect(initialResponse.ok(), await initialResponse.text()).toBeTruthy();
  const initial = await initialResponse.json();
  expect(initial.latest).toBeNull();
  expect(initial.provider.usedBytes).toBeNull();
  expect(initial.provider.remainingBytes).toBeNull();
  const now = Date.now(),
    config = {
      revision: initial.config.revision,
      observerInstanceId: instanceId,
      billedInterfaces: ["eth0"],
      provider: {
        name: "Synthetic allowance",
        mode: "limited",
        allowance: 800,
        unit: "GB",
        cycleId: `cycle-${suffix}`,
        cycleStart: new Date(now - 3600000).toISOString(),
        cycleEnd: new Date(now + 3600000).toISOString(),
        notificationSource: "provider_statement",
        exhaustionAction: "advisory",
      },
    };
  const saved = await request.put(`${base}/config`, { headers, data: config });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect((await saved.json()).config.revision).toBe(config.revision + 1);
  expect(
    (await request.put(`${base}/config`, { headers, data: config })).status(),
  ).toBe(409);
  const statement = await request.post(`${base}/provider-statement`, {
    headers,
    data: {
      cycleId: config.provider.cycleId,
      usedBytes: 799000000000,
      observedAt: new Date(now).toISOString(),
      reference: "Synthetic provider statement, no remote retrieval",
    },
  });
  expect(statement.ok(), await statement.text()).toBeTruthy();
  const view = await statement.json();
  expect(view.latest).toBeNull();
  expect(view.provider).toMatchObject({
    source: "provider_statement",
    coverage: "provider_statement",
    usedBytes: 799000000000,
    remainingBytes: 1000000000,
    totalBytes: 800000000000,
  });
  const unsupportedBaseline = await request.post(`${base}/baseline`, {
    headers,
    data: {
      cycleId: config.provider.cycleId,
      usedBytes: 799000000000,
      reportDigest: "no-report",
      reason: "Must not synthesize missing node sample",
    },
  });
  expect(unsupportedBaseline.status()).toBe(409);
  const retained = await (await request.get(base)).json();
  expect(retained.baseline).toBeNull();
  expect(retained.provider.remainingBytes).toBe(1000000000);
  const unlimited = {
    ...retained.config,
    provider: {
      name: "Unlimited supplier",
      mode: "unlimited",
      allowance: 0,
      unit: "GB",
      notificationSource: "none",
      exhaustionAction: "advisory",
    },
  };
  const unlimitedResponse = await request.put(`${base}/config`, {
    headers,
    data: unlimited,
  });
  expect(unlimitedResponse.ok(), await unlimitedResponse.text()).toBeTruthy();
  const unlimitedView = await unlimitedResponse.json();
  expect(unlimitedView.config.provider.cycleId).toBe("");
  expect(unlimitedView.provider.remainingBytes).toBeNull();
  expect(unlimitedView.provider.totalBytes).toBeNull();
  expect(unlimitedView.provider.notificationEligible).toBe(false);
});
