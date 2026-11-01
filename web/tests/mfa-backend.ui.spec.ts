import { type Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import {
  demoPassword,
  initialPassword,
  inviteSyntheticAccount,
  requireLoopback,
} from "./account-security-backend";
import { freshTOTP, incorrectTOTP } from "./mfa-backend";

// Browser -> private built UI -> isolated normal Go control plane; never mock auth or persist
// authenticator secrets in screenshots, traces, videos or storage-state files.
test.use({ trace: "off", screenshot: "off", video: "off" });

function response(page: Page, path: string) {
  return page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === path && r.request().method() === "POST",
  );
}
async function submitLogin(
  page: Page,
  username: string,
  password: string,
  status = 200,
  code?: string,
) {
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  if (code !== undefined) {
    const input = page.getByLabel("验证码", { exact: true });
    if (!(await input.isVisible()))
      await page.getByText("使用二次验证码", { exact: true }).click();
    await input.fill(code);
  }
  const pending = response(page, "/api/auth/login");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  expect((await pending).status()).toBe(status);
}

test("synthetic administrator enrolls an authenticator, logs in with TOTP, and recovers through administrator reset", async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  test.setTimeout(120000); // Includes the actual next anti-replay time step.
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  const older = await playwright.request.newContext({ baseURL });
  const unrelated = await playwright.request.newContext({ baseURL });
  const loginContext = await browser.newContext({ baseURL });
  const recoveryContext = await browser.newContext({ baseURL });
  try {
    const account = await inviteSyntheticAccount(admin, older, "admin");
    await inviteSyntheticAccount(admin, unrelated);
    await page.goto("/#account-security");
    await submitLogin(page, account.username, initialPassword);
    await expect(
      page.getByRole("heading", { name: "管理员二次验证", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("验证当前账号密码", { exact: true })
      .fill("synthetic-wrong-password");
    let pending = response(page, "/api/auth/mfa/setup");
    await page
      .getByRole("button", { name: "设置二次验证", exact: true })
      .click();
    expect((await pending).status()).toBe(400);
    await expect(
      page.getByLabel("验证当前账号密码", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("验证当前账号密码", { exact: true })
      .fill(initialPassword);
    pending = response(page, "/api/auth/mfa/setup");
    await page
      .getByRole("button", { name: "设置二次验证", exact: true })
      .click();
    expect((await pending).status()).toBe(200);
    await page.getByText("无法扫码？手动输入密钥", { exact: true }).click();
    const secret = await page
      .getByLabel("验证器设置密钥", { exact: true })
      .inputValue();
    expect(secret.length > 0).toBe(true);
    expect(
      (await (await page.request.get("/api/auth/me")).json()).user.mfaEnabled,
    ).toBe(false);
    const wrong = incorrectTOTP(secret);
    await page.getByLabel("验证器验证码", { exact: true }).fill(wrong);
    pending = response(page, "/api/auth/mfa/enable");
    await page.getByRole("button", { name: "验证并启用", exact: true }).click();
    expect((await pending).status()).toBe(400);
    expect(
      (await page.getByLabel("验证器验证码", { exact: true }).inputValue()) ===
        wrong,
    ).toBe(true);
    expect((await older.get("/api/auth/me")).status()).toBe(200);
    const enrollment = await freshTOTP(secret);
    await page
      .getByLabel("验证器验证码", { exact: true })
      .fill(enrollment.code);
    pending = response(page, "/api/auth/mfa/enable");
    await page.getByRole("button", { name: "验证并启用", exact: true }).click();
    expect((await pending).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "二次验证已启用", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("验证器设置密钥", { exact: true }),
    ).toHaveCount(0);
    expect((await older.get("/api/auth/me")).status()).toBe(401);

    const login = await loginContext.newPage();
    await login.goto("/#account-security");
    await submitLogin(login, account.username, initialPassword, 401);
    await submitLogin(
      login,
      account.username,
      initialPassword,
      401,
      incorrectTOTP(secret),
    );
    await submitLogin(
      login,
      account.username,
      initialPassword,
      401,
      enrollment.code,
    );
    const fresh = await freshTOTP(secret, enrollment.step);
    await submitLogin(
      login,
      account.username,
      initialPassword,
      200,
      fresh.code,
    );
    await expect(
      login.getByRole("heading", { name: "账号安全", exact: true }),
    ).toBeVisible();
    expect((await login.request.get("/api/admin/accounts")).status()).toBe(200);

    const recovery = await recoveryContext.newPage();
    await recovery.goto("/#account-security");
    await submitLogin(recovery, "routeweaver", demoPassword);
    await recovery
      .getByRole("button", { name: `管理 ${account.name}`, exact: true })
      .click();
    const dialog = recovery.getByRole("dialog", {
      name: `管理账号 · ${account.name}`,
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "账号操作", exact: true })
      .click();
    await recovery
      .getByRole("option", { name: "重置二次验证", exact: true })
      .click();
    await dialog
      .getByLabel("操作原因", { exact: true })
      .fill("Synthetic lost-authenticator recovery");
    await dialog
      .getByLabel("管理员当前密码", { exact: true })
      .fill("synthetic-wrong-password");
    const path = `/api/admin/accounts/${account.id}/security`;
    pending = response(recovery, path);
    await dialog
      .getByRole("button", { name: "重置二次验证", exact: true })
      .click();
    expect((await pending).status()).toBe(403);
    await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue(
      "Synthetic lost-authenticator recovery",
    );
    expect((await login.request.get("/api/auth/me")).status()).toBe(200);
    await dialog
      .getByLabel("管理员当前密码", { exact: true })
      .fill(demoPassword);
    pending = response(recovery, path);
    await dialog
      .getByRole("button", { name: "重置二次验证", exact: true })
      .click();
    expect((await pending).status()).toBe(200);
    await expect(dialog).toBeHidden();
    expect((await login.request.get("/api/auth/me")).status()).toBe(401);
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
    await login.reload();
    await submitLogin(login, account.username, initialPassword);
    await expect(
      login.getByRole("button", { name: "设置二次验证", exact: true }),
    ).toBeVisible();
    expect((await login.request.get("/api/admin/accounts")).status()).toBe(200);
    expect((await unrelated.get("/api/me/profiles")).status()).toBe(200);
    expect((await recovery.request.get("/api/admin/accounts")).status()).toBe(
      200,
    );
  } finally {
    await loginContext.close();
    await recoveryContext.close();
    await Promise.all(
      [admin, older, unrelated].map((context) => context.dispose()),
    );
  }
});
