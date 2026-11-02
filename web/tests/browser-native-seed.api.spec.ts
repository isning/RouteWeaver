import { test, expect } from "./isolated-control-plane-fixture";
import { seedNativePublication } from "./browser-native-fixture";

// Fixture/publication contract only. No browser, native process or observation.
test("native browser fixture produces a real queued managed publication", async ({
  playwright,
  baseURL,
}) => {
  const admin = await playwright.request.newContext({ baseURL }),
    owner = await playwright.request.newContext({ baseURL });
  try {
    const { draft, instance, call } = await seedNativePublication(admin, owner);
    const opened = await (
      await admin.get(`/api/server-deployments/${draft.id}`)
    ).json();
    const session = await (await admin.get("/api/auth/me")).json();
    const checked = await admin.post(
      `/api/server-deployments/${draft.id}/validate`,
      {
        headers: {
          "X-CSRF-Token": session.csrfToken,
          "If-Match": opened.revisionToken,
        },
        data: {},
      },
    );
    expect(checked.status()).toBe(200);
    const validation = await checked.json();
    expect(validation.valid).toBe(true);
    const receipt = await call(`server-deployments/${draft.id}/publish`, {
      operationId: "seed-publication",
      leaseSeconds: 300,
      accessAllowed: true,
      quotaCertain: true,
      expectedFingerprint: validation.fingerprint,
    });
    const state = await (
      await admin.get(`/api/agent/instances/${instance.id}/state`)
    ).json();
    expect(state.phase).toBe("queued");
    expect(state.state).toBeUndefined();
    expect(receipt.instances[0]).toMatchObject({
      instanceId: instance.id,
      generation: state.desired.generation,
      operationId: state.desired.operationId,
      revisionId: state.desired.revisionId,
    });
  } finally {
    await admin.dispose();
    await owner.dispose();
  }
});
