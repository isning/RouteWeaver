import { expect, test, type Locator, type Page } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Match the inventory's public keyboard/geometry checks without coupling this
// controlled read-only fixture to its real-backend setup.
async function visibleClip(target: Locator) {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let left = 0,
      top = 0,
      right = innerWidth,
      bottom = innerHeight;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + node.clientLeft);
        right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + node.clientTop);
        bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    return {
      bounds: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      clip: { left, top, right, bottom },
      fullyVisible:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= left - 1 &&
        rect.right <= right + 1 &&
        rect.top >= top - 1 &&
        rect.bottom <= bottom + 1,
    };
  });
}

async function inView(target: Locator) {
  await expect(target).toBeVisible();
  await expect
    .poll(async () => (await visibleClip(target)).fullyVisible, {
      message:
        "The complete identity, field, consequence or action fits inside its visible clip",
    })
    .toBe(true);
}

async function tabTo(page: Page, target: Locator, dialog?: Locator) {
  await expect(target).toBeVisible();
  const scope = dialog ?? page.locator("body");
  const stops = await scope
    .locator("a[href],button,input,select,textarea,[tabindex]")
    .count();
  for (let step = 0; step <= stops; step++) {
    if (await target.evaluate((element) => element === document.activeElement))
      break;
    if (dialog)
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
        "Tab stays inside the account recovery task",
      ).toBe(true);
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  if (dialog) await settledTask(dialog);
  await inView(target);
}

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
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await tabTo(page, manage);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "管理 需要恢复访问的测试账号 的账号",
      exact: true,
    });
    await settledTask(dialog);
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      "Opening recovery enters the task's focus scope",
    ).toBe(true);
    const identity = dialog.getByRole("heading", {
      name: "管理 需要恢复访问的测试账号 的账号",
      exact: true,
    });
    const username = dialog.getByText("登录名：synthetic-target", {
      exact: true,
    });
    const action = dialog.getByRole("combobox", {
      name: "账号操作",
      exact: true,
    });
    const password = dialog.getByLabel("管理员当前密码", { exact: true });
    const totp = dialog.getByLabel("管理员验证器验证码", { exact: true });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const disable = dialog.getByRole("button", {
      name: "停用账号",
      exact: true,
    });
    const consequence = dialog.getByText(
      "立即阻止登录和订阅链接交付，并退出目标账号的所有登录会话。托管入口将拒绝新连接与续期，已有连接可能在续期被拒绝或租约到期时结束。保留数据和服务授权配置；非托管节点上的已下载凭据仍需另行撤销。",
      { exact: true },
    );
    const capture = async (phase: string, scope: string) => {
      await settledTask(dialog);
      const filename = `account-security-${size.width}x${size.height}-${phase}.png`;
      const path = info.outputPath(filename);
      await page.screenshot({ path });
      await info.attach(phase, { path, contentType: "image/png" });
      await info.attach(`${phase}-context`, {
        contentType: "application/json",
        body: JSON.stringify(
          {
            viewport: size,
            scope,
            fixture:
              "Production UI with read-only synthetic API responses; no live account changes",
            scrollMode: await dialog.getAttribute("data-task-scroll"),
            identity: await visibleClip(identity),
            username: await visibleClip(username),
            consequence: await visibleClip(consequence),
            action: await visibleClip(disable),
            actionFocused: await disable.evaluate(
              (element) => element === document.activeElement,
            ),
          },
          null,
          2,
        ),
      });
    };

    await inView(identity);
    await inView(username);
    if (size.height <= 400)
      await expect(dialog).toHaveAttribute("data-task-scroll", "task");
    await capture(
      "initial-identity",
      "Initial target name and login, before traversing recovery controls; not a final-decision capture",
    );

    await tabTo(page, action, dialog);
    await expect(action).toHaveText("停用账号");
    await tabTo(page, password, dialog);
    await expect(password).toHaveValue("");
    await expect(password).toHaveAttribute("type", "password");
    await inView(dialog.getByText("管理员当前密码", { exact: true }));
    await capture(
      "password",
      "Native Tab reached the blank, concealed administrator-password field; no input or reveal",
    );
    await tabTo(page, totp, dialog);
    await expect(totp).toHaveValue("");
    await inView(dialog.getByText("管理员验证器验证码", { exact: true }));
    await tabTo(page, cancel, dialog);
    await tabTo(page, disable, dialog);
    // Retain exact target context in the accessible dialog. In short tasks the
    // initial identity may scroll out of the final frame: record that geometry
    // instead of calling an offscreen header visually present.
    await expect(dialog).toHaveAccessibleName(
      "管理 需要恢复访问的测试账号 的账号",
    );
    await expect(dialog).toHaveAccessibleDescription("登录名：synthetic-target");
    await capture(
      "final-decision",
      "Native Tab reached 停用账号 without activating it; initial target identity is captured separately, and this frame records whether it remains in view",
    );
    await inView(consequence);
    await inView(cancel);
    await inView(disable);
    await expect(action).toHaveText("停用账号");
    await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue("");
    await expect(password).toHaveValue("");
    await expect(password).toHaveAttribute("type", "password");
    await expect(totp).toHaveValue("");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    // Only Cancel is activated. Reaching the destructive button is not consent.
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await inView(cancel);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await settledTask(page.locator(".route-content"));
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
