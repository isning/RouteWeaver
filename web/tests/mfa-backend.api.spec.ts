import { expect, test } from "./isolated-control-plane-fixture";
import {
  demoPassword,
  initialPassword,
  changedPassword,
  inviteSyntheticAccount,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";
import { freshTOTP, incorrectTOTP, totp } from "./mfa-backend";

test("TOTP helper agrees with the RFC 6238 SHA-1 test vector", () => {
  expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
});

test("real administrator MFA enrollment, single-use login and scoped recovery", async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(90000); // Includes a real 30-second anti-replay time step.
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  const actor = await playwright.request.newContext({ baseURL });
  const older = await playwright.request.newContext({ baseURL });
  const login = await playwright.request.newContext({ baseURL });
  const unrelated = await playwright.request.newContext({ baseURL });
  try {
    const account = await inviteSyntheticAccount(admin, actor, "admin");
    await inviteSyntheticAccount(admin, unrelated);
    await signInAPI(older, account.username, initialPassword);
    const ordinary = await (await unrelated.get("/api/auth/me")).json();
    for (const endpoint of ["setup", "enable"]) {
      expect(
        (
          await unrelated.post(`/api/auth/mfa/${endpoint}`, {
            headers: { "X-CSRF-Token": ordinary.csrfToken },
            data:
              endpoint === "setup"
                ? { password: initialPassword }
                : { code: "000000" },
          })
        ).status(),
      ).toBe(403);
    }
    const before = await (await actor.get("/api/auth/me")).json();
    const headers = { "X-CSRF-Token": before.csrfToken };
    expect(
      (
        await actor.post("/api/auth/mfa/setup", {
          data: { password: initialPassword },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await actor.post("/api/auth/mfa/setup", {
          headers,
          data: { password: "synthetic-wrong-password" },
        })
      ).status(),
    ).toBe(400);
    const setup = await actor.post("/api/auth/mfa/setup", {
      headers,
      data: { password: initialPassword },
    });
    expect(setup.status()).toBe(200);
    const { secret } = await setup.json();
    expect(
      (await (await actor.get("/api/auth/me")).json()).user.mfaEnabled,
    ).toBe(false);
    expect(
      (
        await actor.post("/api/auth/mfa/enable", {
          headers,
          data: { code: incorrectTOTP(secret) },
        })
      ).status(),
    ).toBe(400);
    expect((await older.get("/api/auth/me")).status()).toBe(200);
    expect(
      (await (await actor.get("/api/auth/me")).json()).user.mfaEnabled,
    ).toBe(false);
    const enrollment = await freshTOTP(secret);
    const enabled = await actor.post("/api/auth/mfa/enable", {
      headers,
      data: { code: enrollment.code },
    });
    expect(enabled.status()).toBe(200);
    const next = await enabled.json();
    expect(next.user.mfaEnabled).toBe(true);
    expect(next.csrfToken !== before.csrfToken).toBe(true);
    expect((await older.get("/api/auth/me")).status()).toBe(401);
    expect(
      (
        await actor.post("/api/auth/sessions/revoke-others", {
          headers,
          data: { currentPassword: initialPassword },
        })
      ).status(),
    ).toBe(403);
    const attempt = (totp?: string) =>
      login.post("/api/auth/login", {
        data: { username: account.username, password: initialPassword, totp },
      });
    for (const code of [undefined, incorrectTOTP(secret), enrollment.code]) {
      expect((await attempt(code)).status()).toBe(401);
      expect((await login.get("/api/auth/me")).status()).toBe(401);
    }
    const fresh = await freshTOTP(secret, enrollment.step);
    expect((await attempt(fresh.code)).status()).toBe(200);
    expect((await login.get("/api/admin/accounts")).status()).toBe(200);
    expect((await attempt(fresh.code)).status()).toBe(401);
    // Password alone cannot authorize a sensitive mutation after enrollment.
    expect(
      (
        await actor.post("/api/auth/password", {
          headers: { "X-CSRF-Token": next.csrfToken },
          data: {
            currentPassword: initialPassword,
            newPassword: changedPassword,
          },
        })
      ).status(),
    ).toBe(403);
    const administrator = await (await admin.get("/api/auth/me")).json();
    const reset = (password: string, target = account.id) =>
      admin.post(`/api/admin/accounts/${target}/security`, {
        headers: { "X-CSRF-Token": administrator.csrfToken },
        data: {
          action: "reset-mfa",
          reason: "Synthetic lost-authenticator recovery",
          currentPassword: password,
        },
      });
    expect((await reset("synthetic-wrong-password")).status()).toBe(403);
    expect((await actor.get("/api/auth/me")).status()).toBe(200);
    expect((await reset(demoPassword, administrator.user.id)).status()).toBe(
      409,
    );
    const recovered = await reset(demoPassword);
    expect(recovered.status()).toBe(200);
    expect((await recovered.json()).mfaEnabled).toBe(false);
    expect((await actor.get("/api/auth/me")).status()).toBe(401);
    expect((await login.get("/api/auth/me")).status()).toBe(401);
    const restored = await signInAPI(login, account.username, initialPassword);
    expect(restored.user.mfaEnabled).toBe(false);
    expect((await login.get("/api/admin/accounts")).status()).toBe(200);
    expect((await unrelated.get("/api/me/profiles")).status()).toBe(200);
    expect((await admin.get("/api/admin/accounts")).status()).toBe(200);
  } finally {
    await Promise.all(
      [admin, actor, older, login, unrelated].map((context) =>
        context.dispose(),
      ),
    );
  }
});
