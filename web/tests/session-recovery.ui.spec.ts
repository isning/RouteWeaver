import { test } from "./native-browser";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { randomBytes } from "node:crypto";
async function windowRoundTrip(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const eventStart = await page.evaluate(
    () => (window as any).__focusEvents.length,
  );
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe("hidden");
    const read = page.waitForResponse(me);
    await Promise.all([
      read.then((response) => expect(response.status()).toBe(200)),
      (async () => {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
        // Restoring a shared window restores its selected tab, which these
        // journeys changed to about:blank. Activate the app tab too; synthetic
        // DOM focus/visibility events cannot substitute for this native action.
        await page.bringToFront();
        await expect
          .poll(() =>
            page.evaluate(() => ({
              visible: document.visibilityState,
              focus: document.hasFocus(),
            })),
          )
          .toEqual({ visible: "visible", focus: true });
      })(),
    ]);
    const events = await page.evaluate(
      (start) => (window as any).__focusEvents.slice(start),
      eventStart,
    );
    expect(events.some((e: any) => e.type === "focus" && e.trusted)).toBe(true);
    expect(
      events.some(
        (e: any) =>
          e.type === "visibilitychange" && e.trusted && e.visible === "visible",
      ),
    ).toBe(true);
  } finally {
    await cdp.detach();
  }
}
async function realCollections(page: Page) {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/me/collections", {
      credentials: "same-origin",
    });
    return { ok: response.ok, records: await response.json() };
  });
  expect(result.ok).toBe(true);
  return result.records;
}
const account = (page: Page) =>
  page
    .getByRole("complementary")
    .getByRole("button", { name: /(?:管理员|个人账号)$/ });
const workspace = (page: Page) => page.locator("[data-session-workspace]");
const me = (r: any) =>
  r.url().endsWith("/api/auth/me") && r.request().method() === "GET";
const collectionWrite = (r: any) =>
  r.url().endsWith("/api/me/collections") && r.method() === "POST";
async function signIn(page: Page, navigate = true) {
  if (navigate) await page.goto("http://127.0.0.1:4173/");
  const login = page.getByRole("region", { name: "恢复登录" });
  await login.getByLabel("账号", { exact: true }).fill("routeweaver");
  await login.getByLabel("密码", { exact: true }).fill("local-demo-password");
  await login
    .getByRole("button", { name: "进入工作空间", exact: true })
    .click();
  await expect(account(page)).toBeVisible();
  await expect(workspace(page)).not.toHaveAttribute("inert", "");
}
async function logout(page: Page) {
  await account(page).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录 RouteWeaver", exact: true }),
  ).toBeVisible();
}
async function draftCollection(page: Page, value: string) {
  await page.goto("http://127.0.0.1:4173/#collections");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "新建集合", exact: true })
    .click();
  const field = page.getByLabel("集合名称", { exact: true });
  await field.fill(value);
  await field.focus();
  return field;
}
async function saveCollection(page: Page) {
  const result = page.waitForResponse((r) => collectionWrite(r.request()));
  await page.getByRole("button", { name: "保存集合", exact: true }).click();
  const response = await result;
  expect(response.ok()).toBe(true);
  return response;
}
async function evidence(info: TestInfo, value: object) {
  await info.attach("safe-result", {
    body: JSON.stringify(value),
    contentType: "application/json",
  });
}
const authObservations = new WeakMap<Page, object[]>();
let currentAuthObservations: object[] = [];
test.beforeEach(async ({ page, context }) => {
  currentAuthObservations = [];
  const monitor = (p: Page) => {
    const list: object[] = [];
    currentAuthObservations.push({ events: list });
    authObservations.set(p, list);
    p.on("request", (r) => {
      if (/\/api\/auth\/(me|logout|login)$/.test(r.url()))
        list.push({
          phase: "request",
          time: Date.now(),
          operation: r.url().split("/").pop(),
          method: r.method(),
        });
    });
    p.on("response", (r) => {
      if (/\/api\/auth\/(me|logout|login)$/.test(r.url()))
        list.push({
          phase: "response",
          time: Date.now(),
          operation: r.url().split("/").pop(),
          status: r.status(),
        });
    });
    p.on("requestfailed", (r) => {
      if (/\/api\/auth\/(me|logout|login)$/.test(r.url()))
        list.push({
          phase: "failed",
          time: Date.now(),
          operation: r.url().split("/").pop(),
        });
    });
  };
  monitor(page);
  context.on("page", monitor);
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.addInitScript(() => {
    (window as any).__focusEvents = [];
    for (const type of ["focus", "blur", "visibilitychange"])
      window.addEventListener(type, (e) =>
        (window as any).__focusEvents.push({
          type,
          trusted: e.isTrusted,
          visible: document.visibilityState,
          focus: document.hasFocus(),
        }),
      );
    (window as any).__sessionNotices = [];
    const channel = new BroadcastChannel("routeweaver-session");
    channel.onmessage = (e) => (window as any).__sessionNotices.push(e.data);
  });
});

