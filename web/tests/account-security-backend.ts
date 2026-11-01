import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

// Only synthetic identities in a fresh isolated normal control plane.
// No database access, bearer-token shortcut, persisted storageState or API mocks.
export const demoPassword = "local-demo-password";
export const initialPassword = "synthetic-security-initial-password";
export const changedPassword = "synthetic-security-changed-password";
export const temporaryPassword = "synthetic-security-temporary-password";

export function requireLoopback(baseURL: string | undefined) {
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error(
      "Account security journeys require an isolated loopback server",
    );
}

export async function signInAPI(
  client: APIRequestContext,
  username: string,
  password: string,
) {
  const response = await client.post("/api/auth/login", {
    data: { username, password },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

export async function inviteSyntheticAccount(
  admin: APIRequestContext,
  recipient: APIRequestContext,
  role: "user" | "admin" = "user",
) {
  const session = await signInAPI(admin, "routeweaver", demoPassword);
  const username = `security-${randomUUID()}`;
  const name = `Synthetic security ${username}`;
  const invite = await admin.post("/api/invites", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: { name, role, expiresInHours: 1 },
  });
  expect(invite.status()).toBe(201);
  const accepted = await recipient.post("/api/auth/accept-invite", {
    data: {
      token: (await invite.json()).token,
      username,
      password: initialPassword,
    },
  });
  expect(accepted.ok()).toBe(true);
  const identity = await accepted.json();
  return { username, name, id: identity.user.id as string };
}
