import { expect, test } from "@playwright/test";

test("fleet preview binds the exact configuration and keeps later stages blocked until actual confirmation", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const headers = { "X-CSRF-Token": (await login.json()).csrfToken },
    suffix = Date.now().toString(36),
    deploymentId = `fleet-${suffix}`;
  const programs: any[] = [],
    targetIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const host = {
      id: `fleet-host-${suffix}-${i}`,
      name: `Fleet host ${i}`,
      address: "127.0.0.1",
      group: "Synthetic group",
      tags: ["api-task"],
    };
    const instance = {
      id: `fleet-core-${suffix}-${i}`,
      name: `Fleet core ${i}`,
      hostId: host.id,
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    };
    const listener = {
      id: `fleet-entry-${suffix}-${i}`,
      name: `Fleet listener ${i}`,
      instanceId: instance.id,
      connection: {
        protocol: "socks",
        host: "127.0.0.1",
        port: 23550 + i,
        username: "fixture",
        password: "synthetic-fleet-password",
      },
    };
    for (const [path, data] of [
      ["/api/hosts", host],
      ["/api/core-instances", instance],
      ["/api/managed-endpoints", listener],
      [
        "/api/agent/enrollments",
        {
          nodeId: host.id,
          instanceId: instance.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    ] as const) {
      const saved = await request.post(path, { headers, data });
      expect(saved.ok(), await saved.text()).toBeTruthy();
    }
    programs.push({ instance, listener });
    targetIds.push(instance.id);
  }
  const saved = await request.post("/api/server-deployments", {
    headers,
    data: {
      id: deploymentId,
      name: "Fleet API task",
      ir: {
        id: deploymentId,
        schemaVersion: "1.0",
        topologyRevision: "initial",
        programs,
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const input = {
      action: "configure",
      deploymentId,
      targetIds,
      stages: [[targetIds[0]], [targetIds[1]]],
    },
    base = "/api/admin/fleet-batches";
  const preview = await request.post(`${base}/preview`, {
    headers,
    data: input,
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const plan = await preview.json();
  expect(plan.supported).toBe(true);
  expect(plan.targets).toHaveLength(2);
  const stale = await request.post(base, {
    headers,
    data: { ...input, expectedFingerprint: "not-reviewed", leaseSeconds: 300 },
  });
  expect(stale.status()).toBe(409);
  const created = await request.post(base, {
    headers,
    data: {
      ...input,
      expectedFingerprint: plan.fingerprint,
      leaseSeconds: 300,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const batch = await created.json();
  expect(batch.status).toBe("planned");
  const early = await request.post(`${base}/${batch.id}/execute`, {
    headers,
    data: { stage: 1, requestId: `early-${suffix}` },
  });
  expect(early.status()).toBe(409);
  const execution = { stage: 0, requestId: `execute-${suffix}` };
  const queued = await request.post(`${base}/${batch.id}/execute`, {
    headers,
    data: execution,
  });
  expect(queued.ok(), await queued.text()).toBeTruthy();
  const result = await queued.json();
  expect(result.status).not.toBe("succeeded");
  expect(result.targets[0].status).toBe("queued");
  expect(result.targets[1].status).toBe("planned");
  const duplicate = await request.post(`${base}/${batch.id}/execute`, {
    headers,
    data: execution,
  });
  expect(duplicate.ok(), await duplicate.text()).toBeTruthy();
  const retry = await request.post(`${base}/${batch.id}/retry`, {
    headers,
    data: { targetIds: [targetIds[0]], requestId: `retry-${suffix}` },
  });
  expect(retry.status()).toBe(409);
  const hosts = await (await request.get("/api/hosts")).json();
  expect(
    hosts.find((h: any) => h.id === `fleet-host-${suffix}-0`),
  ).toMatchObject({ group: "Synthetic group", tags: ["api-task"] });
});
