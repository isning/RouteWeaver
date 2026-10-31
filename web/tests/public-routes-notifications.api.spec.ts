import { expect, test } from "@playwright/test";

test("real public route provisions a private principal but never claims an unregistered core is applied", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(auth.ok()).toBeTruthy();
  const session = await auth.json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = Date.now().toString(36);
  const create = async (kind: string, data: unknown) => {
    const r = await request.post(`/api/${kind}`, { headers, data });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const host = {
    id: `h_${suffix}`,
    name: "Local synthetic host",
    address: "127.0.0.1",
  };
  const instance = {
    id: `i_${suffix}`,
    hostId: host.id,
    name: "Managed public ingress",
    adapterId: "routeweaver/managed-xray",
    version: "26.3.27-rw1",
  };
  const endpoint = {
    id: `e_${suffix}`,
    instanceId: instance.id,
    name: "Synthetic public entry",
    connection: {
      protocol: "vless",
      host: "127.0.0.1",
      port: 12345,
      uuid: "00000000-0000-4000-8000-000000000099",
    },
  };
  await create("hosts", host);
  await create("core-instances", instance);
  await create("managed-endpoints", endpoint);
  const deployment = {
    id: `d_${suffix}`,
    name: "Synthetic managed path",
    ir: {
      schemaVersion: "1.0",
      id: `d_${suffix}`,
      topologyRevision: "t1",
      programs: [
        { instance, listener: endpoint, egress: [], rules: [], resources: [] },
      ],
    },
  };
  await create("server-deployments", deployment);
  const route = {
    id: `r_${suffix}`,
    name: "Public local-only fixture",
    deploymentId: deployment.id,
    endpointIds: [endpoint.id],
    publicHost: "127.0.0.1",
    publicPort: 12345,
  };
  expect((await create("published-routes/preview", route)).status).toBe(
    "draft",
  );
  await create("published-routes", route);
  const plan = {
    id: `s_${suffix}`,
    name: "Synthetic plan",
    routeIds: [route.id],
    quotaBytes: 0,
    cycle: {
      mode: "none",
      timezone: "UTC+8",
      anchor: new Date().toISOString(),
    },
  };
  await create("services", plan);
  const entitlement = await request.put(
    `/api/users/${session.user.id}/entitlement`,
    { headers, data: { serviceId: plan.id, cycle: plan.cycle } },
  );
  expect(entitlement.ok(), await entitlement.text()).toBeTruthy();
  const principal = await create(`published-routes/${route.id}/principals`, {
    accountId: session.user.id,
    credentialVersion: "fixture-v1",
  });
  expect(principal.status).toBe("pending-deployment");
  expect(principal.subjectId).toBeTruthy();
  expect(JSON.stringify(principal)).not.toContain(
    "00000000-0000-4000-8000-000000000099",
  );
  const entries = await (
    await request.get(`/api/users/${session.user.id}/entries`)
  ).json();
  expect(entries.find((e: any) => e.id === principal.entryId)).toMatchObject({
    publishedRouteId: route.id,
    status: "pending-deployment",
  });
  expect(
    (
      await request.get(
        `/api/users/${session.user.id}/entries/${principal.entryId}/reveal`,
      )
    ).status(),
  ).toBe(409);
  const state = await (
    await request.get(`/api/agent/instances/${instance.id}/state`)
  ).json();
  expect(state.phase).toBe("unregistered");
  // Principal creation changed this draft. Open its resulting revision before
  // checking it; never renew the token after a rejected validation attempt.
  const openedResponse = await request.get(
    `/api/server-deployments/${deployment.id}`,
  );
  expect(openedResponse.ok()).toBeTruthy();
  const openedDeployment = await openedResponse.json();
  const validationResponse = await request.post(
    `/api/server-deployments/${deployment.id}/validate`,
    {
      headers: { ...headers, "If-Match": openedDeployment.revisionToken },
      data: {},
    },
  );
  expect(validationResponse.ok(), await validationResponse.text()).toBeTruthy();
  const validation = await validationResponse.json();
  expect(validation.valid).toBe(true);
  expect(validation.nativeChecked).toBe(false);
  expect(validation.artifacts.length).toBeGreaterThan(0);
});

