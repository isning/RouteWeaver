import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App + exact synthetic loopback HTTP. Invalid-field cases are GET-only.
// Rejection cases may arm one exact registration POST, fulfilled locally as 400.
// No API write is forwarded, and no diagnostic job can be created or executed.
// HTTP routing is not WebSocket or backend-enforcement evidence.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

type Mode = "invalid" | "rejection";
const csrf = "synthetic-target-registration-only";
const host = { id: "synthetic-target-host", name: "合成诊断服务器", address: "synthetic-host.example.test" };
const instance = { id: "synthetic-target-core", hostId: host.id, name: "合成核心", adapterId: "routeweaver/xray", version: "26.10.31" };
const targetName = "合成授权测试目标";
const targetURL = "https://probe.example.test/synthetic-target";
const invalidURL = "http://probe.example.test/synthetic-target";
const rejectionText = "合成保存请求已拒绝，目标尚未登记。";
const registrationPath = "/api/admin/diagnostic-targets";
const phases = ["invalid-name", "invalid-url", "invalid-methods", "save-rejected", "discard-review", "continued-draft", "reopened-clean", "returned-opener", "final-original"] as const;
type Phase = typeof phases[number];

function exactRegistration(request: Request) {
  try {
    const bytes = request.postDataBuffer();
    if (!bytes || bytes.length > 4096 ||
      request.headers()["content-type"]?.split(";")[0].trim() !== "application/json" ||
      request.headers()["x-csrf-token"] !== csrf) return false;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const draft = value as Record<string, unknown>;
    if (typeof draft.id !== "string" || !/^probe-target_[a-f0-9]{16}$/.test(draft.id)) return false;
    return isDeepStrictEqual({ ...draft, id: "generated-synthetic-id" }, {
      id: "generated-synthetic-id", nodeId: host.id, name: targetName, url: targetURL,
      methods: ["connectivity", "download"],
    });
  } catch { return false; }
}

async function fixture(page: Page, baseURL: string | undefined, mode: Mode) {
  const base = baseURL ? new URL(baseURL) : null;
  if (!base || !["http:", "https:"].includes(base.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Synthetic diagnostic target registration requires an exact loopback base");
  const origin = base.origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-target-admin", name: "合成管理员", role: "admin" }, csrfToken: csrf },
    "/api/hosts": [host], "/api/core-instances": [instance],
    "/api/managed-endpoints": [], "/api/links": [], "/api/server-deployments": [],
    [`/api/agent/instances/${instance.id}/state`]: { instanceId: instance.id, phase: "unregistered" },
    [`/api/admin/nodes/${host.id}/observability`]: { config: {} },
    [registrationPath]: [], "/api/admin/diagnostic-jobs": [], "/api/me/notifications": [],
  };
  const ledger = {
    mode, targetReads: 0, jobReads: 0, invalidSubmissions: 0, apiWriteAttempts: 0,
    registrationAttempts: 0, diagnosticWriteAttempts: 0, locallyRejectedRegistrations: 0,
    payloadChecks: [] as boolean[], discardReviews: 0, continuedDraft: false, reopenedClean: false,
    methodsCorrected: false, pageErrors: 0, rejected: [] as string[],
  };
  let armed = false, closed = false;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Fixed categories/counters only. Never retain URLs, bodies, headers,
      // cookies, query values, credentials or arbitrary page error messages.
      ledger.rejected.push(reason);
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.username || url.password || url.hash)
      return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
        (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      if (method === "GET" && staticPath && staticQuery) return route.continue();
      return reject("unexpected static request");
    }
    if (method !== "GET") {
      ledger.apiWriteAttempts++;
      if (url.pathname === registrationPath) ledger.registrationAttempts++;
      if (url.pathname.startsWith("/api/admin/diagnostic-jobs")) ledger.diagnosticWriteAttempts++;
      if (mode === "rejection" && method === "POST" && url.pathname === registrationPath && !url.search) {
        const valid = exactRegistration(request);
        ledger.payloadChecks.push(valid);
        if (!valid || !armed || closed || ledger.locallyRejectedRegistrations !== 0)
          return reject("unexpected or mismatched synthetic registration");
        armed = false;
        ledger.locallyRejectedRegistrations++;
        return route.fulfill({ status: 400, json: { error: rejectionText } });
      }
      return reject("API mutation attempt");
    }
    if (url.search) return reject("API query metadata");
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === registrationPath) ledger.targetReads++;
    if (url.pathname === "/api/admin/diagnostic-jobs") ledger.jobReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return {
    ledger,
    armRegistration() {
      if (mode !== "rejection" || armed || closed || ledger.locallyRejectedRegistrations !== 0)
        throw new Error("Synthetic registration may be armed exactly once in a rejection case");
      armed = true;
    },
    close() { closed = true; armed = false; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function tabTo(page: Page, scope: Locator, target: Locator) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    const backwards = await target.evaluate((node) => !!(
      document.activeElement?.compareDocumentPosition(node)! & Node.DOCUMENT_POSITION_PRECEDING));
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(await scope.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  throw new Error("Diagnostic registration control was not reachable by ordinary keyboard traversal");
}

async function typeField(page: Page, editor: Locator, field: Locator, value: string) {
  await tabTo(page, editor, field);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(value);
}

async function capture(page: Page, info: TestInfo, phase: Phase, surface: Locator,
  target?: Locator, expectedValue?: string, settle = true) {
  const failures: unknown[] = [];
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch (error) { settlingFailed = true; failures.push(error); }
  // Capture original current-viewport pixels before geometry assertions. No
  // forced scrolling, script focus, motion override or overlay removal.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`${phase}.png`), fullPage: false, scale: "css", mask: [
      page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [autocomplete="one-time-code"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] });
    await info.attach(`${phase}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  let geometry: Record<string, number | boolean | null> | null = null;
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, focusedTag: document.activeElement?.tagName || null }));
    const count = target ? await target.count() : 0;
    geometry = target && count === 1 ? await target.evaluate((node, expected) => {
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
        hit: hit === node || node.contains(hit), invalid: node.getAttribute("aria-invalid") === "true",
        inputMatches: expected !== undefined && node instanceof HTMLInputElement ? node.value === expected : null };
    }, expectedValue) : null;
    const body = JSON.stringify({ viewport, geometry, count, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`${phase}.json`), body);
    await info.attach(`${phase}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Diagnostic registration original capture or geometry failed");
  return geometry;
}

async function openRegistration(page: Page) {
  await page.goto("/#servers");
  await page.getByRole("button", { name: host.name, exact: true }).click();
  const workspace = page.getByRole("region", { name: host.name, exact: true });
  await workspace.getByRole("tab", { name: "诊断", exact: true }).click();
  await workspace.getByRole("tab", { name: "连接诊断", exact: true }).click();
  const opener = workspace.getByRole("button", { name: "登记测试目标", exact: true });
  await opener.click();
  const editor = page.getByRole("dialog", { name: "登记授权测试目标", exact: true });
  await settledTask(editor);
  return { opener, editor };
}

async function assertDraft(editor: Locator, mode: Mode) {
  await expect(editor.getByRole("textbox", { name: "目标名称", exact: true })).toHaveValue(targetName);
  await expect(editor.getByRole("textbox", { name: "HTTPS 测试地址", exact: true })).toHaveValue(targetURL);
  await expect(editor.getByRole("checkbox", { name: "HEAD 连通性", exact: true })).toBeChecked();
  if (mode === "rejection") await expect(editor.getByRole("checkbox", { name: "Range 下载", exact: true })).toBeChecked();
  else await expect(editor.getByRole("checkbox", { name: "Range 下载", exact: true })).not.toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "PUT 上传（可能覆盖目标内容）", exact: true })).not.toBeChecked();
}

