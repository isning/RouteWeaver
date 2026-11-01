import { test, expect } from "@playwright/test";
test("template follow updates preserve local steps and require a current review digest", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const { csrfToken } = await login.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36);
  const source = await request.post("/api/me/sources", {
    headers,
    data: {
      id: `preset-src-${suffix}`,
      name: "Template task source",
      kind: "text",
      enabled: true,
      content: "socks5://proxy.example.com:1080#London",
    },
  });
  expect(source.ok(), await source.text()).toBeTruthy();
  const collectionId = `preset-col-${suffix}`;
  const collection = await request.post("/api/me/collections", {
    headers,
    data: {
      id: collectionId,
      name: "Template collection",
      sources: [{ sourceId: `preset-src-${suffix}`, steps: [] }],
      steps: [],
    },
  });
  expect(collection.ok(), await collection.text()).toBeTruthy();
  const templateId = `preset-${suffix}`;
  const upstream = {
    id: "upstream-rename",
    enabled: true,
    kind: "rename",
    template: "Original {name}",
  };
  const initial = await request.post("/api/admin/templates", {
    headers,
    data: {
      id: templateId,
      name: "Reusable naming",
      kind: "processing-preset",
      expectedVersion: 0,
      spec: { steps: [upstream] },
    },
  });
  expect(initial.ok(), await initial.text()).toBeTruthy();
  const select = await request.post(`/api/me/templates/${templateId}/select`, {
    headers,
    data: { version: 1, mode: "follow", targetId: collectionId, bindings: {} },
  });
  expect(select.ok(), await select.text()).toBeTruthy();
  const selected = await select.json();
  const bindingId = selected.binding.id;
  let current = await (
    await request.get(`/api/me/collections/${collectionId}`)
  ).json();
  current.steps.push({
    id: "local-sort",
    enabled: true,
    kind: "sort",
    sortBy: "name",
  });
  expect(
    (
      await request.put(`/api/me/collections/${collectionId}`, {
        headers,
        data: current,
      })
    ).ok(),
  ).toBeTruthy();
  const update = await request.post("/api/admin/templates", {
    headers,
    data: {
      id: templateId,
      name: "Reusable naming",
      kind: "processing-preset",
      expectedVersion: 1,
      spec: { steps: [{ ...upstream, template: "Updated {name}" }] },
    },
  });
  expect(update.ok(), await update.text()).toBeTruthy();
  const firstPreview = await request.post(
    `/api/me/template-bindings/${bindingId}/preview`,
    { headers, data: {} },
  );
  expect(firstPreview.ok(), await firstPreview.text()).toBeTruthy();
  const first = await firstPreview.json();
  expect(first.compatible).toBe(true);
  expect(first.hasUpdate).toBe(true);
  expect(first.nativeChecked).toBe(false);
  expect(first.preservedLocalEdits.length).toBeGreaterThan(0);
  current = await (
    await request.get(`/api/me/collections/${collectionId}`)
  ).json();
  current.name = "Locally renamed after review";
  expect(
    (
      await request.put(`/api/me/collections/${collectionId}`, {
        headers,
        data: current,
      })
    ).ok(),
  ).toBeTruthy();
  const stale = await request.post(
    `/api/me/template-bindings/${bindingId}/apply`,
    { headers, data: { previewDigest: first.previewDigest } },
  );
  expect(stale.status()).toBe(409);
  const fresh = await (
    await request.post(`/api/me/template-bindings/${bindingId}/preview`, {
      headers,
      data: {},
    })
  ).json();
  const applied = await request.post(
    `/api/me/template-bindings/${bindingId}/apply`,
    { headers, data: { previewDigest: fresh.previewDigest } },
  );
  expect(applied.ok(), await applied.text()).toBeTruthy();
  const final = await (
    await request.get(`/api/me/collections/${collectionId}`)
  ).json();
  expect(final.name).toBe("Locally renamed after review");
  expect(
    final.steps.find((s: any) => s.id === "upstream-rename").template,
  ).toBe("Updated {name}");
  expect(final.steps.some((s: any) => s.id === "local-sort")).toBe(true);
});
test("encrypted backup downloads as a file and preview authenticates before offering restore", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const { csrfToken } = await login.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const password = "synthetic-local-backup-passphrase";
  const download = await request.post("/api/admin/backups", {
    headers,
    data: { password },
  });
  expect(download.ok(), await download.text()).toBeTruthy();
  expect(download.headers()["content-type"]).toContain(
    "application/octet-stream",
  );
  const bytes = await download.body();
  expect(bytes.subarray(0, 30).toString()).toContain("age-encryption.org");
  const rejected = await request.post("/api/admin/backups/preview", {
    headers,
    data: {
      password: "wrong-fixture-password",
      archive: bytes.toString("base64"),
    },
  });
  expect(rejected.ok()).toBe(false);
  const preview = await request.post("/api/admin/backups/preview", {
    headers,
    multipart: {
      metadata: JSON.stringify({ password }),
      archive: {
        name: "routeweaver.age",
        mimeType: "application/octet-stream",
        buffer: bytes,
      },
    },
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const body = await preview.json();
  expect(body.manifest.containsSecrets).toBe(true);
  expect(body.impact.replacesLiveStore).toBe(false);
  expect(body.impact.requiresRestart).toBe(true);
  expect(body.digest).toBeTruthy();
});
