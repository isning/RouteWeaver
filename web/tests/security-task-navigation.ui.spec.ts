import { type Locator, type Page, type Route } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { navigateWorkspace } from "./ui-session";
import { settledTask } from "./ui-settled-task";

// Built App, ordinary Chromium, synthetic HTTP only. This is not backend MFA,
// credential, QR, session-rotation or server-side authorization acceptance.
// No tracing/body recording and no successful setup material in this fixture.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  serviceWorkers: "block",
});

async function tabTo(page: Page, target: Locator) {
  // Actual sequential keyboard navigation, not programmatic target.focus().
  for (let index = 0; index < 80; index++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Recovery action was not reachable by keyboard");
}

for (const width of [390, 1440]) {
  test(`MFA setup ownership survives route return and alternate entry at ${width}px`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    if (
      !baseURL ||
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
    )
      throw new Error("Controlled security navigation requires loopback");
    const origin = new URL(baseURL).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: {
          id: "synthetic-admin",
          name: "Synthetic admin",
          role: "admin",
          mfaEnabled: false,
        },
        csrfToken: "synthetic-csrf",
      },
      "/api/auth/sessions": [
        {
          id: "synthetic-session",
          current: false,
          expiresAt: "2027-01-01T00:00:00Z",
        },
      ],
      "/api/admin/accounts": [
        {
          id: "target",
          name: "Target",
          username: "target",
          role: "user",
          disabled: false,
          retired: false,
          mfaEnabled: false,
          passwordChangeRequired: false,
        },
      ],
      "/api/me/sources": [],
      "/api/me/notifications": [],
      "/api/settings": {},
      // The basic settings tab stays mounted behind the alternate MFA entry.
      "/api/admin/subscription-origin": {
        revision: 0,
        configuredRevision: 0,
        draftOrigin: "",
        effectiveRevision: 0,
        effectiveOrigin: "",
        defaultOrigin: "https://synthetic.example.invalid",
        verificationStatus: "not-required",
        currentLinkExample:
          "https://synthetic.example.invalid/feed/{existing-token}",
        proposedLinkExample:
          "https://synthetic.example.invalid/feed/{existing-token}",
        tokensUnchanged: true,
      },
      "/api/services": [],
      "/api/published-routes": [],
      "/api/state": {
        users: [],
        nodes: [],
        routes: [],
        revisions: [],
        capabilities: [],
      },
    };
    const writes: string[] = [],
      unexpected: string[] = [];
    let pending: Route | undefined;
    let meReads = 0;
    let setupBodyMatched = false;
    let heldRouteReleased = false;
    let failed = false;
    let phase = "initial";
    let pageErrorCount = 0;
    const captures: Array<{ name: string; body: Buffer }> = [];
    const geometryChecks: Array<{
      phase: string;
      noticeFits: boolean;
      actionsFit: boolean;
      documentFits: boolean;
    }> = [];
    page.on("pageerror", () => {
      pageErrorCount++;
    });
    const captureNotice = async (surface: Locator, label: string) => {
      await settledTask(surface);
      await surface.scrollIntoViewIfNeeded();
      captures.push({
        name: `security-${label}-viewport-${width}`,
        body: await page.screenshot({ mask: [page.locator("input")] }),
      });
      captures.push({
        name: `security-${label}-notice-${width}`,
        body: await surface.screenshot(),
      });
      const geometry = await surface.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const viewport = document.documentElement.clientWidth;
        return {
          noticeFits:
            node.scrollWidth <= node.clientWidth + 1 &&
            bounds.left >= 0 &&
            bounds.right <= viewport,
          actionsFit: Array.from(node.querySelectorAll("button")).every(
            (button) => {
              const action = button.getBoundingClientRect();
              return (
                button.scrollWidth <= button.clientWidth + 1 &&
                action.left >= bounds.left &&
                action.right <= bounds.right &&
                action.top >= bounds.top &&
                action.bottom <= bounds.bottom
              );
            },
          ),
          documentFits: document.documentElement.scrollWidth <= viewport + 1,
        };
      });
      geometryChecks.push({ phase: label, ...geometry });
      expect(geometry).toEqual({
        noticeFits: true,
        actionsFit: true,
        documentFits: true,
      });
    };
    // Context interception also covers new pages. Only same-origin static GETs
    // can reach the isolated server. Every API call and every write is handled.
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const method = request.method();
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort();
      }
      if (url.search || url.hash) {
        unexpected.push("request URL metadata rejected");
        return route.abort();
      }
      if (method !== "GET")
        writes.push(
          method === "POST" && url.pathname === "/api/auth/mfa/setup"
            ? "POST /api/auth/mfa/setup"
            : "unexpected write",
        );
      if (
        method === "POST" &&
        url.pathname === "/api/auth/mfa/setup" &&
        !pending
      ) {
        try {
          const body: unknown = request.postDataJSON();
          setupBodyMatched = Boolean(
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            Object.keys(body).length === 1 &&
            Object.hasOwn(body, "password") &&
            (body as { password?: unknown }).password === "synthetic-password",
          );
        } catch {
          setupBodyMatched = false;
        }
        if (!setupBodyMatched) {
          unexpected.push("setup body mismatch");
          return route.abort();
        }
        pending = route;
        return;
      }
      if (method === "GET" && Object.hasOwn(fixtures, url.pathname)) {
        if (url.pathname === "/api/auth/me") meReads++;
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      if (
        method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/favicon.ico" ||
          /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?)$/.test(url.pathname))
      )
        return route.continue();
      unexpected.push("unlisted request rejected");
      return route.fulfill({
        status: 503,
        json: { message: "Unexpected controlled request" },
      });
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#account-security");
      await page
        .getByLabel("验证当前账号密码", { exact: true })
        .fill("synthetic-password");
      await page
        .getByRole("button", { name: "设置二次验证", exact: true })
        .click();
      await expect.poll(() => writes).toEqual(["POST /api/auth/mfa/setup"]);
      expect(setupBodyMatched).toBe(true);
      phase = "pending";
      const notice = page
        .getByRole("alert")
        .filter({ has: page.getByText("正在提交安全操作", { exact: true }) });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("操作：设置二次验证");
      await expect(notice).toContainText("请勿直接重试");
      const blockedAccountActions = async () => {
        for (const name of [
          "设置二次验证",
          "修改密码",
          "退出其他所有会话",
          "退出此会话",
          "管理 Target",
        ])
          await expect(
            page.getByRole("button", { name, exact: true }),
          ).toBeDisabled();
      };
      await blockedAccountActions();
      await expect(
        page.getByRole("button", { name: "查看当前状态", exact: true }),
      ).toBeDisabled();
      await navigateWorkspace(page, "订阅来源");
      await expect(
        page.getByRole("heading", { name: "订阅来源", exact: true, level: 1 }),
      ).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/#account-security$/);
      await blockedAccountActions();
      await expect(
        page.getByLabel("验证当前账号密码", { exact: true }),
      ).toHaveValue("");
      await expect(notice).toBeVisible();
      await captureNotice(notice, "pending");

      await navigateWorkspace(page, "平台设置");
      await page.getByRole("tab", { name: "账号安全", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "设置二次验证", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "查看当前状态", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "已查看状态，关闭提醒", exact: true }),
      ).toHaveCount(0);
      expect(writes).toEqual(["POST /api/auth/mfa/setup"]);
      await navigateWorkspace(page, "账号安全");
      await blockedAccountActions();

      // Release only an unavailable response, never a secret/URI or an enable receipt.
      await pending!.fulfill({
        status: 503,
        json: { message: "Synthetic unavailable response" },
      });
      heldRouteReleased = true;
      phase = "unknown";
      const unknown = page.getByRole("alert").filter({
        has: page.getByText("安全操作结果尚未确认", { exact: true }),
      });
      await expect(unknown).toBeVisible();
      await blockedAccountActions();
      const inspect = page.getByRole("button", {
        name: "查看当前状态",
        exact: true,
      });
      await expect(inspect).toBeEnabled();
      await tabTo(page, inspect);
      await expect(inspect).toBeInViewport({ ratio: 1 });
      const before = meReads;
      await page.keyboard.press("Enter");
      await expect.poll(() => meReads).toBeGreaterThan(before);
      await expect(unknown).toContainText(
        "当前账号未启用二次验证。当前状态不能确认上次设置或启用操作是否结束。",
      );
      await expect(unknown).toContainText(
        "关闭提醒不会取消原操作，也不表示原操作失败",
      );
      await blockedAccountActions();
      await expect(page.getByLabel("验证器设置密钥")).toHaveCount(0);
      await expect(page.getByLabel("验证器验证码")).toHaveCount(0);
      await captureNotice(unknown, "unknown-inspected");
      // Screenshots are review evidence, not pixel-baseline or comprehension assertions.
      const dismiss = page.getByRole("button", {
        name: "已查看状态，关闭提醒",
        exact: true,
      });
      await tabTo(page, dismiss);
      await page.keyboard.press("Enter");
      const decision = page.getByRole("alertdialog", {
        name: "关闭未确认操作的提醒？",
        exact: true,
      });
      await settledTask(decision);
      await expect(decision).toContainText("再次提交可能重复执行");
      await tabTo(
        page,
        decision.getByRole("button", { name: "保留提醒", exact: true }),
      );
      await page.keyboard.press("Enter");
      await expect(decision).toHaveCount(0);
      await blockedAccountActions();
      await tabTo(page, dismiss);
      await page.keyboard.press("Enter");
      await settledTask(decision);
      await tabTo(
        page,
        decision.getByRole("button", { name: "关闭提醒", exact: true }),
      );
      await page.keyboard.press("Enter");
      await expect(decision).toHaveCount(0);
      await expect(unknown).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "设置二次验证", exact: true }),
      ).toBeEnabled();
      expect(writes).toEqual(["POST /api/auth/mfa/setup"]);
      expect(unexpected).toEqual([]);
      expect(pageErrorCount).toBe(0);
      phase = "completed";
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        try {
          if (failed && !page.isClosed()) {
            captures.push({
              name: `security-failure-${phase}-${width}`,
              body: await page.screenshot({ mask: [page.locator("input")] }),
            });
          }
          for (const capture of captures)
            await info.attach(capture.name, {
              contentType: "image/png",
              body: capture.body,
            });
        } finally {
          try {
            await info.attach("security-task-navigation-scope", {
              contentType: "application/json",
              body: JSON.stringify({
                width,
                writes,
                failed,
                phase,
                setupBodyMatched,
                unexpected,
                meReads,
                pageErrorCount,
                geometryChecks,
                scope:
                  "Built App with synthetic HTTP; no real MFA or session mutation; screenshots require visual review",
              }),
            });
          } finally {
            // Preserve diagnostics before releasing a route held at the failure point.
            if (pending && !heldRouteReleased) await pending.abort();
          }
        }
      } catch (diagnosticError) {
        // Keep the original assertion failure; evidence/cleanup errors must
        // still fail a journey whose behavior assertions otherwise passed.
        if (!failed) throw diagnosticError;
      }
    }
  });
}