test.afterEach(async ({ page, context }, info) => {
  await evidence(info, { authHTTP: currentAuthObservations });
  if (info.status !== info.expectedStatus) {
    const observations = [];
    for (const p of context.pages())
      if (!p.isClosed())
        observations.push({
          http: authObservations.get(p),
          ui: await p
            .evaluate(() => ({
              focus: (window as any).__focusEvents,
              headings: [...document.querySelectorAll("h1,h2,h3")].map(
                (x) => x.textContent,
              ),
              workspaceHidden: document
                .querySelector("[data-session-workspace]")
                ?.hasAttribute("hidden"),
              workspaceInert: document
                .querySelector("[data-session-workspace]")
                ?.hasAttribute("inert"),
              alerts: [
                ...document.querySelectorAll("[data-slot='alert-description']"),
              ].map((x) => x.textContent),
            }))
            .catch(() => ({ closed: true })),
        });
    await evidence(info, { failureObservations: observations });
  }
  if (!page.isClosed())
    await evidence(info, {
      focusDiagnostics: await page
        .evaluate(() => ({
          events: (window as any).__focusEvents,
          visible: document.visibilityState,
          focus: document.hasFocus(),
        }))
        .catch(() => ({ unavailable: true })),
    });
});

test("real cross-tab same-account renewal retains concealed Drawer draft and never auto-saves", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  const name = "日常连接";
  const field = await draftCollection(page, name);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (collectionWrite(r)) writes.push(r.method());
  });
  const other = await context.newPage();
  await other.goto("http://127.0.0.1:4173/");
  await expect(account(other)).toBeVisible();
  await logout(other);
  await expect(workspace(page)).toHaveAttribute("hidden", "");
  await expect(
    page.getByRole("heading", { name: "登录 RouteWeaver", exact: true }),
  ).toBeVisible();
  await expect(field).not.toBeVisible();
  expect(await field.inputValue()).toBe(name);
  expect(writes).toHaveLength(0);
  await signIn(other, false);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(name);
  await expect(workspace(page)).not.toHaveAttribute("inert", "");
  expect(writes).toHaveLength(0);
  await page.bringToFront();
  await expect(field).toBeFocused();
  const noticesSafe = await page.evaluate(
    () =>
      (window as any).__sessionNotices.length > 0 &&
      (window as any).__sessionNotices.every(
        (x: unknown) => x === "session-changed",
      ),
  );
  expect(noticesSafe).toBe(true);
  await page.screenshot({
    path: info.outputPath("same-account-draft-restored.png"),
  });
  await saveCollection(page);
  expect(writes).toHaveLength(1);
  await expect(
    page.getByRole("dialog", { name: "新建集合", exact: true }),
  ).not.toBeVisible();
  await evidence(info, {
    task: "same-account Drawer recovery",
    concealedWhileExpired: true,
    draftRetained: true,
    explicitSaves: 1,
    noAutomaticWrite: true,
    broadcastPayloadOnlyNotification: true,
    focusRestored: true,
  });
  await other.close();
});