async function discardAndReopen(page: Page, info: TestInfo, f: Fixture, editor: Locator, opener: Locator, mode: Mode) {
  const cancel = editor.getByRole("button", { name: "取消", exact: true });
  const decision = page.getByRole("alertdialog", { name: "放弃未保存的测试目标？", exact: true });
  const keep = decision.getByRole("button", { name: "继续编辑", exact: true });
  await tabTo(page, editor, cancel); await page.keyboard.press("Enter");
  f.ledger.discardReviews++;
  const review = await capture(page, info, "discard-review", decision, keep);
  expect(review).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
  await page.keyboard.press("Enter");
  await expect(decision).toHaveCount(0);
  await assertDraft(editor, mode);
  const continued = await capture(page, info, "continued-draft", editor, cancel);
  expect(continued).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
  f.ledger.continuedDraft = true;
  await page.keyboard.press("Enter");
  await expect(decision).toBeVisible();
  f.ledger.discardReviews++;
  await tabTo(page, decision, decision.getByRole("button", { name: "放弃修改", exact: true }));
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await settledTask(editor);
  const name = editor.getByRole("textbox", { name: "目标名称", exact: true });
  await expect(name).toHaveValue("");
  await expect(editor.getByRole("textbox", { name: "HTTPS 测试地址", exact: true })).toHaveValue("");
  await expect(editor.getByRole("checkbox", { name: "HEAD 连通性", exact: true })).toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "Range 下载", exact: true })).not.toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "PUT 上传（可能覆盖目标内容）", exact: true })).not.toBeChecked();
  await expect(editor.getByText(rejectionText, { exact: true })).toHaveCount(0);
  await tabTo(page, editor, name);
  const reopened = await capture(page, info, "reopened-clean", editor, name, "");
  expect(reopened).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true, invalid: false });
  f.ledger.reopenedClean = true;
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(decision).toHaveCount(0);
  await expect(opener).toBeFocused();
  const returned = await capture(page, info, "returned-opener", page.locator("main"), opener);
  expect(returned).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
}

