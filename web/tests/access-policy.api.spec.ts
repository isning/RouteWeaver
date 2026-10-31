import { expect, test } from "@playwright/test";
test("policy group preview applies exact limits, rejects stale reviews and prevents ambiguous group stacking", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
      data: { username: "routeweaver", password: "local-demo-password" },
    }),
    headers = { "X-CSRF-Token": (await login.json()).csrfToken },
    id = Date.now().toString(36),
    base = "/api/access-policy";
  const user = {
    id: `policy-user-${id}`,
    name: "Policy user",
    enabled: true,
    quotaBytes: 1000,
    usedBytes: 0,
  };
  expect(
    (await request.post("/api/users", { headers, data: user })).ok(),
  ).toBeTruthy();
  const service = {
    id: `policy-plan-${id}`,
    name: "Group plan",
    quotaBytes: 2000,
    routeIds: [],
    cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
    onlineIpLimit: 2,
    connectionLimit: 8,
    entryRateBps: 1024,
  };
  const preview = async (change: unknown) => {
    const result = await request.post(`${base}/preview`, {
      headers,
      data: change,
    });
    expect(result.ok(), await result.text()).toBeTruthy();
    return result.json();
  };
  const apply = async (change: unknown, revision: string) =>
    request.post(`${base}/apply`, { headers, data: { change, revision } });
  let review = await preview({ service });
  expect((await apply({ service }, review.revision)).ok()).toBeTruthy();
  const group = {
    id: `policy-group-${id}`,
    name: "Members",
    serviceId: service.id,
    priority: 10,
    memberIds: [user.id],
  };
  review = await preview({ group });
  expect(
    review.affected.find((a: any) => a.userId === user.id).after,
  ).toMatchObject({
    quotaBytes: 2000,
    connectionLimit: 8,
    onlineIpLimit: 2,
    entryRateBps: 1024,
    provenance: { service: "group" },
  });
  expect((await apply({ group }, review.revision)).ok()).toBeTruthy();
  const effective = await (
    await request.get(`/api/users/${user.id}/effective-policy`)
  ).json();
  expect(effective.quotaBytes).toBe(2000);
  const override = {
    ...effective.entitlement,
    quotaOverride: 0,
    routeIdsOverride: [],
    connectionLimitOverride: 3,
  };
  const personal = await preview({ entitlement: override });
  const other = {
    ...service,
    id: `other-plan-${id}`,
    name: "Other",
    quotaBytes: 9000,
  };
  const otherReview = await preview({ service: other });
  expect(
    (await apply({ service: other }, otherReview.revision)).ok(),
  ).toBeTruthy();
  expect(
    (await apply({ entitlement: override }, personal.revision)).status(),
  ).toBe(409);
  const fresh = await preview({ entitlement: override });
  expect(
    (await apply({ entitlement: override }, fresh.revision)).ok(),
  ).toBeTruthy();
  const saved = await (
    await request.get(`/api/users/${user.id}/effective-policy`)
  ).json();
  expect(saved).toMatchObject({
    quotaBytes: 0,
    connectionLimit: 3,
    routeIds: [],
    provenance: {
      quotaBytes: "individual",
      connectionLimit: "individual",
      routes: "individual",
    },
  });
  const conflict = { ...group, id: `conflict-${id}`, serviceId: other.id };
  const blocked = await preview({ group: conflict });
  expect(blocked.blockers.length).toBeGreaterThan(0);
  expect((await apply({ group: conflict }, blocked.revision)).ok()).toBe(false);
  const all = await (await request.get("/api/user-groups")).json();
  expect(all.some((g: any) => g.id === conflict.id)).toBe(false);
  const swap = { ...group, priority: 99 };
  expect((await apply({ group: swap }, review.revision)).status()).toBe(409);
});
test("ordinary users cannot read or mutate administrative policy, subscription domains or diagnostic paths", async ({
  request,
  playwright,
  baseURL,
}) => {
  const login = await request.post("/api/auth/login", {
      data: { username: "routeweaver", password: "local-demo-password" },
    }),
    headers = { "X-CSRF-Token": (await login.json()).csrfToken };
  const invited = await request.post("/api/invites", {
    headers,
    data: { name: "Ordinary policy test", role: "user", expiresInHours: 1 },
  });
  expect(invited.status()).toBe(201);
  const regular = await playwright.request.newContext({
    baseURL,
  });
  try {
    const accepted = await regular.post("/api/auth/accept-invite", {
      data: {
        token: (await invited.json()).token,
        username: `policy-regular-${Date.now().toString(36)}`,
        password: "synthetic-policy-test-password",
      },
    });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    const identity = await accepted.json(),
      csrf = { "X-CSRF-Token": identity.csrfToken };
    for (const path of [
      "/api/user-groups",
      "/api/users/unknown/effective-policy",
      "/api/admin/subscription-origin",
      "/api/admin/diagnostic-paths",
    ]) {
      expect((await regular.get(path)).status()).toBe(403);
    }
    expect(
      (
        await regular.post("/api/access-policy/preview", {
          headers: csrf,
          data: {
            group: {
              id: "forbidden",
              name: "Forbidden",
              serviceId: "none",
              priority: 1,
              memberIds: [],
            },
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await regular.put("/api/admin/subscription-origin", {
          headers: csrf,
          data: { origin: "", expectedRevision: 0 },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await regular.dispose();
  }
});