test("real invite signup switches identity without inheriting old account draft or cache", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  const oldName = await account(page).innerText();
  await page.goto("http://127.0.0.1:4173/#users");
  await page.getByRole("button", { name: "邀请用户", exact: true }).click();
  const invite = page.getByRole("dialog", { name: "邀请用户", exact: true });
  await invite.getByLabel("受邀人名称", { exact: true }).fill("体验账号");
  await invite.getByRole("button", { name: "生成邀请", exact: true }).click();
  const invitation = await invite
    .getByLabel("邀请链接", { exact: true })
    .inputValue();
  await page.keyboard.press("Escape");
  await expect(invite).not.toBeVisible();
  const draftName = "未保存的连接";
  const field = await draftCollection(page, draftName);
  let writes = 0;
  page.on("request", (r) => {
    if (collectionWrite(r)) writes++;
  });
  const other = await context.newPage();
  await other.goto("http://127.0.0.1:4173/");
  await expect(account(other)).toBeVisible();
  await logout(other);
  await expect(workspace(page)).toHaveAttribute("hidden", "");
  await expect(field).not.toBeVisible();
  await other.goto(invitation);
  await other
    .getByLabel("账号", { exact: true })
    .fill(`session-b-${Date.now()}.test`);
  await other
    .getByLabel("密码", { exact: true })
    .fill(randomBytes(24).toString("base64url"));
  await other
    .getByRole("button", { name: "创建账号并继续", exact: true })
    .click();
  await expect(account(other)).toBeVisible();
  const newName = await account(other).innerText();
  expect(newName === oldName).toBe(false);
  await expect(account(page)).toHaveText(newName, { useInnerText: true });
  await expect(page.getByLabel("集合名称", { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
  const list = await realCollections(other);
  expect(list.some((x: any) => x.name === draftName)).toBe(false);
  // Only synthetic business screen, no invitation/password/auth fields captured.
  await page.screenshot({
    path: info.outputPath("different-account-clean-workspace.png"),
  });
  await evidence(info, {
    task: "cross-account binding",
    oldPrivatePortalRemoved: true,
    visibleIdentityMatchesB: true,
    oldDraftNotCreatedUnderB: true,
    noAutomaticWrite: true,
  });
  await other.close();
});

test("real file chooser and ordinary focus preserve a Modal draft without concealing the workspace", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  await page.goto("http://127.0.0.1:4173/#sources");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "添加来源", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "添加订阅来源", exact: true });
  const name = modal.getByLabel("来源名称", { exact: true });
  await name.fill("备用订阅");
  const nativeInput = modal.getByLabel("读取配置文件", { exact: true });
  await expect(nativeInput).toHaveCount(1);
  await expect(nativeInput).toBeHidden();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/me/sources")) posts++;
  });
  const chooser = page.waitForEvent("filechooser");
  await modal
    .getByRole("button", { name: "选择配置文件", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "synthetic-empty.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"proxies":[]}'),
  });
  await expect(
    modal.getByLabel("节点链接或配置内容", { exact: true }),
  ).toHaveValue('{"proxies":[]}');
  await expect(
    modal.getByText("已选择文件：synthetic-empty.json", { exact: true }),
  ).toBeVisible();
  const repeatedChooser = page.waitForEvent("filechooser");
  await modal
    .getByRole("button", { name: "选择配置文件", exact: true })
    .click();
  await (
    await repeatedChooser
  ).setFiles({
    name: "synthetic-empty.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"proxies": []}'),
  });
  await expect(
    modal.getByLabel("节点链接或配置内容", { exact: true }),
  ).toHaveValue('{"proxies": []}');
  await expect(nativeInput).toBeHidden();
  await name.focus();
  await name.evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 3));
  await page.evaluate(() => {
    const el = document.querySelector("[data-session-workspace]")!;
    (window as any).__concealedDuringRoutine = false;
    const observer = new MutationObserver(() => {
      if (el.hasAttribute("hidden"))
        (window as any).__concealedDuringRoutine = true;
    });
    observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
    (window as any).__concealObserver = observer;
  });
  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await windowRoundTrip(page);
  await expect(workspace(page)).not.toHaveAttribute("inert", "");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("备用订阅");
  expect(
    await name.evaluate((n: HTMLInputElement) => [
      n.selectionStart,
      n.selectionEnd,
    ]),
  ).toEqual([1, 3]);
  expect(
    await page.evaluate(() => (window as any).__concealedDuringRoutine),
  ).toBe(false);
  expect(posts).toBe(0);
  await other.goto("http://127.0.0.1:4173/");
  await expect(account(other)).toBeVisible();
  await logout(other);
  await expect(workspace(page)).toHaveAttribute("hidden", "");
  await expect(modal).not.toBeVisible();
  await signIn(other, false);
  await expect(modal).toBeVisible();
  await expect(name).toHaveValue("备用订阅");
  await expect(
    modal.getByLabel("节点链接或配置内容", { exact: true }),
  ).toHaveValue('{"proxies": []}');
  await expect(nativeInput).toBeHidden();
  await expect(
    modal.getByText("已选择文件：synthetic-empty.json", { exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  await expect(name).toBeFocused();
  expect(posts).toBe(0);
  await page.screenshot({
    path: info.outputPath("source-file-modal-after-routine-check.png"),
  });
  await evidence(info, {
    task: "file chooser and routine focus",
    realFileChooser: true,
    nativeInputHidden: true,
    sameFileNameReadTwice: true,
    secondContentAndFileNameRestored: true,
    localReadBeforeSubmission: true,
    noPost: true,
    noWholeWorkspaceConceal: true,
    focusAndSelectionPreserved: true,
    realLogoutConcealedModal: true,
    sameAccountRestoredModal: true,
  });
  await other.close();
});

test("already committed save survives same-session routine recheck and is not replayed", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  const name = `工作连接-${Date.now()}`;
  await draftCollection(page, name);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let committed!: () => void;
  const didCommit = new Promise<void>((resolve) => (committed = resolve));
  let writes = 0;
  await page.route("**/api/me/collections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    const actual = await route.fetch({
      headers: await route.request().allHeaders(),
    });
    // Delay only delivery of a real server response, never fabricate success.
    expect(actual.ok()).toBe(true);
    committed();
    await held;
    await route.fulfill({ response: actual });
  });
  try {
    await page.getByRole("button", { name: "保存集合", exact: true }).click();
    await didCommit;
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    await windowRoundTrip(page);
    await expect(workspace(page)).not.toHaveAttribute("inert", "");
    release();
    await expect(
      page.getByRole("dialog", { name: "新建集合", exact: true }),
    ).not.toBeVisible();
    expect(writes).toBe(1);
    const records = await realCollections(page);
    expect(records.filter((x: any) => x.name === name)).toHaveLength(1);
    await evidence(info, {
      task: "in-flight write and routine identity recheck",
      realServerCommitted: true,
      deliveryDelayControlled: true,
      acceptedExactlyOnce: true,
      writeCount: 1,
      noReplay: true,
    });
    await other.close();
  } finally {
    release?.();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
  }
});

test("offline interruption retains draft without queued write and reconnect requires an explicit save", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  const name = "备用连接";
  const field = await draftCollection(page, name);
  let writes = 0;
  page.on("request", (r) => {
    if (collectionWrite(r)) writes++;
  });
  await context.setOffline(true);
  await expect(workspace(page)).toHaveAttribute("hidden", "");
  await expect(
    page.getByRole("button", { name: "重新连接", exact: true }),
  ).toBeVisible();
  expect(await field.inputValue()).toBe(name);
  expect(writes).toBe(0);
  await context.setOffline(false);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(name);
  await expect(workspace(page)).not.toHaveAttribute("inert", "");
  expect(writes).toBe(0);
  await saveCollection(page);
  expect(writes).toBe(1);
  await evidence(info, {
    task: "offline/reconnect",
    concealedDraftRetained: true,
    noAutomaticWrite: true,
    explicitSaves: 1,
  });
});