for (const width of [390, 1440]) for (const mode of ["invalid", "rejection"] as const) {
  test(`diagnostic target ${mode} recovers keyboard focus and draft at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 640 });
    const f = await fixture(page, baseURL, mode), failures: unknown[] = [];
    try {
      const { opener, editor } = await openRegistration(page);
      const name = editor.getByRole("textbox", { name: "目标名称", exact: true });
      const url = editor.getByRole("textbox", { name: "HTTPS 测试地址", exact: true });
      const save = editor.getByRole("button", { name: "保存测试目标", exact: true });
      const connectivity = editor.getByRole("checkbox", { name: "HEAD 连通性", exact: true });
      await typeField(page, editor, url, targetURL);
      if (mode === "invalid") {
        await tabTo(page, editor, save); f.ledger.invalidSubmissions++;
        await page.keyboard.press("Enter");
        await expect(name).toHaveAttribute("aria-invalid", "true");
        const nameError = await capture(page, info, "invalid-name", editor, name, "");
        expect(nameError).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, invalid: true, inputMatches: true });
        expect(f.ledger.apiWriteAttempts).toBe(0);
        await expect(url).toHaveValue(targetURL);
        await typeField(page, editor, name, targetName);
        await typeField(page, editor, url, invalidURL);
        await tabTo(page, editor, save); f.ledger.invalidSubmissions++;
        await page.keyboard.press("Enter");
        await expect(url).toHaveAttribute("aria-invalid", "true");
        const urlError = await capture(page, info, "invalid-url", editor, url, invalidURL);
        expect(urlError).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, invalid: true, inputMatches: true });
        expect(f.ledger.apiWriteAttempts).toBe(0);
        await expect(name).toHaveValue(targetName);
        await typeField(page, editor, url, targetURL);
        await tabTo(page, editor, connectivity); await page.keyboard.press("Space");
        await tabTo(page, editor, save); f.ledger.invalidSubmissions++;
        await page.keyboard.press("Enter");
        await expect(connectivity).toHaveAttribute("aria-invalid", "true");
        const error = editor.getByText("请填写目标支持的测试", { exact: true });
        await expect(error).toBeVisible();
        const errorId = await error.getAttribute("id");
        expect(errorId).toBeTruthy();
        await expect(connectivity).toHaveAttribute("aria-describedby", errorId!);
        await expect(editor.getByRole("group", { name: "目标支持的测试", exact: true })).toBeVisible();
        const methodsError = await capture(page, info, "invalid-methods", editor, connectivity);
        expect(methodsError).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, invalid: true });
        expect(f.ledger.apiWriteAttempts).toBe(0);
        await page.keyboard.press("Space");
        await expect(connectivity).toBeChecked();
        await expect(error).toHaveCount(0);
        f.ledger.methodsCorrected = true;
      } else {
        await typeField(page, editor, name, targetName);
        await tabTo(page, editor, editor.getByRole("checkbox", { name: "Range 下载", exact: true }));
        await page.keyboard.press("Space");
        await tabTo(page, editor, save);
        f.armRegistration();
        await page.keyboard.press("Enter");
        await expect(editor.getByText(rejectionText, { exact: true })).toBeVisible();
        await assertDraft(editor, mode);
        await expect(save).toBeEnabled();
        expect(f.ledger.apiWriteAttempts).toBe(1);
        expect(f.ledger.locallyRejectedRegistrations).toBe(1);
        // Keyboard return after the rejection is explicit; this is not a claim
        // that the server-error banner automatically moves or restores focus.
        await tabTo(page, editor, name);
        const rejected = await capture(page, info, "save-rejected", editor, name, targetName);
        expect(rejected).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
      }
      await assertDraft(editor, mode);
      await discardAndReopen(page, info, f, editor, opener, mode);
    } catch (error) { failures.push(error); }
    finally {
      f.close();
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); }
      catch (error) { failures.push(error); }
      // Preserve the sanitized ledger independently of screenshot/assertion failure.
      try {
        const body = JSON.stringify({ width, ...f.ledger,
          scope: "Synthetic App target-registration focus/draft; no forwarded API writes, diagnostic execution, backend, WebSocket or full accessibility acceptance" }, null, 2);
        await writeFile(info.outputPath("request-ledger.json"), body);
        await info.attach("diagnostic-target-request-ledger", { body, contentType: "application/json" });
        expect(f.ledger.rejected).toEqual([]);
        expect(f.ledger.pageErrors).toBe(0);
        expect(f.ledger.diagnosticWriteAttempts).toBe(0);
        expect(f.ledger.invalidSubmissions).toBe(mode === "invalid" ? 3 : 0);
        expect(f.ledger.apiWriteAttempts).toBe(mode === "rejection" ? 1 : 0);
        expect(f.ledger.registrationAttempts).toBe(mode === "rejection" ? 1 : 0);
        expect(f.ledger.locallyRejectedRegistrations).toBe(mode === "rejection" ? 1 : 0);
        expect(f.ledger.payloadChecks).toEqual(mode === "rejection" ? [true] : []);
        expect(f.ledger.methodsCorrected).toBe(mode === "invalid");
        expect(f.ledger.discardReviews).toBe(2);
        expect(f.ledger.continuedDraft).toBe(true);
        expect(f.ledger.reopenedClean).toBe(true);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Diagnostic target keyboard task or evidence failed");
  });
}
