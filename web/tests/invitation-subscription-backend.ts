import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { requireLoopback } from "./account-security-backend";

export const invitationServiceName = "受邀体验服务";
export const invitationRouteName = "受邀体验线路";
export const invitationEntryName = "受邀专用连接";
export const invitationPassword = "synthetic-invitation-password";

export async function readOnboarding(client: APIRequestContext, path: string) {
  const response = await client.get(`/api${path}`);
  expect(response.status(), `Read ${path}`).toBe(200);
  return response.json();
}

// Only source infrastructure is provisioned here. Invitations, account creation,
// service grant, Profile and Output must all come from the browser journey.
export async function invitationSourceFixture(admin: APIRequestContext) {
  const id = `invite-${randomUUID()}`;
  const headers = {
    "X-CSRF-Token": (await readOnboarding(admin, "/auth/me")).csrfToken,
  };
  const connection = {
    protocol: "socks",
    host: "127.0.0.1",
    port: 1080,
    username: "synthetic-invitation-user",
    password: "synthetic-entry-password",
  };
  for (const [path, data] of [
    ["nodes", { id, name: "受邀连接源", ...connection, status: "unknown" }],
    [
      "routes",
      {
        id,
        name: invitationRouteName,
        engine: "xray",
        hops: [id],
        userIds: [],
      },
    ],
    [
      "services",
      {
        id,
        name: invitationServiceName,
        quotaBytes: 0,
        routeIds: [id],
        cycle: { mode: "none", timezone: "UTC+8" },
      },
    ],
  ] as const) {
    expect((await admin.post(`/api/${path}`, { headers, data })).status()).toBe(
      200,
    );
  }
  return {
    id,
    // There is no supported UI for explicit legacy platform-entry assignment.
    // This is not a managed-node observation, application, or traffic proof.
    async assignLegacyEntryAfterGrant(userId: string) {
      const response = await admin.post(`/api/users/${userId}/entries`, {
        headers,
        data: {
          id: "invited-entry",
          name: invitationEntryName,
          routeId: id,
          credentialVersion: "v1",
          connection: { ...connection, username: userId },
        },
      });
      expect(response.status()).toBe(201);
    },
  };
}

// Keep bearer URLs outside Playwright's request instrumentation and error text.
export async function readInvitationFeed(baseURL: string, value: string) {
  requireLoopback(baseURL);
  const target = new URL(value, baseURL);
  expect(
    target.origin === new URL(baseURL).origin,
    "Feed stays on isolated origin",
  ).toBe(true);
  let response: Response;
  try {
    response = await fetch(target, { redirect: "manual" });
  } catch {
    throw new Error("Isolated subscription download failed");
  }
  expect(response.status, "Isolated subscription response status").toBe(200);
  return Buffer.from(await response.arrayBuffer());
}
