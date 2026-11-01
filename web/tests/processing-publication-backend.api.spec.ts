import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { processingPublicationFixture } from "./processing-publication-backend";

test("isolated processing recipe preserves stages, source and sibling feed through exact publication", async ({
  request,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  try {
    const f = await processingPublicationFixture(admin, request);
    const recipe = {
      ...f.collection,
      sources: [
        {
          sourceId: f.id,
          steps: [
            {
              id: "source-override",
              kind: "override",
              enabled: true,
              override: { region: "DE", port: 2080 },
            },
          ],
        },
      ],
      steps: [
        { id: "dedup", kind: "deduplicate", enabled: true },
        {
          id: "override",
          kind: "override",
          enabled: true,
          override: { port: 3080 },
        },
      ],
    };
    const preview = await request.post("/api/me/collections/preview", {
      headers: f.headers,
      data: recipe,
    });
    expect(preview.status()).toBe(200);
    const body = await preview.json();
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0]).toMatchObject({
      region: "DE",
      connection: { port: 3080 },
    });
    expect(
      body.stages.find(
        (s: { stepId: string }) => s.stepId === "source-override",
      ).endpoints[0].connection.port,
    ).toBe(2080);
    expect(
      body.stages.find((s: { stepId: string }) => s.stepId === "dedup")
        .removedIds,
    ).toEqual([f.accepted.snapshot.endpoints[1].id]);
    await f.unchanged();
    expect(
      (
        await request.put(`/api/me/collections/${f.id}`, {
          headers: f.headers,
          data: recipe,
        })
      ).status(),
    ).toBe(200);
    await f.unchanged();
    const invalid = {
      ...recipe,
      steps: [
        {
          id: "bad",
          kind: "override",
          enabled: true,
          override: { port: 65536 },
        },
      ],
    };
    expect(
      (
        await request.post("/api/me/collections/preview", {
          headers: f.headers,
          data: invalid,
        })
      ).status(),
    ).toBe(400);
    const stored = await (
      await request.get(`/api/me/collections/${f.id}`)
    ).json();
    expect(stored.steps).toMatchObject(recipe.steps);
    await f.unchanged();
    const reviewed = await request.post(`/api/me/profiles/${f.id}/preview`, {
      headers: f.headers,
      data: { outputId: f.outputs[0].id },
    });
    expect(reviewed.status()).toBe(200);
    const checked = await reviewed.json();
    const publish = await request.post(
      `/api/me/outputs/${f.outputs[0].id}/publish`,
      { headers: f.headers, data: { previewDigest: checked.previewDigest } },
    );
    expect(publish.status(), await publish.text()).toBe(200);
    expect(JSON.parse(await f.feed(0)).proxies).toEqual([
      expect.objectContaining({ server: "proxy.example.test", port: 3080 }),
    ]);
    expect(await f.feed(1)).toBe(f.before[1]);
    expect(await f.readSource()).toEqual(f.sourceBefore);
  } finally {
    await admin.dispose();
  }
});
