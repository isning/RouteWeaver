import { expect, test, type Page } from "@playwright/test";

// Production UI, read-only synthetic API seam. No real account changes.
async function fixture(page: Page, role: "user" | "admin", required = false) {
  const unexpected: string[] = [];
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Account security review requires loopback");
  const origin = new URL(baseURL).origin;
  const responses: Record<string, unknown> = {
    "/api/auth/me": {
      user: {
        id: "viewer",
        name: "审查账号",
        role,
        mfaEnabled: true,
        passwordChangeRequired: required,
      },
      csrfToken: "synthetic",
    },
    "/api/auth/sessions": [
      {
        id: "opaque-current",
        current: true,
        expiresAt: "2027-01-01T00:00:00Z",
      },
      { id: "opaque-other", current: false, expiresAt: "2027-01-02T00:00:00Z" },
    ],
    "/api/admin/accounts": [
      {
        id: "target",
        name: "需要恢复访问的测试账号",
        username: "synthetic-target",
        role: "user",
        disabled: false,
        retired: false,
        mfaEnabled: true,
      },
    ],
  };
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push("external");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET" || !(url.pathname in responses)) {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({
        status: 503,
        json: { detail: "Unexpected controlled security request" },
      });
    }
    return route.fulfill({ json: responses[url.pathname] });
  });
  return unexpected;
}
for (const size of [
  { width: 320, height: 360 },
  { width: 390, height: 844 },
  { width: 640, height: 400 },
  { width: 1440, height: 1000 },
]) {
  test(`account security and recovery remain keyboard reachable at ${size.width}x${size.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    const unexpected = await fixture(page, "admin");
    await page.goto("/#account-security");
    await expect(
      page.getByRole("heading", { name: "账号安全", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "修改密码", exact: true }),
    ).toBeVisible();
    const manage = page.getByRole("button", {
      name: "管理 需要恢复访问的测试账号",
      exact: true,
    });
    await manage.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "管理账号 · 需要恢复访问的测试账号",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("登录名：synthetic-target")).toBeVisible();
    const password = dialog.getByLabel("管理员当前密码", { exact: true });
    await password.focus();
    await expect(password).toBeInViewport();
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    await cancel.focus();
    await expect(cancel).toBeInViewport();
    await expect(dialog.getByText(/立即阻止登录和订阅链接交付/)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(
        `account-security-${size.width}x${size.height}.png`,
      ),
    });
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(manage).toBeFocused();
    expect(unexpected).toEqual([]);
  });
}
test("required password change does not load ordinary workspace or administrator recovery", async ({
  page,
}) => {
  const unexpected = await fixture(page, "user", true);
  await page.goto("/#subscriptions");
  await expect(
    page.getByRole("heading", { name: "账号安全", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("请先更换临时密码", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "修改密码", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "账号恢复与退役", exact: true }),
  ).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
