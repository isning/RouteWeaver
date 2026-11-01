import { expect, test } from "./isolated-control-plane-fixture";
import {
  changedPassword,
  demoPassword,
  initialPassword,
  temporaryPassword,
  inviteSyntheticAccount,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";

// Browser-free companion: verifies real setup and HTTP contracts, never claims
// browser interaction, cookie application by Chromium, or visual evidence.
test("synthetic account password rotation and administrator recovery enforce the real HTTP lifecycle", async ({
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  const actor = await playwright.request.newContext({ baseURL });
  const older = await playwright.request.newContext({ baseURL });
  const unrelated = await playwright.request.newContext({ baseURL });
  try {
    const account = await inviteSyntheticAccount(admin, actor);
    const otherAccount = await inviteSyntheticAccount(admin, unrelated);
    await signInAPI(older, account.username, initialPassword);
    const before = await (await actor.get("/api/auth/me")).json();
    const beforeCookies = (await actor.storageState()).cookies;
    const headers = { "X-CSRF-Token": before.csrfToken };
    const denied = await actor.post(
      `/api/admin/accounts/${otherAccount.id}/security`,
      {
        headers,
        data: {
          action: "reset-password",
          reason: "Synthetic forbidden cross-account reset",
          currentPassword: initialPassword,
          newPassword: temporaryPassword,
        },
      },
    );
    expect(denied.status()).toBe(403);
    expect((await unrelated.get("/api/me/profiles")).status()).toBe(200);
    const change = (
      currentPassword: string,
      newPassword: string,
      csrf = before.csrfToken,
    ) =>
      actor.post("/api/auth/password", {
        headers: { "X-CSRF-Token": csrf },
        data: { currentPassword, newPassword },
      });
    expect(
      (await change("synthetic-wrong-password", changedPassword)).status(),
    ).toBe(403);
    expect((await actor.get("/api/auth/me")).status()).toBe(200);
    expect((await older.get("/api/auth/me")).status()).toBe(200);
    const changed = await change(initialPassword, changedPassword);
    expect(changed.status()).toBe(200);
    const next = await changed.json();
    expect(
      typeof next.csrfToken === "string" &&
        next.csrfToken.length > 0 &&
        next.csrfToken !== before.csrfToken,
    ).toBe(true);
    const afterCookies = (await actor.storageState()).cookies;
    expect(
      afterCookies.find((c) => c.name === "routeweaver_session")?.value !==
        beforeCookies.find((c) => c.name === "routeweaver_session")?.value,
    ).toBe(true);
    expect((await older.get("/api/auth/me")).status()).toBe(401);
    expect(
      (
        await actor.post("/api/auth/sessions/revoke-others", {
          headers,
          data: { currentPassword: changedPassword },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await actor.post("/api/auth/sessions/revoke-others", {
          headers: { "X-CSRF-Token": next.csrfToken },
          data: { currentPassword: changedPassword },
        })
      ).status(),
    ).toBe(200);
    await signInAPI(older, account.username, changedPassword);
    const adminSession = await (await admin.get("/api/auth/me")).json();
    const reset = await admin.post(
      `/api/admin/accounts/${account.id}/security`,
      {
        headers: { "X-CSRF-Token": adminSession.csrfToken },
        data: {
          action: "reset-password",
          reason: "Synthetic account recovery journey",
          currentPassword: demoPassword,
          newPassword: temporaryPassword,
        },
      },
    );
    expect(reset.status()).toBe(200);
    expect((await actor.get("/api/auth/me")).status()).toBe(401);
    expect((await older.get("/api/auth/me")).status()).toBe(401);
    const restricted = await signInAPI(
      actor,
      account.username,
      temporaryPassword,
    );
    expect(restricted.user.passwordChangeRequired).toBe(true);
    expect((await actor.get("/api/me/profiles")).status()).toBe(403);
    const restored = await change(
      temporaryPassword,
      initialPassword,
      restricted.csrfToken,
    );
    expect(restored.status()).toBe(200);
    expect((await restored.json()).user.passwordChangeRequired === true).toBe(
      false,
    );
    expect((await actor.get("/api/me/profiles")).status()).toBe(200);
    expect((await admin.get("/api/admin/accounts")).status()).toBe(200);
    expect((await unrelated.get("/api/me/profiles")).status()).toBe(200);
  } finally {
    await unrelated.dispose();
    await older.dispose();
    await actor.dispose();
    await admin.dispose();
  }
});
