import { expect, test } from "@playwright/test";
import { emptyProfile } from "../src/model";

test("native client edits survive private draft editing and cannot replace an already published feed when invalid", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const headers = { "X-CSRF-Token": (await login.json()).csrfToken };
  const profile = emptyProfile();
  profile.name = "Native client API task";
  profile.ir.nativeOverride = {
    schemaVersion: "1",
    namespace: "routeweaver/native-client",
    target: profile.target,
    format: "json",
    ruleMode: "prepend",
    content:
      '{"dns":{"enable":true,"enhanced-mode":"fake-ip","nameserver":["https://1.1.1.1/dns-query"]},"rules":["PROCESS-NAME,curl,DIRECT"]}',
  };
  const saved = await request.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect((await saved.json()).ir.nativeOverride.content).toBeUndefined();
  const { revisionToken: openedRevision, ...revealed } = await (
    await request.get(`/api/me/profiles/${profile.id}/reveal`)
  ).json();
  expect(revealed.ir.nativeOverride.content).toBe(
    profile.ir.nativeOverride.content,
  );
  const preview = await request.post("/api/me/profiles/preview", {
    headers,
    data: revealed,
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const reviewed = await preview.json();
  expect(reviewed.nativeOverride).toMatchObject({
    target: profile.target,
    ruleMode: "prepend",
    nonportable: true,
  });
  expect(JSON.stringify(reviewed.artifacts)).toContain(
    "PROCESS-NAME,curl,DIRECT",
  );
  const outputId = `native-out-${Date.now().toString(36)}`;
  const published = await request.post("/api/me/outputs", {
    headers,
    data: { id: outputId, name: "Native feed", profileId: profile.id },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  const { feedPath } = await published.json();
  let before = await (await request.get(feedPath)).text();
  expect(before).toContain("PROCESS-NAME,curl,DIRECT");
  const updatePreview = await request.post(
    `/api/me/profiles/${profile.id}/preview`,
    { headers, data: { outputId, target: profile.target, mode: "full" } },
  );
  expect(updatePreview.ok(), await updatePreview.text()).toBeTruthy();
  const exactUpdate = await updatePreview.json();
  expect(exactUpdate).toMatchObject({
    outputId,
    previewScope: "output-update",
  });
  expect(exactUpdate.artifacts[0].content.trim()).toBe(before.trim());
  expect(exactUpdate.previewDigest).toMatch(/^[a-f0-9]{64}$/);
  revealed.name = "Changed after output review";
  const renamed = await request.put(`/api/me/profiles/${profile.id}`, {
    headers: { ...headers, "If-Match": openedRevision },
    data: revealed,
  });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();
  const renamedRevision = (await renamed.json()).revisionToken;
  const staleReview = await request.post(
    `/api/me/outputs/${outputId}/publish`,
    { headers, data: { previewDigest: exactUpdate.previewDigest } },
  );
  expect(staleReview.status(), await staleReview.text()).toBe(409);
  expect(await (await request.get(feedPath)).text()).toBe(before);
  const refreshed = await request.post(
    `/api/me/profiles/${profile.id}/preview`,
    { headers, data: { outputId } },
  );
  expect(refreshed.ok(), await refreshed.text()).toBeTruthy();
  const refreshedReview = await refreshed.json();
  expect(refreshedReview.previewDigest).not.toBe(exactUpdate.previewDigest);
  const appliedReview = await request.post(
    `/api/me/outputs/${outputId}/publish`,
    { headers, data: { previewDigest: refreshedReview.previewDigest } },
  );
  expect(appliedReview.ok(), await appliedReview.text()).toBeTruthy();
  before = await (await request.get(feedPath)).text();
  expect(before.trim()).toBe(refreshedReview.artifacts[0].content.trim());
  const mismatched = await request.post(
    `/api/me/profiles/${profile.id}/preview`,
    {
      headers,
      data: { outputId, target: { adapterId: "sing-box", version: "1.14.3" } },
    },
  );
  expect(mismatched.status()).toBe(409);
  revealed.ir.nativeOverride.content = '{"dns":';
  const invalid = await request.put(`/api/me/profiles/${profile.id}`, {
    headers: { ...headers, "If-Match": renamedRevision },
    data: revealed,
  });
  expect(invalid.ok(), await invalid.text()).toBeTruthy();
  expect((await invalid.json()).diagnostics.length).toBeGreaterThan(0);
  expect(
    (await (await request.get(`/api/me/profiles/${profile.id}/reveal`)).json())
      .ir.nativeOverride.content,
  ).toBe('{"dns":');
  const rejected = await request.post(`/api/me/outputs/${outputId}/publish`, {
    headers,
    data: {},
  });
  expect(rejected.status()).toBe(422);
  expect(await (await request.get(feedPath)).text()).toBe(before);
});

test("bounded diagnostic intent queues and cancels without claiming an unexecuted network test succeeded", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const headers = { "X-CSRF-Token": (await login.json()).csrfToken };
  const suffix = Date.now().toString(36),
    nodeId = `diag-host-${suffix}`,
    instanceId = `diag-core-${suffix}`,
    targetId = `diag-target-${suffix}`,
    jobId = `diag-job-${suffix}`;
  for (const [path, data] of [
    [
      "/api/hosts",
      { id: nodeId, name: "Diagnostic task", address: "127.0.0.1" },
    ],
    [
      "/api/core-instances",
      {
        id: instanceId,
        hostId: nodeId,
        adapterId: "routeweaver/xray",
        version: "26.3.27",
      },
    ],
    [
      "/api/agent/enrollments",
      {
        nodeId,
        instanceId,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ],
    [
      "/api/admin/diagnostic-targets",
      {
        id: targetId,
        name: "Declared target, never contacted in this test",
        nodeId,
        url: "https://example.com/test",
        methods: ["connectivity"],
      },
    ],
  ] as const) {
    const response = await request.post(path, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const body = {
    id: jobId,
    targetId,
    instanceId,
    kind: "connectivity",
    maxBytes: 0,
    timeoutSeconds: 10,
  };
  const created = await request.post("/api/admin/diagnostic-jobs", {
    headers,
    data: body,
  });
  expect(created.status(), await created.text()).toBe(201);
  expect(await created.json()).toMatchObject({
    id: jobId,
    status: "queued",
    costBasis: "application_payload_not_wire_or_provider_billing",
  });
  const duplicate = await request.post("/api/admin/diagnostic-jobs", {
    headers,
    data: body,
  });
  expect(duplicate.ok(), await duplicate.text()).toBeTruthy();
  const cancelled = await request.post(
    `/api/admin/diagnostic-jobs/${jobId}/cancel`,
    { headers, data: {} },
  );
  expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
  const final = await (
    await request.get(`/api/admin/diagnostic-jobs/${jobId}`)
  ).json();
  expect(final.status).toBe("not_run");
  expect(final.result.code).toBe("cancelled_before_start");
  expect(final.result?.status).not.toBe("succeeded");
  const bad = await request.post("/api/admin/diagnostic-targets", {
    headers,
    data: {
      id: `bad-${suffix}`,
      nodeId,
      name: "Private target must fail",
      url: "https://127.0.0.1/test",
      methods: ["download"],
    },
  });
  expect(bad.status()).toBe(400);
  const paths = await request.get("/api/admin/diagnostic-paths");
  expect(paths.ok()).toBeTruthy();
  expect(Array.isArray(await paths.json())).toBe(true);
  const unobserved = await request.post("/api/admin/diagnostic-jobs", {
    headers,
    data: {
      ...body,
      id: `managed-${suffix}`,
      pathMode: "managed_route",
      publishedRouteId: `missing-route-${suffix}`,
    },
  });
  expect(unobserved.ok()).toBe(false);
  expect(
    (
      await request.get(`/api/admin/diagnostic-jobs/managed-${suffix}`)
    ).status(),
  ).toBe(404);
});