test("announcement editing preserves read receipt, disabling removes it, and in-app test reports actual availability", async ({
  request,
}) => {
  // The real daemon evaluates once per minute, with a 15-second batch budget.
  // Allow that lifecycle plus runner margin here, not a global UI timeout change.
  test.setTimeout(90000);
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await auth.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const id = `notice_${Date.now().toString(36)}`;
  const announcement = {
    id,
    title: "Local test notice",
    body: "Synthetic in-app announcement only",
    audience: "admins",
    userIds: [],
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    enabled: true,
  };
  const created = await request.post("/api/admin/announcements", {
    headers,
    data: announcement,
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  // Saving schedules the notice; inbox GET is read-only and must not evaluate
  // or dispatch it. Observe actual availability from the production worker.
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/me/notifications");
        if (!response.ok()) {
          return { status: response.status(), error: await response.text() };
        }
        const inbox = await response.json();
        return {
          status: response.status(),
          announcement: inbox.find((n: any) => n.announcementId === id),
        };
      },
      {
        message:
          "saved announcement becomes available through the daemon worker",
        timeout: 80000, // 60s tick + 15s batch + 5s runner margin
        intervals: [250, 1000],
      },
    )
    .toMatchObject({
      status: 200,
      announcement: {
        announcementId: id,
        title: announcement.title,
        body: announcement.body,
      },
    });
  const inboxResponse = await request.get("/api/me/notifications");
  expect(inboxResponse.ok(), await inboxResponse.text()).toBeTruthy();
  const inbox = await inboxResponse.json();
  const item = inbox.find((n: any) => n.announcementId === id);
  expect(item).toBeTruthy();
  expect(
    (
      await request.post(`/api/me/notifications/${item.eventId}/read`, {
        headers,
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.put(`/api/admin/announcements/${id}`, {
        headers,
        data: { ...announcement, body: "Edited notice body" },
      })
    ).ok(),
  ).toBeTruthy();
  const read = (await (await request.get("/api/me/notifications")).json()).find(
    (n: any) => n.eventId === item.eventId,
  );
  expect(read.body).toBe("Edited notice body");
  expect(read.readAt).toBeTruthy();
  expect(
    (
      await request.put(`/api/admin/announcements/${id}`, {
        headers,
        data: { ...announcement, enabled: false },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await (await request.get("/api/me/notifications")).json()).some(
      (n: any) => n.eventId === item.eventId,
    ),
  ).toBe(false);
  const tested = await request.post("/api/admin/notifications/test", {
    headers,
    data: { channel: "in-app" },
  });
  expect(tested.ok(), await tested.text()).toBeTruthy();
  expect((await tested.json()).status).toBe("available");
  const settings = await (
    await request.get("/api/admin/notification-settings")
  ).json();
  expect(settings.email.enabled).toBe(false);
  expect(settings.webhook.enabled).toBe(false);
  const settingsUpdate = await request.put("/api/admin/notification-settings", {
    headers,
    data: { ...settings, repeatHours: 12 },
  });
  expect(settingsUpdate.ok(), await settingsUpdate.text()).toBeTruthy();
  expect(
    (
      await request.put("/api/admin/notification-settings", {
        headers,
        data: settings,
      })
    ).status(),
  ).toBe(409);
});

test("admin infrastructure summaries hide secrets and explicit edit reveal preserves them", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await auth.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36);
  const secret = `synthetic-private-key-${suffix}`;
  const host = {
    id: `secret_h_${suffix}`,
    name: "Secret-preservation fixture",
    address: "127.0.0.1",
  };
  const core = {
    id: `secret_i_${suffix}`,
    hostId: host.id,
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  };
  const endpoint = {
    id: `secret_e_${suffix}`,
    instanceId: core.id,
    name: "Synthetic endpoint",
    connection: {
      host: "127.0.0.1",
      port: 1080,
      protocol: "socks",
      username: "fixture",
      password: secret,
    },
  };
  for (const [kind, data] of [
    ["hosts", host],
    ["core-instances", core],
    ["managed-endpoints", endpoint],
  ] as const) {
    const response = await request.post(`/api/${kind}`, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const deployment = {
    id: `secret_d_${suffix}`,
    name: "Secret draft",
    ir: {
      schemaVersion: "1.0",
      id: `secret_d_${suffix}`,
      topologyRevision: "t1",
      programs: [
        {
          instance: core,
          listener: endpoint,
          egress: [],
          rules: [],
          resources: [],
          tls: {
            certificatePem: "synthetic-certificate-not-for-deployment",
            privateKeyPem: secret,
          },
        },
      ],
    },
  };
  expect(
    (
      await request.post("/api/server-deployments", {
        headers,
        data: deployment,
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    await (await request.get("/api/managed-endpoints")).text(),
  ).not.toContain(secret);
  expect(
    await (await request.get("/api/server-deployments")).text(),
  ).not.toContain(secret);
  const revealedEndpointResponse = await request.get(
    `/api/managed-endpoints/${endpoint.id}/reveal`,
  );
  expect(
    revealedEndpointResponse.ok(),
    await revealedEndpointResponse.text(),
  ).toBeTruthy();
  const revealedEndpoint = await revealedEndpointResponse.json();
  expect(revealedEndpoint.connection.password).toBe(secret);
  const revealedResponse = await request.get(
    `/api/server-deployments/${deployment.id}/reveal`,
  );
  expect(revealedResponse.ok(), await revealedResponse.text()).toBeTruthy();
  const revealed = await revealedResponse.json();
  expect(revealed.ir.programs[0].tls.privateKeyPem).toBe(secret);
  const { revisionToken, ...editableDeployment } = revealed;
  expect(revisionToken).toEqual(expect.any(String));
  expect(revisionToken.length).toBeGreaterThan(0);
  editableDeployment.name = "Renamed private draft";
  const missingRevision = await request.put(
    `/api/server-deployments/${deployment.id}`,
    {
      headers,
      data: editableDeployment,
    },
  );
  expect(missingRevision.status(), await missingRevision.text()).toBe(409);
  const savedResponse = await request.put(
    `/api/server-deployments/${deployment.id}`,
    {
      headers: { ...headers, "If-Match": revisionToken },
      data: editableDeployment,
    },
  );
  expect(savedResponse.ok(), await savedResponse.text()).toBeTruthy();
  const staleRevision = await request.put(
    `/api/server-deployments/${deployment.id}`,
    {
      headers: { ...headers, "If-Match": revisionToken },
      data: { ...editableDeployment, name: "Stale edit must not win" },
    },
  );
  expect(staleRevision.status(), await staleRevision.text()).toBe(409);
  const roundtrip = await (
    await request.get(`/api/server-deployments/${deployment.id}/reveal`)
  ).json();
  expect(roundtrip.name).toBe("Renamed private draft");
  expect(roundtrip.revisionToken).not.toBe(revisionToken);
  expect(roundtrip.ir.programs[0].tls.privateKeyPem).toBe(secret);
  expect(roundtrip.ir.programs[0].listener.connection.password).toBe(secret);
});
