import { test, type BrowserContext, type Page } from "@playwright/test";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import {
  observeSetupAuth,
  persistSetupDiagnostic,
} from "./ui-session-diagnostics";

// Domain journeys share one legitimately established actor session per worker,
// while every journey keeps its own fresh browser context and UI/query state.
// Never persist cookies, use an admin-token shortcut, or retry rejected login.
// Auth lifecycle journeys deliberately do not use this helper.
let session:
  Promise<Awaited<ReturnType<BrowserContext["cookies"]>>> | undefined;

async function establishSession(page: Page) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  ) {
    throw new Error("Synthetic UI session setup requires a loopback demo URL.");
  }
  const browser = page.context().browser();
  if (!browser)
    throw new Error("Synthetic UI session setup requires a browser.");
  const setup = await browser.newContext({ baseURL });
  let observation: ReturnType<typeof observeSetupAuth> | undefined;
  try {
    const login = await setup.newPage();
    observation = observeSetupAuth(login);
    await login.goto("/");
    await login.getByLabel("账号", { exact: true }).fill("routeweaver");
    await login.getByLabel("密码", { exact: true }).fill("local-demo-password");
    await login
      .getByRole("button", { name: "进入工作空间", exact: true })
      .click();
    await waitForConfirmedWorkspace(login, "normal-ui-login");
    const cookies = (await setup.cookies(baseURL)).filter(
      (cookie) => cookie.name === "routeweaver_session",
    );
    if (cookies.length !== 1 || !cookies[0].value) {
      throw new Error(
        "Synthetic UI login did not establish the expected session.",
      );
    }
    return cookies;
  } finally {
    // Preserve the status evidence even when a failed worker's new login is
    // rejected. No credential, response body, cookie or URL is attached, and
    // diagnostic collection never retries the authentication operation.
    try {
      await persistSetupDiagnostic(test.info(), {
        kind: "http",
        phase: "normal-ui-login",
        events: observation?.stop() ?? [],
      });
    } finally {
      await setup.close();
    }
  }
}

export async function openWorkspace(page: Page) {
  // A failed worker gets a new normal login. Within this worker a failed setup
  // stays failed; it is not silently retried against the login rate limiter.
  const created = !session;
  session ??= establishSession(page);
  await page.context().addCookies(await session);
  await persistSetupDiagnostic(test.info(), {
    kind: "domain",
    worker: test.info().workerIndex,
    setup: created ? "normal-ui-login" : "reuse-valid-session",
  });
  const observation = observeSetupAuth(page);
  try {
    await page.goto("/");
    await waitForConfirmedWorkspace(page, "cold-workspace");
  } finally {
    await persistSetupDiagnostic(test.info(), {
      kind: "http",
      phase: "cold-workspace",
      events: observation.stop(),
    });
  }
}

/** Navigate through the visible sidebar, expanding its official Collapsible group. */
export async function navigateWorkspace(page: Page, name: string) {
  let nav = page.getByRole("navigation", { name: "工作空间导航", exact: true });
  if (!(await nav.isVisible()))
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const groups: Record<string, string> = {
    我的订阅: "订阅与分流",
    订阅来源: "订阅素材",
    节点集合: "订阅素材",
    规则资源: "订阅素材",
    模板与预设: "订阅素材",
    服务器: "网络资源",
    连接端点: "网络资源",
    线路: "网络资源",
    转发路径: "网络资源",
    用户: "用户与权限",
    服务方案: "用户与权限",
    执行任务: "运维与设置",
    变更记录: "运维与设置",
    公告与通知: "运维与设置",
    平台设置: "运维与设置",
    链路配置: "连接诊断",
  };
  const group = groups[name];
  if (group) {
    const trigger = nav.getByRole("button", { name: group, exact: true });
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
  }
  await nav.getByRole("button", { name, exact: true }).click();
}
