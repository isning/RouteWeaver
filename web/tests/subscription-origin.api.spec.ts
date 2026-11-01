import { expect, test } from "@playwright/test";
test("subscription origin saves only a draft, rejects invalid and stale writes, and explicitly restores the default without a network probe", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const headers = { "X-CSRF-Token": (await login.json()).csrfToken },
    base = "/api/admin/subscription-origin";
  const initial = await (await request.get(base)).json();
  const stage = await request.put(base, {
    headers,
    data: {
      origin: "https://subscription.example.com",
      expectedRevision: initial.revision,
    },
  });
  expect(stage.ok(), await stage.text()).toBeTruthy();
  const draft = await stage.json();
  expect(draft.effectiveOrigin).toBe(initial.effectiveOrigin);
  expect(draft.verificationStatus).toBe("unverified");
  expect(draft.tokensUnchanged).toBe(true);
  const unverified = await request.post(`${base}/activate`, {
    headers,
    data: { expectedRevision: draft.revision },
  });
  expect(unverified.status()).toBe(409);
  const invalid = await request.put(base, {
    headers,
    data: { origin: "https://127.0.0.1", expectedRevision: draft.revision },
  });
  expect(invalid.status()).toBe(400);
  expect((await (await request.get(base)).json()).draftOrigin).toBe(
    draft.draftOrigin,
  );
  const stale = await request.put(base, {
    headers,
    data: { origin: "", expectedRevision: initial.revision },
  });
  expect(stale.status()).toBe(409);
  const restore = await request.put(base, {
    headers,
    data: { origin: "", expectedRevision: draft.revision },
  });
  expect(restore.ok()).toBeTruthy();
  const reset = await restore.json();
  expect(reset.verificationStatus).toBe("not-required");
  const activated = await request.post(`${base}/activate`, {
    headers,
    data: { expectedRevision: reset.revision },
  });
  expect(activated.ok()).toBeTruthy();
  const active = await activated.json();
  expect(active.effectiveOrigin).toBe("");
  expect(active.effectiveRevision).toBe(active.configuredRevision);
  expect(active.tokensUnchanged).toBe(true);
});
