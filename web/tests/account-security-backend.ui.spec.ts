import { type Page } from "@playwright/test";
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

// Real browser -> private built UI -> isolated normal Go control plane. Do not replace requests
// with fulfilled fixtures. Auth journeys intentionally never use ui-session.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/#account-security");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/auth/login" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "账号安全", exact: true }),
  ).toBeVisible();
}

async function fillPassword(page: Page, current: string, next: string) {
  await page.getByLabel("当前密码", { exact: true }).fill(current);
  await page.getByLabel("新密码", { exact: true }).fill(next);
  await page.getByLabel("确认新密码", { exact: true }).fill(next);
}

async function submitPassword(page: Page, status: number) {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/auth/password" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(status);
  return result;
}

async function sessionCookie(page: Page) {
  const cookies = (await page.context().cookies()).filter(
    (c) => c.name === "routeweaver_session",
  );
  expect(cookies.length).toBe(1);
  expect(cookies[0].httpOnly).toBe(true);
  expect(cookies[0].sameSite).toBe("Strict");
  expect(cookies[0].path).toBe("/");
  return cookies[0].value;
}

test("real password change preserves failed reauthentication draft, rotates credentials and invalidates older sessions", async ({
  page,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  const older = await playwright.request.newContext({ baseURL });
  const fresh = await playwright.request.newContext({ baseURL });
  let stale;
  try {
    const account = await inviteSyntheticAccount(admin, older);
    await signIn(page, account.username, initialPassword);
    const before = await (await page.request.get("/api/auth/me")).json();
    const cookieBefore = await sessionCookie(page);
    // A separate client retains the exact pre-change browser cookie in memory.
    stale = await playwright.request.newContext({
      baseURL,
      storageState: await page.context().storageState(),
    });
    expect((await older.get("/api/auth/me")).status()).toBe(200);

    await fillPassword(page, "synthetic-wrong-password", changedPassword);
    await submitPassword(page, 403);
    await expect(
      page.getByText("当前密码或验证码不正确，请核对后重试。", { exact: true }),
    ).toBeVisible();
    expect(
      (await page.getByLabel("新密码", { exact: true }).inputValue()) ===
        changedPassword,
    ).toBe(true);
    expect(
      (await page.getByLabel("确认新密码", { exact: true }).inputValue()) ===
        changedPassword,
    ).toBe(true);
    expect((await sessionCookie(page)) === cookieBefore).toBe(true);
    expect((await older.get("/api/auth/me")).status()).toBe(200);

    await page.getByLabel("当前密码", { exact: true }).fill(initialPassword);
    const changed = await (await submitPassword(page, 200)).json();
    expect(
      typeof changed.csrfToken === "string" &&
        changed.csrfToken.length > 0 &&
        changed.csrfToken !== before.csrfToken,
    ).toBe(true);
    expect((await sessionCookie(page)) !== cookieBefore).toBe(true);
    await expect(page.getByLabel("新密码", { exact: true })).toHaveValue("");
    expect((await older.get("/api/auth/me")).status()).toBe(401);
    expect((await stale.get("/api/auth/me")).status()).toBe(401);
    expect(
      (
        await page.request.post("/api/auth/sessions/revoke-others", {
          headers: { "X-CSRF-Token": before.csrfToken },
          data: { currentPassword: changedPassword },
        })
      ).status(),
    ).toBe(403);

    // This UI mutation, without reload, proves the owner adopted rotated CSRF.
    await page
      .getByLabel("验证当前密码", { exact: true })
      .fill(changedPassword);
    const revoke = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/auth/sessions/revoke-others" &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "退出其他所有会话", exact: true })
      .click();
    expect((await revoke).status()).toBe(200);
    expect((await page.request.get("/api/me/profiles")).status()).toBe(200);
    const sessions = await (
      await page.request.get("/api/auth/sessions")
    ).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
    expect(
      (
        await fresh.post("/api/auth/login", {
          data: { username: account.username, password: initialPassword },
        })
      ).status(),
    ).toBe(401);
    await signInAPI(fresh, account.username, changedPassword);
    expect((await fresh.get("/api/me/profiles")).status()).toBe(200);
    expect((await admin.get("/api/auth/me")).status()).toBe(200);
  } finally {
    await stale?.dispose();
    await fresh.dispose();
    await older.dispose();
    await admin.dispose();
  }
});

test("administrator resets a synthetic account through the UI and temporary login cannot bypass required password change", async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  const target = await playwright.request.newContext({ baseURL });
  const recoveredContext = await browser.newContext({ baseURL });
  try {
    const account = await inviteSyntheticAccount(admin, target);
    await signIn(page, "routeweaver", demoPassword);
    await page
      .getByRole("button", { name: `管理 ${account.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `管理 ${account.name} 的账号`,
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "账号操作", exact: true })
      .click();
    await page
      .getByRole("option", { name: "重置账号密码", exact: true })
      .click();
    await dialog
      .getByLabel("临时密码", { exact: true })
      .fill(temporaryPassword);
    await dialog
      .getByLabel("操作原因", { exact: true })
      .fill("Synthetic account recovery journey");
    await dialog
      .getByLabel("管理员当前密码", { exact: true })
      .fill("synthetic-wrong-password");
    const recoveryResponse = () =>
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            `/api/admin/accounts/${account.id}/security` &&
          r.request().method() === "POST",
      );
    let response = recoveryResponse();
    await dialog
      .getByRole("button", { name: "重置账号密码", exact: true })
      .click();
    expect((await response).status()).toBe(403);
    await expect(
      dialog.getByText("当前密码或验证码不正确，请核对后重试。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await dialog.getByLabel("临时密码", { exact: true }).inputValue()) ===
        temporaryPassword,
    ).toBe(true);
    await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue(
      "Synthetic account recovery journey",
    );
    expect((await target.get("/api/me/profiles")).status()).toBe(200);
    await dialog
      .getByLabel("管理员当前密码", { exact: true })
      .fill(demoPassword);
    response = recoveryResponse();
    await dialog
      .getByRole("button", { name: "重置账号密码", exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await expect(dialog).toBeHidden();
    expect((await target.get("/api/auth/me")).status()).toBe(401);

    const recovered = await recoveredContext.newPage();
    await signIn(recovered, account.username, temporaryPassword);
    await expect(
      recovered.getByText("请先更换临时密码", { exact: true }),
    ).toBeVisible();
    expect((await recovered.request.get("/api/me/profiles")).status()).toBe(
      403,
    );
    // A direct ordinary-workspace URL is not an escape from the required gate.
    await recovered.goto("/#subscriptions");
    await expect(
      recovered.getByRole("heading", { name: "账号安全", exact: true }),
    ).toBeVisible();
    await expect(
      recovered.getByRole("heading", { name: "我的订阅", exact: true }),
    ).toHaveCount(0);
    await expect(
      recovered.getByRole("heading", { name: "账号恢复与退役", exact: true }),
    ).toHaveCount(0);
    await fillPassword(recovered, temporaryPassword, changedPassword);
    const changed = await (await submitPassword(recovered, 200)).json();
    expect(changed.user.passwordChangeRequired === true).toBe(false);
    await expect(
      recovered.getByText("请先更换临时密码", { exact: true }),
    ).toBeHidden();
    await recovered.goto("/#subscriptions");
    await expect(
      recovered.getByRole("heading", { name: "我的订阅", exact: true }),
    ).toBeVisible();
    expect((await recovered.request.get("/api/me/profiles")).status()).toBe(
      200,
    );
    expect((await page.request.get("/api/admin/accounts")).status()).toBe(200);
  } finally {
    await recoveredContext.close();
    await target.dispose();
    await admin.dispose();
  }
});
